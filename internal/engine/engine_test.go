package engine

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func openTest(t *testing.T, dir string) *Engine {
	t.Helper()
	e, _, err := Open(filepath.Join(dir, "j.wal"), []InitialEntity{{ID: "runner1", Zone: "east", Value: 10}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	return e
}

func apply(t *testing.T, e *Engine, req Req) (json.RawMessage, *Error) {
	t.Helper()
	body, crash, err := e.Apply(req)
	if crash {
		t.Fatalf("unexpected crash for %+v", req)
	}
	if err != nil {
		var eerr *Error
		if !errors.As(err, &eerr) {
			t.Fatalf("non-engine error: %v", err)
		}
		return nil, eerr
	}
	return body, nil
}

func act(e *Engine, t *testing.T, zone string, epoch, seq uint64, delta int64) (json.RawMessage, *Error) {
	return apply(t, e, Req{Op: "action", ID: "runner1", Zone: zone, Epoch: epoch, Seq: seq, Delta: delta})
}

func step(t *testing.T, e *Engine, op, id, to string) (json.RawMessage, *Error) {
	return apply(t, e, Req{Op: op, ID: "runner1", Move: id, To: to})
}

func TestSampleScript(t *testing.T) {
	dir := t.TempDir()
	e := openTest(t, dir)
	if body, err := act(e, t, "east", 0, 1, 2); err != nil {
		t.Fatal(err)
	} else {
		var r ActionReply
		if err := json.Unmarshal(body, &r); err != nil {
			t.Fatal(err)
		}
		if r.Value != 12 || r.Seq != 1 || r.Zone != "east" || r.Epoch != 0 {
			t.Fatalf("reply %+v", r)
		}
	}
	if _, err := step(t, e, "begin", "h1", "west"); err != nil {
		t.Fatal(err)
	}
	// Frozen: a new action is retryable and keeps its seq.
	_, eerr := act(e, t, "east", 0, 2, 5)
	if eerr == nil || eerr.Code != "entity_frozen" || !eerr.Retryable || eerr.ExpectedSeq != 2 {
		t.Fatalf("frozen err %+v", eerr)
	}
	if _, err := step(t, e, "confirm", "h1", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "commit", "h1", ""); err != nil {
		t.Fatal(err)
	}
	snap, _ := e.Snapshot("runner1")
	if snap.Zone != "west" || snap.Epoch != 1 || snap.Seq != 1 || snap.Value != 12 || snap.Frozen {
		t.Fatalf("after commit %+v", snap)
	}
	// The old zone is now a stale owner.
	if _, err := act(e, t, "east", 0, 2, 5); err == nil || err.Code != "wrong_owner" {
		t.Fatalf("want wrong_owner, got %+v", err)
	}
	// The retried seq continues in the new zone/epoch.
	body, err := act(e, t, "west", 1, 2, 5)
	if err != nil {
		t.Fatal(err)
	}
	var r ActionReply
	_ = json.Unmarshal(body, &r)
	if r.Value != 17 || r.Zone != "west" || r.Epoch != 1 {
		t.Fatalf("post-commit action %+v", r)
	}

	// Restart replays to the same state.
	live, _ := e.Snapshot("runner1")
	_ = e.Close()
	e2, info, oerr := Open(filepath.Join(dir, "j.wal"), []InitialEntity{{ID: "runner1", Zone: "east", Value: 10}})
	if oerr != nil {
		t.Fatal(oerr)
	}
	defer e2.Close()
	if info.Frames != 5 {
		t.Fatalf("frames=%d", info.Frames)
	}
	snap2, _ := e2.Snapshot("runner1")
	if snap2 != live {
		t.Fatalf("recovered %+v != live %+v", snap2, live)
	}
}

func TestIdempotentRetryAndConflictBeforeOwnership(t *testing.T) {
	e := openTest(t, t.TempDir())
	first, err := act(e, t, "east", 0, 1, 3)
	if err != nil {
		t.Fatal(err)
	}
	// Same seq+delta, but from a wrong zone/epoch: dedup wins over ownership.
	again, eerr := act(e, t, "nowhere", 99, 1, 3)
	if eerr != nil {
		t.Fatalf("retry should replay, got %v", eerr)
	}
	if string(again) != string(first) {
		t.Fatalf("retry body differs:\n%s\n%s", again, first)
	}
	// Same seq, different payload: conflict, also before ownership.
	if _, eerr := act(e, t, "nowhere", 99, 1, 4); eerr == nil || eerr.Code != "seq_payload_conflict" {
		t.Fatalf("want seq_payload_conflict, got %+v", eerr)
	}
	// No state was split: value applied once.
	snap, _ := e.Snapshot("runner1")
	if snap.Value != 13 || snap.Seq != 1 {
		t.Fatalf("snap %+v", snap)
	}
}

func TestSeqMustNotSkipAndIncreaseAcrossZones(t *testing.T) {
	e := openTest(t, t.TempDir())
	if _, eerr := act(e, t, "east", 0, 2, 1); eerr == nil || eerr.Code != "seq_not_next" {
		t.Fatalf("want seq_not_next, got %+v", eerr)
	}
	if _, err := act(e, t, "east", 0, 1, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "begin", "h1", "west"); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "confirm", "h1", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "commit", "h1", ""); err != nil {
		t.Fatal(err)
	}
	// A skipped seq in the new zone is rejected.
	if _, eerr := act(e, t, "west", 1, 3, 1); eerr == nil || eerr.Code != "seq_not_next" {
		t.Fatalf("want seq_not_next, got %+v", eerr)
	}
	body, err := act(e, t, "west", 1, 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	var r ActionReply
	_ = json.Unmarshal(body, &r)
	if r.Seq != 2 || r.Epoch != 1 {
		t.Fatalf("reply %+v", r)
	}
}

func TestAbortBeforeCommitOnly(t *testing.T) {
	e := openTest(t, t.TempDir())
	mustStep := func(op, id, to string) *Error {
		_, err := step(t, e, op, id, to)
		return err
	}
	if err := mustStep("begin", "h1", "west"); err != nil {
		t.Fatal(err)
	}
	if err := mustStep("abort", "h1", ""); err != nil {
		t.Fatal(err)
	}
	snap, _ := e.Snapshot("runner1")
	if snap.Frozen || snap.Zone != "east" || snap.Epoch != 0 {
		t.Fatalf("abort must unfreeze at the original epoch: %+v", snap)
	}
	// Writes resume at the preserved epoch.
	if _, err := act(e, t, "east", 0, 1, 1); err != nil {
		t.Fatal(err)
	}
	// A fresh move id is required after the first one ended.
	if err := mustStep("begin", "h2", "west"); err != nil {
		t.Fatal(err)
	}
	if err := mustStep("confirm", "h2", ""); err != nil {
		t.Fatal(err)
	}
	if err := mustStep("commit", "h2", ""); err != nil {
		t.Fatal(err)
	}
	if err := mustStep("abort", "h2", ""); err == nil || err.Code != "move_terminal" {
		t.Fatalf("abort after commit must fail, got %+v", err)
	}
	if err := mustStep("commit", "h1", ""); err == nil || err.Code != "move_terminal" {
		t.Fatalf("commit of an aborted move must fail, got %+v", err)
	}
}

func TestAbortedMoveIDCannotStartOver(t *testing.T) {
	e := openTest(t, t.TempDir())
	if _, err := step(t, e, "begin", "h1", "west"); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "abort", "h1", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "begin", "h1", "west"); err != nil {
		// Same id, same params: returns the original begin reply.
		t.Fatalf("idempotent begin retry should replay: %v", err)
	}
	if _, err := step(t, e, "begin", "h1", "north"); err == nil || err.Code != "move_conflict" {
		t.Fatalf("reusing a terminated move id for a new target must conflict, got %+v", err)
	}
	if _, err := step(t, e, "begin", "h2", "west"); err != nil {
		t.Fatalf("a fresh move id may start after abort: %v", err)
	}
}

func TestOnlyOneMoveInFlightPerEntity(t *testing.T) {
	e := openTest(t, t.TempDir())
	if _, err := step(t, e, "begin", "h1", "west"); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "begin", "h2", "north"); err == nil || err.Code != "move_in_progress" {
		t.Fatalf("want move_in_progress, got %+v", err)
	}
}

