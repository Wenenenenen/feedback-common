package engine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestSampleFileScript runs the scenario shipped in samples/zone-handoff.json
// against a fresh journal and against a restarted one.
type sampleDoc struct {
	Entities []InitialEntity `json:"entities"`
	Steps    []struct {
		Op    string `json:"op"`
		ID    string `json:"id"`
		Zone  string `json:"zone"`
		Epoch uint64 `json:"epoch"`
		Seq   uint64 `json:"seq"`
		Delta int64  `json:"delta"`
		Move  string `json:"move"`
		To    string `json:"to"`
	} `json:"steps"`
}

func loadSample(t *testing.T) sampleDoc {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "samples", "zone-handoff.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc sampleDoc
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Entities) == 0 || len(doc.Steps) == 0 {
		t.Fatal("sample is missing entities or steps")
	}
	return doc
}

func runSample(t *testing.T, e *Engine, doc sampleDoc) []string {
	t.Helper()
	var ops []string
	for _, s := range doc.Steps {
		req := Req{Op: s.Op, ID: s.ID, Zone: s.Zone, Epoch: s.Epoch, Seq: s.Seq, Delta: s.Delta, Move: s.Move, To: s.To}
		_, crash, err := e.Apply(req)
		if crash || err != nil {
			t.Fatalf("step %+v: crash=%v err=%v", s, crash, err)
		}
		ops = append(ops, s.Op)
	}
	return ops
}

func TestSampleFileScript(t *testing.T) {
	doc := loadSample(t)
	dir := t.TempDir()
	e, _, err := Open(filepath.Join(dir, "j.wal"), doc.Entities)
	if err != nil {
		t.Fatal(err)
	}
	runSample(t, e, doc)
	live, _ := e.Snapshot("runner1")
	if live.Zone != "west" || live.Epoch != 1 || live.Seq != 1 || live.Value != 12 || live.Frozen {
		t.Fatalf("sample result %+v", live)
	}
	_ = e.Close()

	// Restart: the same script steps are all idempotent replays now.
	e2, info, err := Open(filepath.Join(dir, "j.wal"), doc.Entities)
	if err != nil {
		t.Fatal(err)
	}
	defer e2.Close()
	if info.Frames != len(doc.Steps) {
		t.Fatalf("frames=%d want %d", info.Frames, len(doc.Steps))
	}
	runSample(t, e2, doc)
	recs, _ := e2.LogPage(0, 0)
	if len(recs) != len(doc.Steps) {
		t.Fatalf("replaying the script wrote %d extra frames", len(recs)-len(doc.Steps))
	}
	rec, _ := e2.Snapshot("runner1")
	if rec != live {
		t.Fatalf("recovered %+v != %+v", rec, live)
	}
}
