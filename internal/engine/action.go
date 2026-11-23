package engine

import (
	"encoding/json"
	"fmt"
)

// validateAction checks fields that do not depend on stored state.
func validateAction(req Req) *Error {
	if req.ID == "" {
		return errBadRequest("id is required")
	}
	if req.Seq == 0 {
		return errBadRequest("seq must be >= 1")
	}
	if req.Delta < -1000000 || req.Delta > 1000000 {
		return errBadRequest("delta must be within +/-1000000")
	}
	return nil
}

type actionPlan struct {
	Record Record
	Body   []byte
	Replay []byte // non-nil when this is a duplicate of a durable action
	After  uint64 // durability barrier for a replay
}

// planAction validates a new action against a state view without mutating it.
//
// Order matters and is part of the contract:
//  1. duplicate (entity, seq) -> original result, or seq_payload_conflict;
//     this check precedes any ownership check;
//  2. frozen entity -> retryable conflict, seq preserved;
//  3. owner zone and epoch must match;
//  4. seq must be exactly current+1 (never skip).
func planActionOn(s actionView, req Req) (actionPlan, *Error) {
	en, ok := s.entity(req.ID)
	if !ok {
		return actionPlan{}, errNotFound("entity " + req.ID + " not found")
	}
	key := actionKey{req.ID, req.Seq}

	if prev := s.dedupEntry(key); prev != nil {
		if prev.Delta != req.Delta {
			return actionPlan{}, errConflict("seq_payload_conflict",
				fmt.Sprintf("seq %d already committed with delta %d, not %d", req.Seq, prev.Delta, req.Delta))
		}
		return actionPlan{Replay: prev.Body, After: prev.After}, nil
	}

	if en.Frozen {
		snap := snapshotOf(en)
		return actionPlan{}, &Error{Status: 409, Code: "entity_frozen", Retryable: true,
			Message:     "entity is frozen for handoff; retry the same seq later",
			ExpectedSeq: en.Seq + 1, Entity: &snap}
	}
	if req.Zone != en.Zone || req.Epoch != en.Epoch {
		snap := snapshotOf(en)
		return actionPlan{}, &Error{Status: 409, Code: "wrong_owner",
			Message: fmt.Sprintf("expected zone=%s epoch=%d, got zone=%s epoch=%d", en.Zone, en.Epoch, req.Zone, req.Epoch),
			Entity:  &snap}
	}
	if req.Seq != en.Seq+1 {
		snap := snapshotOf(en)
		return actionPlan{}, &Error{Status: 409, Code: "seq_not_next",
			Message: fmt.Sprintf("expected seq %d, got %d", en.Seq+1, req.Seq),
			Entity:  &snap}
	}

	value := en.Value + req.Delta
	snap := Snapshot{ID: en.ID, Zone: en.Zone, Epoch: en.Epoch, Seq: req.Seq, Value: value}
	reply := ActionReply{Op: "action", ID: en.ID, Seq: req.Seq, Zone: en.Zone,
		Epoch: en.Epoch, Delta: req.Delta, Value: value, Entity: snap}
	body, err := marshal(reply)
	if err != nil {
		return actionPlan{}, errInternal("encode reply: " + err.Error())
	}
	return actionPlan{
		Record: Record{Op: "action", ID: en.ID, Seq: req.Seq, Delta: req.Delta,
			Zone: en.Zone, Epoch: en.Epoch, Value: value, Resp: body},
		Body: body,
	}, nil
}

// marshal encodes a reply body once; it is stored in the record so replays are
// byte-identical.
func marshal(v any) ([]byte, error) { return json.Marshal(v) }

func (e *Engine) doAction(req Req) (json.RawMessage, bool, error) {
	if verr := validateAction(req); verr != nil {
		return nil, false, verr
	}
	e.mu.Lock()
	if e.failed != nil {
		e.mu.Unlock()
		return nil, false, errInternal("journal unavailable")
	}
	plan, verr := planActionOn(e.live, req)
	if verr != nil {
		e.mu.Unlock()
		return nil, false, verr
	}
	if plan.Replay != nil {
		body, after := plan.Replay, plan.After
		e.mu.Unlock()
		// A replay writes nothing, but must not answer before the frame it
		// replays is durable.
		return body, false, e.waitDurable(after)
	}
	seq, err := e.writeLocked([]Record{plan.Record})
	if err != nil {
		e.mu.Unlock()
		return nil, false, err
	}
	e.mu.Unlock()

	crash, err := e.settle("action", seq, true)
	return plan.Body, crash, err
}
