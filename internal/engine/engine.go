package engine

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"

	"zonehandoff/internal/wal"
)

// InitialEntity seeds an empty journal. The same baseline must be supplied on
// every restart so replay always starts from identical state.
type InitialEntity struct {
	ID    string `json:"id"`
	Zone  string `json:"zone"`
	Value int64  `json:"value"`
}

// RecoveryInfo summarizes what startup found in the journal.
type RecoveryInfo struct {
	Frames       int   `json:"frames"`
	Entities     int   `json:"entities"`
	Truncated    int64 `json:"truncated_bytes"`
	TornTail     bool  `json:"torn_tail"`
	JournalBytes int64 `json:"journal_bytes"`
}

// Engine is the state machine.
//
// Writes are serialized under mu: state changes are applied to the live view,
// queued to the journal and acknowledged only after fsync. Reads are answered
// from a second view (published) that only contains records already fsynced, so
// a client can never observe a state that a crash would erase.
type Engine struct {
	mu sync.Mutex

	live *state
	pub  *state
	pubN int

	w      *wal.Writer
	failed error

	crashOp string
	onCrash func(string)
}

type entity struct {
	ID     string
	Zone   string
	Epoch  uint64
	Seq    uint64
	Value  int64
	Frozen bool
	Move   string
}

type move struct {
	ID     string
	Entity string
	From   string
	To     string
	Status string // begun | confirmed | committed | aborted
	bodies map[string][]byte
	after  map[string]uint64
}

type actionKey struct {
	ID  string
	Seq uint64
}

type actionEntry struct {
	Delta int64
	Body  []byte
	After uint64 // writer seq that must be durable before replying
}

// Open replays the journal at path over baseline and opens it for appending.
func Open(path string, baseline []InitialEntity) (*Engine, RecoveryInfo, error) {
	e := &Engine{live: newState()}
	for _, b := range baseline {
		en := &entity{ID: b.ID, Zone: b.Zone, Value: b.Value}
		e.live.entities[b.ID] = en
	}

	res, err := wal.Replay(path, func(payload []byte, off int64) error {
		var rec Record
		if err := json.Unmarshal(payload, &rec); err != nil {
			return fmt.Errorf("engine: decode record at offset %d: %w", off, err)
		}
		e.live.applyRecord(&rec)
		return nil
	})
	if err != nil {
		return nil, RecoveryInfo{}, err
	}

	w, err := wal.NewWriter(path, wal.PathSize(path))
	if err != nil {
		return nil, RecoveryInfo{}, err
	}
	e.w = w
	e.pub = e.live.clone()
	e.pubN = len(e.live.log)

	info := RecoveryInfo{
		Frames:       res.Frames,
		Entities:     len(e.live.entities),
		Truncated:    res.Truncated,
		TornTail:     res.TornFrame,
		JournalBytes: w.Size(),
	}
	return e, info, nil
}

func moveKey(entityID, moveID string) string { return entityID + "\x00" + moveID }

// advancePubLocked applies every newly durable record to the published view.
// The caller must hold mu.
func (e *Engine) advancePubLocked() {
	if e.w == nil {
		return
	}
	durable := e.w.Durable()
	for e.pubN < len(e.live.log) {
		rec := &e.live.log[e.pubN]
		if rec.WS != 0 && rec.WS > durable {
			break
		}
		e.pub.applyRecord(rec)
		e.pubN++
	}
}

// SetCrashPoint arms a one-shot simulated crash for op ("action", "begin",
// "confirm", "commit" or "abort"). Empty disables it.
func (e *Engine) SetCrashPoint(op string) {
	e.mu.Lock()
	e.crashOp = op
	e.mu.Unlock()
}

// CrashPoint reports the currently armed simulated crash.
func (e *Engine) CrashPoint() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.crashOp
}

// SetCrashHook installs the callback invoked once an armed crash fires. It runs
// after fsync and before any reply, so the process may exit there.
func (e *Engine) SetCrashHook(fn func(string)) {
	e.mu.Lock()
	e.onCrash = fn
	e.mu.Unlock()
}

// Close flushes and closes the journal.
func (e *Engine) Close() error {
	e.mu.Lock()
	w := e.w
	e.w = nil
	e.mu.Unlock()
	if w == nil {
		return nil
	}
	return w.Close()
}

// Failed reports a fatal journal error; once set the engine refuses new work.
func (e *Engine) Failed() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.failed
}

// Apply dispatches one client operation. crash is true when a simulated crash
// must terminate the process after the frames become durable.
func (e *Engine) Apply(req Req) (reply json.RawMessage, crash bool, err error) {
	switch req.Op {
	case "action":
		return e.doAction(req)
	case "begin", "confirm", "commit", "abort":
		return e.doMove(req)
	case "batch":
		return e.doBatch(req)
	default:
		return nil, false, errBadRequest("unknown op " + req.Op)
	}
}

