package engine

import (
	"encoding/json"
	"fmt"
)

// doMove implements begin/confirm/commit/abort.
//
// A step that already has a durable reply for this move id returns that exact
// reply, even if the move has since finished; this is what makes retries after
// a crash safe. Only steps that were never recorded are evaluated against the
// move's current status. A terminal move id can never start over: its begin is
// already recorded, so a begin with a different target is a conflict.
func (e *Engine) doMove(req Req) (json.RawMessage, bool, error) {
	if req.ID == "" || req.Move == "" {
		return nil, false, errBadRequest("id and move are required")
	}
	e.mu.Lock()
	if e.failed != nil {
		e.mu.Unlock()
		return nil, false, errInternal("journal unavailable")
	}
	en := e.live.entities[req.ID]
	if en == nil {
		e.mu.Unlock()
		return nil, false, errNotFound("entity " + req.ID + " not found")
	}
	m := e.live.moves[moveKey(req.ID, req.Move)]

	if m != nil {
		if body, ok := m.bodies[req.Op]; ok {
			if req.Op == "begin" && req.To != m.To {
				e.mu.Unlock()
				return nil, false, errConflict("move_conflict",
					fmt.Sprintf("move %s already began toward %s, not %q", req.Move, m.To, req.To))
			}
			after := m.after[req.Op]
			e.mu.Unlock()
			return body, false, e.waitDurable(after)
		}
	}

	rec, reply, verr := planMove(req, en, m)
	if verr != nil {
		e.mu.Unlock()
		return nil, false, verr
	}
	body, err := marshal(reply)
	if err != nil {
		e.mu.Unlock()
		return nil, false, errInternal("encode reply: " + err.Error())
	}
	rec.Resp = body
	seq, err := e.writeLocked([]Record{rec})
	if err != nil {
		e.mu.Unlock()
		return nil, false, err
	}
	e.mu.Unlock()

	crash, err := e.settle(req.Op, seq, true)
	return body, crash, err
}

// planMove validates one move step and returns the record to journal plus its
// reply. It never mutates state.
func planMove(req Req, en *entity, m *move) (Record, StepReply, *Error) {
	switch req.Op {
	case "begin":
		// m != nil would mean a begin was already recorded and returned above.
		if req.To == "" {
			return Record{}, StepReply{}, errBadRequest("to is required for begin")
		}
		if req.To == en.Zone {
			return Record{}, StepReply{}, errBadRequest("target zone equals current zone")
		}
		if en.Frozen {
			return Record{}, StepReply{}, errConflict("move_in_progress",
				"entity already has handoff "+en.Move+" in progress")
		}
		rec := Record{Op: "begin", ID: en.ID, Move: req.Move, From: en.Zone, To: req.To,
			Zone: en.Zone, Epoch: en.Epoch, Seq: en.Seq, Value: en.Value}
		reply := StepReply{Op: "begin",
			Entity: Snapshot{ID: en.ID, Zone: en.Zone, Epoch: en.Epoch, Seq: en.Seq,
				Value: en.Value, Frozen: true, Move: req.Move},
			Move: MoveView{ID: req.Move, Entity: en.ID, From: en.Zone, To: req.To, Status: "begun"}}
		return rec, reply, nil

	case "confirm":
		if m == nil {
			return Record{}, StepReply{}, errNotFound("move " + req.Move + " not found")
		}
		if m.Status == "committed" || m.Status == "aborted" {
			return Record{}, StepReply{}, errConflict("move_terminal", "move "+req.Move+" already finished as "+m.Status)
		}
		rec := Record{Op: "confirm", ID: en.ID, Move: m.ID, From: m.From, To: m.To,
			Zone: en.Zone, Epoch: en.Epoch, Seq: en.Seq, Value: en.Value}
		reply := StepReply{Op: "confirm",
			Entity: Snapshot{ID: en.ID, Zone: en.Zone, Epoch: en.Epoch, Seq: en.Seq,
				Value: en.Value, Frozen: true, Move: m.ID},
			Move: MoveView{ID: m.ID, Entity: en.ID, From: m.From, To: m.To, Status: "confirmed"}}
		return rec, reply, nil

	case "commit":
		if m == nil {
			return Record{}, StepReply{}, errNotFound("move " + req.Move + " not found")
		}
		if m.Status == "committed" || m.Status == "aborted" {
			return Record{}, StepReply{}, errConflict("move_terminal", "move "+req.Move+" already finished as "+m.Status)
		}
		if m.Status != "confirmed" {
			return Record{}, StepReply{}, errConflict("move_not_confirmed",
				"target zone has not confirmed move "+req.Move)
		}
		// Commit hands ownership to the target zone and bumps the epoch.
		rec := Record{Op: "commit", ID: en.ID, Move: m.ID, From: m.From, To: m.To,
			Zone: m.To, Epoch: en.Epoch + 1, Seq: en.Seq, Value: en.Value}
		reply := StepReply{Op: "commit",
			Entity: Snapshot{ID: en.ID, Zone: m.To, Epoch: en.Epoch + 1, Seq: en.Seq, Value: en.Value},
			Move:   MoveView{ID: m.ID, Entity: en.ID, From: m.From, To: m.To, Status: "committed"}}
		return rec, reply, nil

	case "abort":
		if m == nil {
			return Record{}, StepReply{}, errNotFound("move " + req.Move + " not found")
		}
		if m.Status == "committed" {
			return Record{}, StepReply{}, errConflict("move_terminal", "move "+req.Move+" already committed; cannot abort")
		}
		// Abort only works before commit; it unfreezes at the original epoch.
		rec := Record{Op: "abort", ID: en.ID, Move: m.ID, From: m.From, To: m.To,
			Zone: en.Zone, Epoch: en.Epoch, Seq: en.Seq, Value: en.Value}
		reply := StepReply{Op: "abort",
			Entity: Snapshot{ID: en.ID, Zone: en.Zone, Epoch: en.Epoch, Seq: en.Seq, Value: en.Value},
			Move:   MoveView{ID: m.ID, Entity: en.ID, From: m.From, To: m.To, Status: "aborted"}}
		return rec, reply, nil
	}
	return Record{}, StepReply{}, errBadRequest("unknown move op " + req.Op)
}
