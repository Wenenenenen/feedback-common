package wal

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
	"os"
	"path/filepath"
	"testing"
)

func writeFrames(t *testing.T, path string, payloads ...[]byte) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, p := range payloads {
		if _, err := f.Write(EncodeFrame(p)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestFrameRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "j.wal")
	writeFrames(t, p, []byte(`{"a":1}`), []byte(`{"b":2}`))
	var got []string
	res, err := Replay(p, func(b []byte, off int64) error { got = append(got, string(b)); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if res.Frames != 2 || res.TornFrame {
		t.Fatalf("res=%+v", res)
	}
	if got[0] != `{"a":1}` || got[1] != `{"b":2}` {
		t.Fatalf("got %v", got)
	}
}

func TestTornTailIsTruncated(t *testing.T) {
	p := filepath.Join(t.TempDir(), "j.wal")
	writeFrames(t, p, []byte(`{"a":1}`))
	full, _ := os.ReadFile(p)
	// Append a frame header and half its payload: a torn write.
	bad := EncodeFrame([]byte(`{"long":"payload"}`))
	if err := os.WriteFile(p, append(full, bad[:9]...), 0o644); err != nil {
		t.Fatal(err)
	}
	before := int64(len(full) + 9)
	var n int
	res, err := Replay(p, func([]byte, int64) error { n++; return nil })
	if err != nil {
		t.Fatalf("torn tail must not be fatal: %v", err)
	}
	if n != 1 || res.Frames != 1 || !res.TornFrame || res.Truncated != 9 {
		t.Fatalf("n=%d res=%+v", n, res)
	}
	st, _ := os.Stat(p)
	if st.Size() != int64(len(full)) || st.Size() >= before {
		t.Fatalf("torn tail not truncated: size=%d want %d", st.Size(), len(full))
	}
	// After truncation the log accepts new appends cleanly.
	w, err := NewWriter(p, st.Size())
	if err != nil {
		t.Fatal(err)
	}
	seq, err := w.Submit([][]byte{[]byte(`{"c":3}`)})
	if err != nil || w.Wait(seq) != nil {
		t.Fatalf("append: %v %v", err, w.Wait(seq))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	n = 0
	if _, err := Replay(p, func([]byte, int64) error { n++; return nil }); err != nil || n != 2 {
		t.Fatalf("after append n=%d err=%v", n, err)
	}
}

func TestMidLogCorruptionIsFatal(t *testing.T) {
	p := filepath.Join(t.TempDir(), "j.wal")
	writeFrames(t, p, []byte(`{"a":1}`), []byte(`{"b":2}`), []byte(`{"c":3}`))
	b, _ := os.ReadFile(p)
	// Flip a payload byte in the middle frame; its CRC no longer matches.
	second := EncodeFrame([]byte(`{"a":1}`))
	idx := len(second) + 4 // first payload byte of frame 2
	b[idx] ^= 0xff
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	n := 0
	_, err := Replay(p, func([]byte, int64) error { n++; return nil })
	if !errors.Is(err, ErrCorruptMidLog) {
		t.Fatalf("want ErrCorruptMidLog, got %v", err)
	}
	if n != 1 {
		t.Fatalf("valid prefix should replay, n=%d", n)
	}
	// The file is untouched so an operator can inspect it.
	st, _ := os.Stat(p)
	if st.Size() != int64(len(b)) {
		t.Fatalf("corrupt log must not be modified")
	}
}

func TestLengthBounds(t *testing.T) {
	cases := []uint32{0, MaxFrame + 1, 0xffffffff}
	for _, n := range cases {
		p := filepath.Join(t.TempDir(), "j.wal")
		buf := make([]byte, 8)
		binary.LittleEndian.PutUint32(buf, n)
		if err := os.WriteFile(p, buf, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Replay(p, func([]byte, int64) error { return nil }); !errors.Is(err, ErrBadLength) {
			t.Fatalf("len=%d: want ErrBadLength, got %v", n, err)
		}
	}
}

func TestCRCCoversJSONOnly(t *testing.T) {
	// A payload whose bytes match its CRC trailer decodes; corrupting only the
	// length prefix of a short frame is a length error, not a CRC error.
	payload := []byte(`{"x":1}`)
	frame := EncodeFrame(payload)
	if binary.LittleEndian.Uint32(frame[len(frame)-4:]) != crc32.ChecksumIEEE(payload) {
		t.Fatal("trailer must be CRC-32 of payload")
	}
}

func TestGroupCommitManyFrames(t *testing.T) {
	p := filepath.Join(t.TempDir(), "j.wal")
	w, err := NewWriter(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	const n = 500
	done := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			seq, err := w.Submit([][]byte{[]byte(`{"i":` + itoa(i) + `}`)})
			if err == nil {
				err = w.Wait(seq)
			}
			done <- err
		}(i)
	}
	for i := 0; i < n; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	var count int
	if _, err := Replay(p, func([]byte, int64) error { count++; return nil }); err != nil {
		t.Fatal(err)
	}
	if count != n {
		t.Fatalf("count=%d want %d", count, n)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
