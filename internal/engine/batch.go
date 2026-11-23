package engine

import (
	"encoding/json"
)

// BatchItem is one action inside a batch request.
type BatchItem struct {
	ID    string `json:"id"`
	Zone  string `json:"zone"`
	Epoch uint64 `json:"epoch"`
	Seq   uint64 `json:"seq"`
	Delta int64  `json:"delta"`
}

// BatchResult is the per-item outcome. Exactly one of Reply/Error is set.
type BatchResult struct {
	OK    bool            `json:"ok"`
	Reply json.RawMessage `json:"reply,omitempty"`
	Error *Error          `json:"error,omitempty"`
}

// BatchReply is the batch response.
type BatchReply struct {
	Op      string        `json:"op"`
	Count   int           `json:"count"`
	Applied int           `json:"applied"`
	Results []BatchResult `json:"results"`
	// JournalBytes is the durable journal size once the batch is on disk.
	JournalBytes int64 `json:"journal_bytes"`
}

// doBatch applies items in order with a single journal write (one fsync).
//
// Items are validated against the effects of earlier items in the same batch.
// Rejected items are reported individually and do not abort the rest. A retry
// of an item already durable is answered with its original body and writes
// nothing.
func (e *Engine) doBatch(req Req) (json.RawMessage, bool, error) {
	if len(req.ItemsRaw) == 0 {
		return nil, false, errBadRequest("batch requires items")
	}
	var items []BatchItem
	if err := json.Unmarshal(req.ItemsRaw, &items); err != nil {
		return nil, false, errBadRequest("invalid batch items: " + err.Error())
	}
	if len(items) == 0 {
		return nil, false, errBadRequest("batch items must not be empty")
	}

	e.mu.Lock()
	if e.failed != nil {
		e.mu.Unlock()
		return nil, false, errInternal("journal unavailable")
	}

	// Items are validated against an overlay so they see each other's effects
	// without touching the live view until the frames are queued.
	view := newOverlay(e.live)
	results := make([]BatchResult, len(items))
	recs := make([]Record, 0, len(items))
	applied := 0
	var barriers []uint64

	for i, item := range items {
		r := Req{Op: "action", ID: item.ID, Zone: item.Zone, Epoch: item.Epoch, Seq: item.Seq, Delta: item.Delta}
		plan, verr := planActionOn(view, r)
		if verr != nil {
			results[i] = BatchResult{Error: verr}
			continue
		}
		applied++
		if plan.Replay != nil {
			results[i] = BatchResult{OK: true, Reply: plan.Replay}
			if plan.After != 0 {
				barriers = append(barriers, plan.After)
			}
			continue
		}
		view.stage(&plan.Record, plan.Body)
		results[i] = BatchResult{OK: true, Reply: plan.Body}
		recs = append(recs, plan.Record)
	}

	var seq uint64
	if len(recs) > 0 {
		s, err := e.writeLocked(recs)
		if err != nil {
			e.mu.Unlock()
			return nil, false, err
		}
		seq = s
	}
	e.mu.Unlock()

	wait := seq
	for _, b := range barriers {
		if b > wait {
			wait = b
		}
	}
	crash, serr := e.settle("batch", wait, len(recs) > 0)
	if serr != nil {
		return nil, false, serr
	}
	out, merr := json.Marshal(BatchReply{Op: "batch", Count: len(items), Applied: applied,
		Results: results, JournalBytes: e.JournalSize()})
	if merr != nil {
		return nil, false, errInternal("encode batch reply")
	}
	return out, crash, nil
}
