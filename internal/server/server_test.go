package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"zonehandoff/internal/engine"
)

type harness struct {
	t       *testing.T
	path    string
	eng     *engine.Engine
	srv     *httptest.Server
	crashed chan struct{}
}

var base = []engine.InitialEntity{{ID: "runner1", Zone: "east", Value: 10}}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t, path: filepath.Join(t.TempDir(), "j.wal"), crashed: make(chan struct{}, 1)}
	h.start()
	t.Cleanup(h.close)
	return h
}

func (h *harness) start() {
	h.t.Helper()
	eng, info, err := engine.Open(h.path, base)
	if err != nil {
		h.t.Fatalf("open: %v", err)
	}
	logger := log.New(io.Discard, "", 0)
	h.eng = eng
	h.srv = httptest.NewServer(New(eng, info, Options{Baseline: base, Logger: logger,
		CrashExit: func() { h.crashed <- struct{}{} }}).Handler())
}

func (h *harness) close() {
	if h.srv != nil {
		h.srv.Close()
	}
	if h.eng != nil {
		_ = h.eng.Close()
	}
}

// restart simulates the process dying and coming back from the journal.
func (h *harness) restart() {
	h.t.Helper()
	if h.srv != nil {
		h.srv.Close()
	}
	_ = h.eng.Close()
	h.eng, h.srv = nil, nil
	h.start()
}

type reply struct {
	status int
	body   []byte
}

