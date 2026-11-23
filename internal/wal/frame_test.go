package wal

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSubmitRejectsOversizeFrame(t *testing.T) {
	w, err := NewWriter(filepath.Join(t.TempDir(), "j.wal"), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if _, err := w.Submit([][]byte{make([]byte, MaxFrame+1)}); !errors.Is(err, ErrBadLength) {
		t.Fatalf("want ErrBadLength, got %v", err)
	}
	if _, err := w.Submit([][]byte{{}}); !errors.Is(err, ErrBadLength) {
		t.Fatalf("want ErrBadLength for empty frame, got %v", err)
	}
}

func TestEmptyLogReplay(t *testing.T) {
	dir := t.TempDir()
	res, err := Replay(filepath.Join(dir, "missing.wal"), func([]byte, int64) error { return nil })
	if err != nil || res.Frames != 0 {
		t.Fatalf("missing file must replay as empty: %+v %v", res, err)
	}
	p := filepath.Join(dir, "empty.wal")
	if err := os.WriteFile(p, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if res, err := Replay(p, func([]byte, int64) error { return nil }); err != nil || res.Frames != 0 {
		t.Fatalf("empty file: %+v %v", res, err)
	}
}

func TestTornTailWithinCRCOnly(t *testing.T) {
	// A frame missing only its CRC trailer is torn, not corrupt.
	p := filepath.Join(t.TempDir(), "j.wal")
	writeFrames(t, p, []byte(`{"a":1}`))
	full, _ := os.ReadFile(p)
	if err := os.WriteFile(p, full[:len(full)-1], 0o644); err != nil {
		t.Fatal(err)
	}
	n := 0
	res, err := Replay(p, func([]byte, int64) error { n++; return nil })
	// The whole incomplete frame is dropped, so recovery rewinds to the last
	// full-frame boundary rather than trying to salvage a payload.
	if err != nil || n != 0 || !res.TornFrame || res.Truncated != int64(len(full)-1) {
		t.Fatalf("n=%d res=%+v err=%v", n, res, err)
	}
}

func TestCloseUnderLoad(t *testing.T) {
	p := filepath.Join(t.TempDir(), "j.wal")
	w, err := NewWriter(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	const n = 2000
	done := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() {
			seq, err := w.Submit([][]byte{[]byte(`{"k":1}`)})
			if err == nil {
				err = w.Wait(seq)
			}
			done <- err
		}()
	}
	// Close while writes are in flight: it must flush, not drop frames.
	if err := w.Close(); err != nil {
		t.Fatalf("close under load: %v", err)
	}
	var ok, closed int
	for i := 0; i < n; i++ {
		if err := <-done; err != nil {
			closed++
		} else {
			ok++
		}
	}
	var count int
	if _, err := Replay(p, func([]byte, int64) error { count++; return nil }); err != nil {
		t.Fatal(err)
	}
	if count != ok || ok == 0 {
		t.Fatalf("journaled=%d acknowledged-ok=%d", count, ok)
	}
}
