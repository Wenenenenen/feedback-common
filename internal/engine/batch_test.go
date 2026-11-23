package engine

import (
	"encoding/json"
	"testing"
)

func runBatch(t *testing.T, e *Engine, items []BatchItem) BatchReply {
	t.Helper()
	raw, _ := json.Marshal(items)
	body, crash, err := e.Apply(Req{Op: "batch", ItemsRaw: raw})
	if crash {
		t.Fatal("unexpected crash")
	}
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	var br BatchReply
	if err := json.Unmarshal(body, &br); err != nil {
		t.Fatal(err)
	}
	return br
}

func TestBatchMixedResults(t *testing.T) {
	e := openTest(t, t.TempDir())
	items := []BatchItem{
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 1, Delta: 1}, // ok
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 3, Delta: 1}, // gap
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 2, Delta: 2}, // ok
		{ID: "runner1", Zone: "east", Epoch: 5, Seq: 4, Delta: 1}, // wrong epoch
		{ID: "ghost", Zone: "east", Epoch: 0, Seq: 1, Delta: 1},   // no entity
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 3, Delta: 4}, // ok now
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 1, Delta: 1}, // replay of item 0
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 1, Delta: 9}, // conflict
	}
	br := runBatch(t, e, items)
	// 3 new frames plus 1 in-batch replay: only new frames are journaled.
	if br.Count != 8 || br.Applied != 4 {
		t.Fatalf("count=%d applied=%d", br.Count, br.Applied)
	}
	wantCodes := map[int]string{1: "seq_not_next", 3: "wrong_owner", 4: "not_found", 7: "seq_payload_conflict"}
	for i, code := range wantCodes {
		if br.Results[i].Error == nil || br.Results[i].Error.Code != code {
			t.Fatalf("item %d: want %s, got %+v", i, code, br.Results[i])
		}
	}
	for _, i := range []int{0, 2, 5, 6} {
		if !br.Results[i].OK {
			t.Fatalf("item %d should be ok: %+v", i, br.Results[i])
		}
	}
	// The replay of item 0 inside the same batch returns its body verbatim.
	if string(br.Results[0].Reply) != string(br.Results[6].Reply) {
		t.Fatalf("in-batch replay differs")
	}
	snap, _ := e.Snapshot("runner1")
	if snap.Value != 17 || snap.Seq != 3 {
		t.Fatalf("snap %+v", snap)
	}
	recs, _ := e.LogPage(0, 0)
	if len(recs) != 3 {
		t.Fatalf("records=%d want 3", len(recs))
	}
}

func TestBatchAllRejected(t *testing.T) {
	e := openTest(t, t.TempDir())
	br := runBatch(t, e, []BatchItem{{ID: "runner1", Zone: "east", Epoch: 0, Seq: 2, Delta: 1}})
	if br.Applied != 0 || br.Results[0].Error == nil {
		t.Fatalf("reply %+v", br)
	}
	recs, _ := e.LogPage(0, 0)
	if len(recs) != 0 {
		t.Fatalf("rejected batch must not write, got %d records", len(recs))
	}
}

func TestBatchRetryAfterRestart(t *testing.T) {
	dir := t.TempDir()
	e := openTest(t, dir)
	items := []BatchItem{
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 1, Delta: 1},
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 2, Delta: 1},
	}
	br := runBatch(t, e, items)
	if br.Applied != 2 {
		t.Fatalf("applied=%d", br.Applied)
	}
	_ = e.Close()
	e2 := openTest(t, dir)
	br2 := runBatch(t, e2, items)
	if br2.Applied != 2 {
		t.Fatalf("replayed applied=%d", br2.Applied)
	}
	if string(br2.Results[0].Reply) != string(br.Results[0].Reply) {
		t.Fatal("batch retry body differs after restart")
	}
	recs, _ := e2.LogPage(0, 0)
	if len(recs) != 2 {
		t.Fatalf("records=%d want 2 (retry must not write)", len(recs))
	}
}