func (h *harness) post(path string, v any) reply {
	h.t.Helper()
	b, _ := json.Marshal(v)
	res, err := http.Post(h.srv.URL+path, "application/json", bytes.NewReader(b))
	if err != nil {
		h.t.Fatalf("post %s: %v", path, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return reply{status: res.StatusCode, body: body}
}

func (h *harness) get(path string) reply {
	h.t.Helper()
	res, err := http.Get(h.srv.URL + path)
	if err != nil {
		h.t.Fatalf("get %s: %v", path, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return reply{status: res.StatusCode, body: body}
}

func (h *harness) state() map[string]any {
	h.t.Helper()
	r := h.get("/api/state")
	if r.status != 200 {
		h.t.Fatalf("state status %d", r.status)
	}
	var m map[string]any
	if err := json.Unmarshal(r.body, &m); err != nil {
		h.t.Fatal(err)
	}
	return m
}

func entity(t *testing.T, m map[string]any, id string) map[string]any {
	t.Helper()
	list, _ := m["entities"].([]any)
	for _, e := range list {
		em := e.(map[string]any)
		if em["id"] == id {
			return em
		}
	}
	t.Fatalf("entity %s missing", id)
	return nil
}

func errorCode(t *testing.T, r reply) string {
	t.Helper()
	var body struct {
		Error struct {
			Code      string `json:"code"`
			Retryable bool   `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(r.body, &body); err != nil {
		t.Fatalf("decode error body %q: %v", r.body, err)
	}
	return body.Error.Code
}

func TestHTTPFlow(t *testing.T) {
	h := newHarness(t)
	r := h.post("/api/action", map[string]any{"id": "runner1", "zone": "east", "epoch": 0, "seq": 1, "delta": 2})
	if r.status != 200 {
		t.Fatalf("action: %d %s", r.status, r.body)
	}
	first := string(r.body)
	// Retry is byte-identical.
	if again := h.post("/api/action", map[string]any{"id": "runner1", "zone": "west", "epoch": 7, "seq": 1, "delta": 2}); string(again.body) != first {
		t.Fatalf("retry mismatch: %s vs %s", again.body, first)
	}
	if r := h.post("/api/action", map[string]any{"id": "runner1", "zone": "east", "epoch": 0, "seq": 1, "delta": 3}); r.status != 409 || errorCode(t, r) != "seq_payload_conflict" {
		t.Fatalf("conflict: %d %s", r.status, r.body)
	}
	if r := h.post("/api/move", map[string]any{"op": "begin", "id": "runner1", "move": "h1", "to": "west"}); r.status != 200 {
		t.Fatalf("begin: %d %s", r.status, r.body)
	}
	if r := h.post("/api/action", map[string]any{"id": "runner1", "zone": "east", "epoch": 0, "seq": 2, "delta": 1}); r.status != 409 || errorCode(t, r) != "entity_frozen" {
		t.Fatalf("frozen: %d %s", r.status, r.body)
	}
	if r := h.post("/api/move", map[string]any{"op": "confirm", "id": "runner1", "move": "h1"}); r.status != 200 {
		t.Fatalf("confirm: %d %s", r.status, r.body)
	}
	if r := h.post("/api/move", map[string]any{"op": "commit", "id": "runner1", "move": "h1"}); r.status != 200 {
		t.Fatalf("commit: %d %s", r.status, r.body)
	}
	e := entity(t, h.state(), "runner1")
	if e["zone"] != "west" || e["epoch"] != float64(1) || e["seq"] != float64(1) || e["value"] != float64(12) {
		t.Fatalf("entity %+v", e)
	}
	// The client's preserved seq 2 now commits in the new zone/epoch.
	if r := h.post("/api/action", map[string]any{"id": "runner1", "zone": "west", "epoch": 1, "seq": 2, "delta": 5}); r.status != 200 {
		t.Fatalf("post-commit action: %d %s", r.status, r.body)
	}
	log := h.get("/api/log?from=-1&limit=50")
	if log.status != 200 || !strings.Contains(string(log.body), `"op":"commit"`) {
		t.Fatalf("log: %d %s", log.status, log.body)
	}
	if h.get("/api/health").status != 200 {
		t.Fatal("health")
	}
	if r := h.get("/api/crash"); r.status != 200 {
		t.Fatal("crash get")
	}
}

// crashAt arms a crash, performs the step, and asserts the client saw no reply.
func (h *harness) crashAt(op string, do func() reply) {
	h.t.Helper()
	if r := h.post("/api/crash", map[string]any{"op": op}); r.status != 200 {
		h.t.Fatalf("arm crash: %d %s", r.status, r.body)
	}
	done := make(chan reply, 1)
	go func() { done <- do() }()
	select {
	case <-h.crashed:
	case r := <-done:
		h.t.Fatalf("%s: process did not crash, got %d %q", op, r.status, r.body)
	case <-time.After(5 * time.Second):
		h.t.Fatalf("%s: timed out waiting for crash", op)
	}
	// Drain the (reply-less) HTTP result, then come back from the journal.
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		h.t.Fatalf("%s: request did not finish", op)
	}
	h.restart()
}

func TestCrashPointsRecover(t *testing.T) {
	cases := []struct {
		name  string
		setup func(h *harness)
		op    string
		do    func(h *harness) reply
		check func(t *testing.T, st map[string]any)
	}{
		{
			name: "begin",
			op:   "begin",
			do: func(h *harness) reply {
				return h.post("/api/move", map[string]any{"op": "begin", "id": "runner1", "move": "h1", "to": "west"})
			},
			check: func(t *testing.T, st map[string]any) {
				e := entity(t, st, "runner1")
				if e["frozen"] != true || e["move"] != "h1" {
					t.Fatalf("after begin crash: %+v", e)
				}
			},
		},
		{
			name: "confirm",
			op:   "confirm",
			setup: func(h *harness) {
				h.post("/api/move", map[string]any{"op": "begin", "id": "runner1", "move": "h1", "to": "west"})
			},
			do: func(h *harness) reply {
				return h.post("/api/move", map[string]any{"op": "confirm", "id": "runner1", "move": "h1"})
			},
			check: func(t *testing.T, st map[string]any) {
				e := entity(t, st, "runner1")
				if e["frozen"] != true {
					t.Fatalf("after confirm crash: %+v", e)
				}
				moves := st["moves"].([]any)
				if len(moves) != 1 || moves[0].(map[string]any)["status"] != "confirmed" {
					t.Fatalf("moves %+v", moves)
				}
			},
		},
		{
			name: "commit",
			op:   "commit",
			setup: func(h *harness) {
				h.post("/api/move", map[string]any{"op": "begin", "id": "runner1", "move": "h1", "to": "west"})
				h.post("/api/move", map[string]any{"op": "confirm", "id": "runner1", "move": "h1"})
			},
			do: func(h *harness) reply {
				return h.post("/api/move", map[string]any{"op": "commit", "id": "runner1", "move": "h1"})
			},
			check: func(t *testing.T, st map[string]any) {
				e := entity(t, st, "runner1")
				if e["zone"] != "west" || e["epoch"] != float64(1) || e["frozen"] != false {
					t.Fatalf("after commit crash: %+v", e)
				}
			},
		},
		{
			name: "action",
			op:   "action",
			do: func(h *harness) reply {
				return h.post("/api/action", map[string]any{"id": "runner1", "zone": "east", "epoch": 0, "seq": 1, "delta": 7})
			},
			check: func(t *testing.T, st map[string]any) {
				e := entity(t, st, "runner1")
				if e["value"] != float64(17) || e["seq"] != float64(1) {
					t.Fatalf("after action crash: %+v", e)
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			if tc.setup != nil {
				tc.setup(h)
			}
			h.crashAt(tc.op, func() reply { return tc.do(h) })
			tc.check(t, h.state())
			// The unanswered request can be retried and must not double-apply.
			before := h.state()
			if tc.op == "action" {
				r1 := h.post("/api/action", map[string]any{"id": "runner1", "zone": "east", "epoch": 0, "seq": 1, "delta": 7})
				r2 := h.post("/api/action", map[string]any{"id": "runner1", "zone": "east", "epoch": 0, "seq": 1, "delta": 7})
				if r1.status != 200 || string(r1.body) != string(r2.body) {
					t.Fatalf("retry after crash: %d %s", r1.status, r1.body)
				}
			}
			if tc.op == "commit" {
				r := h.post("/api/move", map[string]any{"op": "commit", "id": "runner1", "move": "h1"})
				if r.status != 200 {
					t.Fatalf("commit retry: %d %s", r.status, r.body)
				}
			}
			after := h.state()
			e1, e2 := entity(t, before, "runner1"), entity(t, after, "runner1")
			if tc.op == "action" && e1["value"] != e2["value"] {
				t.Fatalf("retry double-applied: %v -> %v", e1["value"], e2["value"])
			}
			if tc.op == "commit" && e1["epoch"] != e2["epoch"] {
				t.Fatalf("commit retry bumped the epoch twice: %v -> %v", e1["epoch"], e2["epoch"])
			}
		})
	}
}

func TestCorruptJournalRefusesStartup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "j.wal")
	eng, _, err := engine.Open(path, base)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		body, _, err := eng.Apply(engine.Req{Op: "action", ID: "runner1", Zone: "east", Epoch: 0, Seq: uint64(i), Delta: 1})
		if err != nil {
			t.Fatal(err)
		}
		_ = body
	}
	_ = eng.Close()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Corrupt a byte inside the second frame's payload.
	first := 4 + len(`{"op":"action","ts":0,"id":"runner1","seq":1,"delta":1,"zone":"east","epoch":0,"value":11,"resp":{"op":"action","id":"runner1","seq":1,"zone":"east","epoch":0,"delta":1,"value":11,"entity":{"id":"runner1","zone":"east","epoch":0,"seq":1,"value":11}}}`) + 4
	idx := first + 20
	b[idx] ^= 0xff
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := engine.Open(path, base); err == nil {
		t.Fatal("startup must fail on a corrupt middle frame")
	}
}

func TestTornTailRecoversOverHTTP(t *testing.T) {
	h := newHarness(t)
	h.post("/api/action", map[string]any{"id": "runner1", "zone": "east", "epoch": 0, "seq": 1, "delta": 4})
	h.srv.Close()
	_ = h.eng.Close()
	// Append a torn frame: 4-byte length of a large payload plus 3 bytes.
	f, err := os.OpenFile(h.path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Write([]byte{0x40, 0x00, 0x00, 0x00, '{', '"', 'x'})
	_ = f.Close()
	h.eng, h.srv = nil, nil
	h.start()
	st := h.state()
	rec := st["recovery"].(map[string]any)
	if rec["torn_tail"] != true {
		t.Fatalf("recovery %+v", rec)
	}
	e := entity(t, st, "runner1")
	if e["value"] != float64(14) {
		t.Fatalf("entity %+v", e)
	}
	// Writing continues cleanly after truncation.
	if r := h.post("/api/action", map[string]any{"id": "runner1", "zone": "east", "epoch": 0, "seq": 2, "delta": 1}); r.status != 200 {
		t.Fatalf("append after recovery: %d %s", r.status, r.body)
	}
	if got := entity(t, h.state(), "runner1"); got["value"] != float64(15) {
		t.Fatalf("entity %+v", got)
	}
}

func TestNoResponseBeforeFsync(t *testing.T) {
	// A successful response must only exist because a frame is durable: restart
	// immediately after each answer and confirm the state is already visible.
	h := newHarness(t)
	seq := 0
	for _, delta := range []int{1, 2, 3, 4, 5} {
		seq++
		r := h.post("/api/action", map[string]any{"id": "runner1", "zone": "east", "epoch": 0, "seq": seq, "delta": delta})
		if r.status != 200 {
			t.Fatalf("action %d: %d %s", seq, r.status, r.body)
		}
		var ar struct {
			Value int64 `json:"value"`
		}
		if err := json.Unmarshal(r.body, &ar); err != nil {
			t.Fatal(err)
		}
		h.restart()
		e := entity(t, h.state(), "runner1")
		if int64(e["value"].(float64)) != ar.Value || int64(e["seq"].(float64)) != int64(seq) {
			t.Fatalf("answered state lost after restart: ack value=%d, recovered=%+v", ar.Value, e)
		}
	}
}

var _ = sync.WaitGroup{}
