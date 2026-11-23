package engine

// state is one complete view of the machine: entities, handoffs, dedup
// entries and the journal records that produced them.
type state struct {
	entities map[string]*entity
	moves    map[string]*move
	dedup    map[actionKey]*actionEntry
	log      []Record
	// seqs[i] is the journal writer sequence of log[i]; 0 means "already
	// durable when loaded at startup".
	seqs []uint64
}

func newState() *state {
	return &state{
		entities: make(map[string]*entity),
		moves:    make(map[string]*move),
		dedup:    make(map[actionKey]*actionEntry),
	}
}

func (s *state) clone() *state {
	c := &state{
		entities: make(map[string]*entity, len(s.entities)),
		moves:    make(map[string]*move, len(s.moves)),
		dedup:    make(map[actionKey]*actionEntry, len(s.dedup)),
		log:      append([]Record(nil), s.log...),
		seqs:     append([]uint64(nil), s.seqs...),
	}
	for id, en := range s.entities {
		cp := *en
		c.entities[id] = &cp
	}
	for k, m := range s.moves {
		cm := *m
		cm.bodies = make(map[string][]byte, len(m.bodies))
		for op, b := range m.bodies {
			cm.bodies[op] = append([]byte(nil), b...)
		}
		cm.after = make(map[string]uint64, len(m.after))
		for op, sq := range m.after {
			cm.after[op] = sq
		}
		c.moves[k] = &cm
	}
	for k, d := range s.dedup {
		cd := *d
		c.dedup[k] = &cd
	}
	return c
}

// applyRecord mutates s from one journal record. Replay (startup) and live
// writes share this path, so a restart reconstructs exactly the live view.
func (s *state) applyRecord(rec *Record) {
	s.log = append(s.log, *rec)
	s.seqs = append(s.seqs, rec.WS)

	en := s.entities[rec.ID]
	if en == nil {
		en = &entity{ID: rec.ID}
		s.entities[rec.ID] = en
	}
	en.Zone = rec.Zone
	en.Epoch = rec.Epoch
	en.Seq = rec.Seq
	en.Value = rec.Value

	switch rec.Op {
	case "action":
		en.Frozen = false
		en.Move = ""
		s.dedup[actionKey{rec.ID, rec.Seq}] = &actionEntry{Delta: rec.Delta, Body: rec.Resp}
	case "begin":
		en.Frozen = true
		en.Move = rec.Move
		m := s.moves[moveKey(rec.ID, rec.Move)]
		if m == nil {
			m = &move{ID: rec.Move, Entity: rec.ID,
				bodies: map[string][]byte{}, after: map[string]uint64{}}
			s.moves[moveKey(rec.ID, rec.Move)] = m
		}
		m.From, m.To, m.Status = rec.From, rec.To, "begun"
		m.bodies["begin"] = rec.Resp
	case "confirm":
		en.Frozen = true
		en.Move = rec.Move
		if m := s.moves[moveKey(rec.ID, rec.Move)]; m != nil {
			m.Status = "confirmed"
			m.bodies["confirm"] = rec.Resp
		}
	case "commit":
		en.Frozen = false
		en.Move = ""
		if m := s.moves[moveKey(rec.ID, rec.Move)]; m != nil {
			m.Status = "committed"
			m.bodies["commit"] = rec.Resp
		}
	case "abort":
		en.Frozen = false
		en.Move = ""
		if m := s.moves[moveKey(rec.ID, rec.Move)]; m != nil {
			m.Status = "aborted"
			m.bodies["abort"] = rec.Resp
		}
	}
}

func snapshotOf(en *entity) Snapshot {
	return Snapshot{ID: en.ID, Zone: en.Zone, Epoch: en.Epoch, Seq: en.Seq,
		Value: en.Value, Frozen: en.Frozen, Move: en.Move}
}

// actionView is the read side planActionOn needs. Both the live state and a
// batch overlay implement it.
type actionView interface {
	entity(id string) (*entity, bool)
	dedupEntry(key actionKey) *actionEntry
}

func (s *state) entity(id string) (*entity, bool) {
	en, ok := s.entities[id]
	return en, ok
}

func (s *state) dedupEntry(key actionKey) *actionEntry { return s.dedup[key] }

// overlay layers a batch's speculative writes over the live state so items are
// validated against earlier items without copying the whole journal.
type overlay struct {
	base  *state
	ents  map[string]*entity
	dedup map[actionKey]*actionEntry
}

func newOverlay(base *state) *overlay {
	return &overlay{base: base, ents: make(map[string]*entity), dedup: make(map[actionKey]*actionEntry)}
}

func (o *overlay) entity(id string) (*entity, bool) {
	if en, ok := o.ents[id]; ok {
		return en, true
	}
	en, ok := o.base.entities[id]
	return en, ok
}

func (o *overlay) dedupEntry(key actionKey) *actionEntry {
	if d, ok := o.dedup[key]; ok {
		return d
	}
	return o.base.dedup[key]
}

// stage records an accepted action's effect in the overlay.
func (o *overlay) stage(rec *Record, body []byte) {
	en, ok := o.ents[rec.ID]
	if !ok {
		live := o.base.entities[rec.ID]
		cp := *live
		en = &cp
	}
	en.Zone, en.Epoch, en.Seq, en.Value = rec.Zone, rec.Epoch, rec.Seq, rec.Value
	en.Frozen, en.Move = false, ""
	o.ents[rec.ID] = en
	o.dedup[actionKey{rec.ID, rec.Seq}] = &actionEntry{Delta: rec.Delta, Body: body}
}

func (s *state) moveView(m *move) MoveView {
	return MoveView{ID: m.ID, Entity: m.Entity, From: m.From, To: m.To, Status: m.Status}
}