func TestMoveStepRetriesReturnOriginal(t *testing.T) {
	e := openTest(t, t.TempDir())
	b1, err := step(t, e, "begin", "h1", "west")
	if err != nil {
		t.Fatal(err)
	}
	b2, err := step(t, e, "begin", "h1", "west")
	if err != nil || string(b1) != string(b2) {
		t.Fatalf("begin retry mismatch: %v\n%s\n%s", err, b1, b2)
	}
	c1, err := step(t, e, "confirm", "h1", "")
	if err != nil {
		t.Fatal(err)
	}
	c2, err := step(t, e, "confirm", "h1", "")
	if err != nil || string(c1) != string(c2) {
		t.Fatalf("confirm retry mismatch: %v", err)
	}
	k1, err := step(t, e, "commit", "h1", "")
	if err != nil {
		t.Fatal(err)
	}
	k2, err := step(t, e, "commit", "h1", "")
	if err != nil || string(k1) != string(k2) {
		t.Fatalf("commit retry mismatch: %v\n%s\n%s", err, k1, k2)
	}
	// Exactly one commit record exists.
	var commits int
	recs, _ := e.LogPage(0, 0)
	for _, r := range recs {
		if r.Record.Op == "commit" {
			commits++
		}
	}
	if commits != 1 {
		t.Fatalf("commit records=%d want 1", commits)
	}
}

