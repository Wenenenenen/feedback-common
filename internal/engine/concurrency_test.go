package engine

import (
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
)

// Concurrent retries of the same (entity, seq, delta) must commit exactly once;
// every caller receives the identical reply and the entity advances one step.
func TestConcurrentActionRetriesCommitOnce(t *testing.T) {
	dir := t.TempDir()
	e := openTest(t, dir)
	const n = 64
	var wg sync.WaitGroup
	bodies := make([]string, n)
	errs := make([]*Error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body, _, err := e.Apply(Req{Op: "action", ID: "runner1", Zone: "east", Epoch: 0, Seq: 1, Delta: 9})
			if err != nil {
				errs[i] = err.(*Error)
				return
			}
			bodies[i] = string(body)
		}(i)
	}
	wg.Wait()
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("caller %d failed: %+v", i, errs[i])
		}
		if bodies[i] != bodies[0] {
			t.Fatalf("reply %d differs:\n%s\n%s", i, bodies[i], bodies[0])
		}
	}
	snap, _ := e.Snapshot("runner1")
	if snap.Value != 19 || snap.Seq != 1 {
		t.Fatalf("value must move once: %+v", snap)
	}
	recs, _ := e.LogPage(0, 0)
	if len(recs) != 1 {
		t.Fatalf("records=%d want exactly 1", len(recs))
	}
}

// Concurrent begins on one entity: exactly one wins, the rest observe the same
// move or are told a handoff is already running.
func TestConcurrentBeginOnlyOne(t *testing.T) {
	e := openTest(t, t.TempDir())
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, inProgress := 0, 0
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := e.Apply(Req{Op: "begin", ID: "runner1", Move: "h1", To: "west"})
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				wins++
			} else if err.(*Error).Code == "move_in_progress" {
				inProgress++
			}
		}()
	}
	wg.Wait()
	if wins < 1 {
		t.Fatalf("no begin succeeded")
	}
	// Same move id: retries replay the stored begin reply rather than conflict.
	if inProgress != 0 {
		t.Fatalf("in-progress=%d, expected same-id retries to replay", inProgress)
	}
	recs, _ := e.LogPage(0, 0)
	if len(recs) != 1 {
		t.Fatalf("records=%d want 1", len(recs))
	}
	snap, _ := e.Snapshot("runner1")
	if !snap.Frozen || snap.Move != "h1" {
		t.Fatalf("snap %+v", snap)
	}
}

// Different move ids racing on one entity: exactly one wins; the rest are told
// the entity already has a handoff in progress.
func TestConcurrentDistinctBegins(t *testing.T) {
	e := openTest(t, t.TempDir())
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, blocked := 0, 0
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := "h" + string(rune('a'+i%26))
			_, _, err := e.Apply(Req{Op: "begin", ID: "runner1", Move: id, To: "west"})
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				wins++
			} else if err.(*Error).Code == "move_in_progress" {
				blocked++
			}
		}(i)
	}
	wg.Wait()
	if wins != 1 || blocked != 23 {
		t.Fatalf("wins=%d blocked=%d", wins, blocked)
	}
}

// 20k sequential actions must be accepted and queryable well under the 8s
// budget on a 4-core box; batch keeps the fsync count low.
func TestTwentyThousandActionsBatch(t *testing.T) {
	dir := t.TempDir()
	e := openTest(t, dir)
	const total = 20000
	const chunk = 1000
	var seq uint64
	for seq < total {
		n := chunk
		if total-int(seq) < n {
			n = total - int(seq)
		}
		items := make([]BatchItem, 0, n)
		for i := 0; i < n; i++ {
			seq++
			items = append(items, BatchItem{ID: "runner1", Zone: "east", Epoch: 0, Seq: seq, Delta: 1})
		}
		raw, _ := json.Marshal(items)
		body, crash, err := e.Apply(Req{Op: "batch", ItemsRaw: raw})
		if crash || err != nil {
			t.Fatalf("batch at %d: crash=%v err=%v", seq, crash, err)
		}
		var br BatchReply
		if err := json.Unmarshal(body, &br); err != nil {
			t.Fatal(err)
		}
		if br.Applied != n {
			t.Fatalf("applied=%d want %d at %d: %+v", br.Applied, n, seq, br)
		}
	}
	snap, _ := e.Snapshot("runner1")
	if snap.Value != 10+total || snap.Seq != total {
		t.Fatalf("snap %+v", snap)
	}
	recs, totalRecs := e.LogPage(0, 0)
	if totalRecs != total || len(recs) != total {
		t.Fatalf("records=%d want %d", totalRecs, total)
	}
	_ = e.Close()

	// Restart replay must reproduce the same state within the same budget.
	e2, info, err := Open(filepath.Join(dir, "j.wal"), []InitialEntity{{ID: "runner1", Zone: "east", Value: 10}})
	if err != nil {
		t.Fatal(err)
	}
	defer e2.Close()
	if info.Frames != total {
		t.Fatalf("frames=%d", info.Frames)
	}
	snap2, _ := e2.Snapshot("runner1")
	if snap2 != snap {
		t.Fatalf("recovered %+v != %+v", snap2, snap)
	}
}
