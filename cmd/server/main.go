// Command server runs the zone-handoff drill service and web UI.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"zonehandoff/internal/engine"
	"zonehandoff/internal/server"
)

// sampleFile mirrors samples/zone-handoff.json (only the parts we seed from).
type sampleFile struct {
	Entities []engine.InitialEntity `json:"entities"`
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data-dir", "data", "directory for the journal")
	journal := flag.String("journal", "", "explicit journal path (overrides -data-dir)")
	sample := flag.String("sample", "samples/zone-handoff.json", "sample file providing baseline entities")
	logPath := flag.String("log", "", "log file; empty logs to stderr")
	flag.Parse()

	logger := log.New(os.Stderr, "zone-handoff ", log.LstdFlags|log.Lmicroseconds)
	if *logPath != "" {
		f, err := os.OpenFile(*logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			logger.Fatalf("open log file: %v", err)
		}
		defer f.Close()
		logger = log.New(f, "", log.LstdFlags|log.Lmicroseconds)
	}

	baseline, err := loadBaseline(*sample)
	if err != nil {
		logger.Fatalf("load sample: %v", err)
	}

	path := *journal
	if path == "" {
		if err := os.MkdirAll(*dataDir, 0o755); err != nil {
			logger.Fatalf("create data dir: %v", err)
		}
		path = filepath.Join(*dataDir, "journal.wal")
	}

	eng, info, err := engine.Open(path, baseline)
	if err != nil {
		// A corrupt frame must stop startup; never serve partial state.
		logger.Fatalf("recover journal %s: %v", path, err)
	}
	logger.Printf("journal %s: replayed %d frames, entities=%d, torn_tail=%v truncated=%dB, size=%dB",
		path, info.Frames, info.Entities, info.TornTail, info.Truncated, info.JournalBytes)

	opts := server.Options{Baseline: baseline, Logger: logger}
	opts.CrashExit = func() {
		// Die abruptly: no response was written for the crashing request.
		_ = os.Stderr.Sync()
		os.Exit(71)
	}
	eng.SetCrashHook(func(op string) {
		// Every frame of this request is already fsynced, so exiting now
		// leaves durable state and no reply. Do not close: die abruptly.
		logger.Printf("simulated crash at %q: frame durable, exiting without reply", op)
		_ = os.Stderr.Sync()
		os.Exit(71)
	})

	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.New(eng, info, opts).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		logger.Printf("listening on %s (journal=%s)", *addr, path)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	size := eng.JournalSize()
	_ = srv.Shutdown(ctx)
	if err := eng.Close(); err != nil {
		logger.Printf("close journal: %v", err)
	}
	logger.Printf("stopped cleanly; journal %d bytes", size)
}

func loadBaseline(path string) ([]engine.InitialEntity, error) {
	if path == "" {
		return []engine.InitialEntity{{ID: "runner1", Zone: "east", Value: 10}}, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var sf sampleFile
	if err := json.Unmarshal(b, &sf); err != nil {
		return nil, err
	}
	if len(sf.Entities) == 0 {
		return nil, errors.New("sample has no entities")
	}
	return sf.Entities, nil
}