func TestConfirmRequiresBegunAndCommitRequiresConfirm(t *testing.T) {
	e := openTest(t, t.TempDir())
	if _, err := step(t, e, "confirm", "h1", ""); err == nil || err.Code != "not_found" {
		t.Fatalf("confirm without begin: %+v", err)
	}
	if _, err := step(t, e, "begin", "h1", "west"); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "commit", "h1", ""); err == nil || err.Code != "move_not_confirmed" {
		t.Fatalf("commit without confirm: %+v", err)
	}
}

func TestCrashAfterDurableAppendRecovers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "j.wal")
	e, _, err := Open(path, []InitialEntity{{ID: "runner1", Zone: "east", Value: 10}})
	if err != nil {
		t.Fatal(err)
	}
	e.SetCrashPoint("action")
	_, crash, err := e.Apply(Req{Op: "action", ID: "runner1", Zone: "east", Epoch: 0, Seq: 1, Delta: 4})
	if !crash || err != nil {
		t.Fatalf("crash=%v err=%v", crash, err)
	}
	// The client never saw a reply; the write is durable anyway.
	_ = e.Close()

	e2, info, err := Open(path, []InitialEntity{{ID: "runner1", Zone: "east", Value: 10}})
	if err != nil {
		t.Fatal(err)
	}
	defer e2.Close()
	if info.Frames != 1 {
		t.Fatalf("frames=%d", info.Frames)
	}
	// The retry of the unanswered request returns the original result and does
	// not apply twice.
	body, crash, err := e2.Apply(Req{Op: "action", ID: "runner1", Zone: "east", Epoch: 0, Seq: 1, Delta: 4})
	if crash || err != nil {
		t.Fatalf("retry crash=%v err=%v", crash, err)
	}
	var r ActionReply
	_ = json.Unmarshal(body, &r)
	if r.Value != 14 || r.Seq != 1 {
		t.Fatalf("reply %+v", r)
	}
	snap, _ := e2.Snapshot("runner1")
	if snap.Value != 14 {
		t.Fatalf("value applied twice: %+v", snap)
	}
	if info2 := e2; info2 != nil {
		recs, _ := e2.LogPage(0, 0)
		if len(recs) != 1 {
			t.Fatalf("records=%d want 1", len(recs))
		}
	}
}

