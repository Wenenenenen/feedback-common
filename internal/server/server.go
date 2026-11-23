// Package server exposes the engine over HTTP and serves the drill web UI.
package server

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"zonehandoff/internal/engine"
)

// Options configures the HTTP server.
type Options struct {
	Baseline []engine.InitialEntity
	// CrashExit makes an armed crash terminate the process. Tests may replace
	// it to observe the hook without exiting.
	CrashExit func()
	Logger    *log.Logger
}

// Server binds the engine to HTTP.
type Server struct {
	eng      *engine.Engine
	opts     Options
	mu       sync.Mutex
	recovery engine.RecoveryInfo
	booted   time.Time
}

// New creates a Server around eng.
func New(eng *engine.Engine, info engine.RecoveryInfo, opts Options) *Server {
	if opts.CrashExit == nil {
		opts.CrashExit = func() { os.Exit(71) }
	}
	if opts.Logger == nil {
		opts.Logger = log.New(os.Stderr, "zone-handoff ", log.LstdFlags|log.Lmicroseconds)
	}
	return &Server{eng: eng, opts: opts, recovery: info, booted: time.Now()}
}

// Handler returns the full route table.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/state", s.handleState)
	mux.HandleFunc("/api/action", s.handleAction)
	mux.HandleFunc("/api/move", s.handleMove)
	mux.HandleFunc("/api/batch", s.handleBatch)
	mux.HandleFunc("/api/log", s.handleLog)
	mux.HandleFunc("/api/crash", s.handleCrash)
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/", s.handleIndex)
	return withHeaders(mux)
}

func withHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		http.Error(w, `{"code":"internal"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func writeErr(w http.ResponseWriter, err *engine.Error) {
	writeJSON(w, err.Status, map[string]any{"error": err})
}

// readBody decodes a JSON body of at most 32 MiB.
func readBody(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 32<<20))
	return dec.Decode(v)
}

// run executes one engine call and answers it, unless an armed crash fires:
// in that case the process must die with no response on the wire.
func (s *Server) run(w http.ResponseWriter, op string, req engine.Req) {
	body, crash, err := s.eng.Apply(req)
	if crash {
		// The frame is durable but no byte of a reply has been written. This
		// mimics a process that dies between commit and response.
		s.opts.Logger.Printf("crash point %q reached after durable append; exiting with no reply", op)
		s.opts.CrashExit()
		return
	}
	if err != nil {
		var e *engine.Error
		if errors.As(err, &e) {
			writeErr(w, e)
			return
		}
		writeErr(w, &engine.Error{Status: 500, Code: "internal", Message: err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(body)
}

func (s *Server) handleAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", 405)
		return
	}
	var req engine.Req
	if err := readBody(r, &req); err != nil {
		writeErr(w, &engine.Error{Status: 400, Code: "bad_request", Message: "invalid json: " + err.Error()})
		return
	}
	req.Op = "action"
	s.run(w, "action", req)
}

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", 405)
		return
	}
	var req engine.Req
	if err := readBody(r, &req); err != nil {
		writeErr(w, &engine.Error{Status: 400, Code: "bad_request", Message: "invalid json: " + err.Error()})
		return
	}
	switch req.Op {
	case "begin", "confirm", "commit", "abort":
	default:
		writeErr(w, &engine.Error{Status: 400, Code: "bad_request", Message: "op must be begin|confirm|commit|abort"})
		return
	}
	s.run(w, req.Op, req)
}

func (s *Server) handleBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", 405)
		return
	}
	var body struct {
		Items []engine.BatchItem `json:"items"`
	}
	if err := readBody(r, &body); err != nil {
		writeErr(w, &engine.Error{Status: 400, Code: "bad_request", Message: "invalid json: " + err.Error()})
		return
	}
	raw, err := json.Marshal(body.Items)
	if err != nil {
		writeErr(w, &engine.Error{Status: 400, Code: "bad_request", Message: err.Error()})
		return
	}
	s.run(w, "batch", engine.Req{Op: "batch", ItemsRaw: raw})
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	entities := s.eng.Entities()
	moves := s.eng.Moves()
	info := s.recovery
	writeJSON(w, 200, map[string]any{
		"entities":       entities,
		"moves":          moves,
		"recovery":       info,
		"crash_point":    s.eng.CrashPoint(),
		"journal_bytes":  s.eng.JournalSize(),
		"uptime_seconds": int64(time.Since(s.booted).Seconds()),
	})
}

func (s *Server) handleLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from := atoiOr(q.Get("from"), 0)
	limit := atoiOr(q.Get("limit"), 200)
	if limit <= 0 || limit > 5000 {
		limit = 5000
	}
	if q.Get("from") == "" || from < 0 {
		// Negative "from" means "tail": the last `limit` records.
		from = s.eng.LogCount() - limit
		if from < 0 {
			from = 0
		}
	}
	recs, total := s.eng.LogPage(from, limit)
	writeJSON(w, 200, map[string]any{"total": total, "from": from, "records": recs})
}

func atoiOr(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

func (s *Server) handleCrash(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, map[string]any{"crash_point": s.eng.CrashPoint()})
	case http.MethodPost:
		var body struct {
			Op string `json:"op"`
		}
		if err := readBody(r, &body); err != nil {
			writeErr(w, &engine.Error{Status: 400, Code: "bad_request", Message: err.Error()})
			return
		}
		switch body.Op {
		case "", "none":
			s.eng.SetCrashPoint("")
		case "action", "begin", "confirm", "commit", "abort":
			s.eng.SetCrashPoint(body.Op)
		default:
			writeErr(w, &engine.Error{Status: 400, Code: "bad_request", Message: "unknown crash op " + body.Op})
			return
		}
		writeJSON(w, 200, map[string]any{"crash_point": s.eng.CrashPoint()})
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", 405)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": s.eng.Failed() == nil, "journal_bytes": s.eng.JournalSize()})
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(indexHTML)
}
