package engine

import (
	"sync"
	"testing"
)

// Concurrent commit retries for one handoff must journal exactly one commit
// and return one identical body to every caller.
func TestConcurrentCommitRetriesLandOnce(t *testing.T) {
	dir := t.TempDir()
	e := openTest(t, dir)
	if _, err := step(t, e, "begin", "h1", "west"); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "confirm", "h1", ""); err != nil {
		t.Fatal(err)
	}
	const n = 48
	var wg sync.WaitGroup
	bodies := make([]string, n)
	errs := make([]*Error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body, _, err := e.Apply(Req{Op: "commit", ID: "runner1", Move: "h1"})
			if err != nil {
				errs[i] = err.(*Error)
				return
			}
			bodies[i] = string(body)
		}(i)
	}
	wg.Wait()
	for i := range bodies {
		if errs[i] != nil {
			t.Fatalf("caller %d: %+v", i, errs[i])
		}
		if bodies[i] != bodies[0] {
			t.Fatalf("reply %d differs: %s vs %s", i, bodies[i], bodies[0])
		}
	}
	var commits int
	recs, _ := e.LogPage(0, 0)
	for _, r := range recs {
		if r.Record.Op == "commit" {
			commits++
		}
	}
	if commits != 1 {
		t.Fatalf("commit frames=%d want 1", commits)
	}
	snap, _ := e.Snapshot("runner1")
	if snap.Epoch != 1 || snap.Zone != "west" {
		t.Fatalf("snap %+v", snap)
	}
	_ = e.Close()
	e2 := openTest(t, dir)
	snap2, _ := e2.Snapshot("runner1")
	if snap2 != snap {
		t.Fatalf("recovered %+v != %+v", snap2, snap)
	}
}

// A handoff and an action racing: while frozen no action may commit, and after
// commit only the new epoch/zone accepts the preserved seq.
func TestActionDuringMoveRace(t *testing.T) {
	e := openTest(t, t.TempDir())
	if _, err := act(e, t, "east", 0, 1, 1); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	var actionErr *Error
	var actionBody []byte
	go func() {
		defer wg.Done()
		body, _, err := e.Apply(Req{Op: "action", ID: "runner1", Zone: "east", Epoch: 0, Seq: 2, Delta: 3})
		if err != nil {
			actionErr = err.(*Error)
		} else {
			actionBody = body
		}
	}()
	go func() {
		defer wg.Done()
		_, _, _ = e.Apply(Req{Op: "begin", ID: "runner1", Move: "h1", To: "west"})
	}()
	wg.Wait()
	snap, _ := e.Snapshot("runner1")
	if actionBody != nil {
		// The action landed first; the handoff then froze at seq 2.
		if snap.Seq != 2 || !snap.Frozen {
			t.Fatalf("action-first result %+v", snap)
		}
	} else {
		// The handoff landed first; the action was told to retry its seq.
		if actionErr == nil || actionErr.Code != "entity_frozen" || actionErr.ExpectedSeq != 2 {
			t.Fatalf("handoff-first result %+v", actionErr)
		}
		if snap.Seq != 1 || !snap.Frozen {
			t.Fatalf("handoff-first state %+v", snap)
		}
	}
}