func TestRecoveryMidMove(t *testing.T) {
	base := []InitialEntity{{ID: "runner1", Zone: "east", Value: 10}}
	steps := []Req{
		{Op: "begin", ID: "runner1", Move: "h1", To: "west"},
		{Op: "confirm", ID: "runner1", Move: "h1"},
		{Op: "commit", ID: "runner1", Move: "h1"},
	}
	for i, crashing := range steps {
		dir := t.TempDir()
		path := filepath.Join(dir, "j.wal")
		e, _, err := Open(path, base)
		if err != nil {
			t.Fatal(err)
		}
		for _, prior := range steps[:i] {
			if _, crash, err := e.Apply(prior); crash || err != nil {
				t.Fatalf("setup %+v: crash=%v err=%v", prior, crash, err)
			}
		}
		e.SetCrashPoint(crashing.Op)
		if _, crash, err := e.Apply(crashing); !crash {
			t.Fatalf("%s: expected crash, got err=%v", crashing.Op, err)
		}
		_ = e.Close()

		// Restart: the crashed step is part of the durable state.
		e2, info, err := Open(path, base)
		if err != nil {
			t.Fatal(err)
		}
		if info.Frames != i+1 {
			t.Fatalf("%s: frames=%d want %d", crashing.Op, info.Frames, i+1)
		}
		snap, _ := e2.Snapshot("runner1")
		wantFrozen := crashing.Op != "commit"
		if snap.Frozen != wantFrozen {
			t.Fatalf("%s: frozen=%v", crashing.Op, snap.Frozen)
		}
		// Retrying the unanswered step returns the original reply; retrying it
		// again after it is answered is still a replay, never a second write.
		body1, crash, err := e2.Apply(crashing)
		if crash || err != nil {
			t.Fatalf("%s: retry crash=%v err=%v", crashing.Op, crash, err)
		}
		body2, crash, err := e2.Apply(crashing)
		if crash || err != nil || string(body1) != string(body2) {
			t.Fatalf("%s: second retry differs: %v %s %s", crashing.Op, err, body1, body2)
		}
		recs, _ := e2.LogPage(0, 0)
		if len(recs) != i+1 {
			t.Fatalf("%s: records=%d want %d (retries must not write)", crashing.Op, len(recs), i+1)
		}
		if crashing.Op == "commit" {
			after, _ := e2.Snapshot("runner1")
			if after.Zone != "west" || after.Epoch != 1 || after.Frozen {
				t.Fatalf("commit recovery %+v", after)
			}
		}
		_ = e2.Close()
	}
}

func TestFrozenRejectsWithoutConsumingSeq(t *testing.T) {
	e := openTest(t, t.TempDir())
	if _, err := act(e, t, "east", 0, 1, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "begin", "h1", "west"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, eerr := act(e, t, "east", 0, 2, 7); eerr == nil || eerr.ExpectedSeq != 2 {
			t.Fatalf("iteration %d: %+v", i, eerr)
		}
	}
	if _, err := step(t, e, "confirm", "h1", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := step(t, e, "commit", "h1", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := act(e, t, "west", 1, 2, 7); err != nil {
		t.Fatal(err)
	}
	snap, _ := e.Snapshot("runner1")
	if snap.Value != 18 || snap.Seq != 2 {
		t.Fatalf("snap %+v", snap)
	}
}

func TestBatchAppliesInOrderWithOneFsync(t *testing.T) {
	e := openTest(t, t.TempDir())
	items := []BatchItem{
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 1, Delta: 1},
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 2, Delta: 2},
		{ID: "runner1", Zone: "east", Epoch: 0, Seq: 3, Delta: 3},
	}
	raw, _ := json.Marshal(items)
	body, crash, err := e.Apply(Req{Op: "batch", ItemsRaw: raw})
	if crash || err != nil {
		t.Fatalf("batch: crash=%v err=%v", crash, err)
	}
	var br BatchReply
	if err := json.Unmarshal(body, &br); err != nil {
		t.Fatal(err)
	}
	if br.Applied != 3 || len(br.Results) != 3 {
		t.Fatalf("batch reply %+v", br)
	}
	snap, _ := e.Snapshot("runner1")
	if snap.Value != 16 || snap.Seq != 3 {
		t.Fatalf("snap %+v", snap)
	}
}

func TestValidation(t *testing.T) {
	e := openTest(t, t.TempDir())
	if _, _, err := e.Apply(Req{Op: "action", ID: "nope", Zone: "east", Seq: 1, Delta: 1}); err == nil {
		t.Fatal("unknown entity must fail")
	}
	if _, _, err := e.Apply(Req{Op: "action", ID: "runner1", Zone: "east", Seq: 1, Delta: 1000001}); err == nil {
		t.Fatal("delta out of range must fail")
	}
	if _, _, err := e.Apply(Req{Op: "action", ID: "runner1", Zone: "east", Seq: 1, Delta: -1000001}); err == nil {
		t.Fatal("delta out of range must fail")
	}
	if _, _, err := e.Apply(Req{Op: "bogus"}); err == nil {
		t.Fatal("unknown op must fail")
	}
}