// writeLocked submits recs as one journal write, then applies them to the live
// view stamped with that write's sequence. Records in one call become durable
// together, so they share the sequence and are published atomically.
func (e *Engine) writeLocked(recs []Record) (uint64, error) {
	seq, err := e.submitLocked(recs)
	if err != nil {
		return 0, err
	}
	for i := range recs {
		recs[i].WS = seq
		e.live.applyRecord(&recs[i])
	}
	// Everything written in this call becomes durable at seq, so retries must
	// not answer before it is fsynced.
	for i := range recs {
		if d := e.live.dedup[actionKey{recs[i].ID, recs[i].Seq}]; d != nil && d.After < seq {
			d.After = seq
		}
		if recs[i].Move != "" {
			if m := e.live.moves[moveKey(recs[i].ID, recs[i].Move)]; m != nil {
				m.after[recs[i].Op] = seq
			}
		}
	}
	return seq, nil
}

// submitLocked encodes records (replies already set) and queues them as one
// journal write without applying them to the live view.
func (e *Engine) submitLocked(recs []Record) (uint64, error) {
	frames := make([][]byte, 0, len(recs))
	ts := nowMillis()
	for i := range recs {
		recs[i].TS = ts
		frame, err := json.Marshal(recs[i])
		if err != nil {
			return 0, errInternal("encode record: " + err.Error())
		}
		frames = append(frames, frame)
	}
	seq, err := e.w.Submit(frames)
	if err != nil {
		e.failed = err
		return 0, errInternal("journal write: " + err.Error())
	}
	return seq, nil
}

// settle waits until waitSeq is durable and, when crashable, fires an armed
// crash for op. Callers must not write any response before it returns.
func (e *Engine) settle(op string, waitSeq uint64, crashable bool) (bool, error) {
	if err := e.waitDurable(waitSeq); err != nil {
		return false, err
	}
	if !crashable {
		return false, nil
	}
	e.mu.Lock()
	crash := e.crashOp == op
	if crash {
		e.crashOp = ""
	}
	hook := e.onCrash
	e.mu.Unlock()
	if crash {
		if hook != nil {
			hook(op)
		}
		return true, nil
	}
	return false, nil
}

// waitDurable blocks until seq is fsynced (or seq is 0) and records journal
// failures.
func (e *Engine) waitDurable(seq uint64) error {
	if seq == 0 {
		return nil
	}
	e.mu.Lock()
	w := e.w
	e.mu.Unlock()
	if w == nil {
		return errInternal("journal closed")
	}
	if err := w.Wait(seq); err != nil {
		e.mu.Lock()
		e.failed = err
		e.advancePubLocked()
		e.mu.Unlock()
		return errInternal("journal fsync: " + err.Error())
	}
	e.mu.Lock()
	e.advancePubLocked()
	e.mu.Unlock()
	return nil
}

// Snapshot returns the durable view of one entity.
func (e *Engine) Snapshot(id string) (Snapshot, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.advancePubLocked()
	en := e.pub.entities[id]
	if en == nil {
		return Snapshot{}, false
	}
	return snapshotOf(en), true
}

// Entities returns every entity in the durable view, sorted by id.
func (e *Engine) Entities() []Snapshot {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.advancePubLocked()
	out := make([]Snapshot, 0, len(e.pub.entities))
	for _, en := range e.pub.entities {
		out = append(out, snapshotOf(en))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Moves returns every handoff in the durable view, sorted by entity then id.
func (e *Engine) Moves() []MoveView {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.advancePubLocked()
	out := make([]MoveView, 0, len(e.pub.moves))
	for _, m := range e.pub.moves {
		out = append(out, e.pub.moveView(m))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Entity != out[j].Entity {
			return out[i].Entity < out[j].Entity
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// LoggedRecord pairs a record with its position in the journal.
type LoggedRecord struct {
	Index  int    `json:"index"`
	Record Record `json:"record"`
}

// LogPage returns durable journal records from index from, at most limit.
// limit <= 0 means "to the end".
func (e *Engine) LogPage(from, limit int) ([]LoggedRecord, int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.advancePubLocked()
	total := len(e.pub.log)
	if from < 0 {
		from = 0
	}
	if from > total {
		from = total
	}
	end := total
	if limit > 0 && from+limit < end {
		end = from + limit
	}
	out := make([]LoggedRecord, 0, end-from)
	for i := from; i < end; i++ {
		out = append(out, LoggedRecord{Index: i, Record: e.pub.log[i]})
	}
	return out, total
}

// LogCount reports how many records are durable.
func (e *Engine) LogCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.advancePubLocked()
	return len(e.pub.log)
}

// JournalSize reports the durable journal byte size.
func (e *Engine) JournalSize() int64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.w == nil {
		return 0
	}
	return e.w.Size()
}
