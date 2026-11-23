// Package wal implements the append-only, CRC-framed journal described in
// samples/zone-handoff.json. It is deliberately self-contained: no external
// logging or transaction engine is involved.
//
// Frame layout: uint32 LE JSON length | JSON bytes | uint32 LE IEEE CRC-32 of
// the JSON only. Length must be in [1, 16777216]. A frame whose tail is missing
// or short is a torn write and is discarded on recovery. A frame that is fully
// present but fails CRC aborts recovery: we never silently drop committed data.
package wal

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
)

const (
	lenPrefix = 4
	crcSuffix = 4
	// MaxFrame bounds the JSON payload per frame.
	MaxFrame = 16777216
)

var (
	// ErrCorruptMidLog means a complete frame failed validation while more
	// frames follow (or the frame is structurally impossible). Startup must fail.
	ErrCorruptMidLog = errors.New("wal: corrupt frame in middle of log")
	// ErrBadLength means a length prefix is outside [1, MaxFrame].
	ErrBadLength = errors.New("wal: frame length out of range")
)

// OpenResult reports what recovery found.
type OpenResult struct {
	Frames    int
	Truncated int64 // bytes dropped from a torn tail
	TornFrame bool
	FileSize  int64 // durable size after any truncation
}

// Replay reads every complete frame, invoking fn in write order. A torn tail is
// truncated to the last complete frame. A fully present frame with a bad CRC,
// or an impossible length, returns ErrCorruptMidLog and leaves the file
// untouched. fn is only called for frames that pass validation.
func Replay(path string, fn func(payload []byte, offset int64) error) (OpenResult, error) {
	var res OpenResult
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return res, nil
		}
		return res, err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return res, err
	}
	total := st.Size()

	r := newFrameReader(f, total)
	for {
		payload, off, err := r.next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				res.FileSize = off
				return res, nil
			}
			if errors.Is(err, errTornTail) {
				if err := f.Close(); err != nil {
					return res, err
				}
				if err := os.Truncate(path, off); err != nil {
					return res, fmt.Errorf("wal: truncate torn tail: %w", err)
				}
				res.Truncated = total - off
				res.TornFrame = true
				res.FileSize = off
				return res, nil
			}
			return res, err
		}
		if err := fn(payload, off); err != nil {
			return res, err
		}
		res.Frames++
	}
}

var errTornTail = errors.New("wal: torn tail")

type frameReader struct {
	f     *os.File
	pos   int64
	total int64
	buf   []byte
}

func newFrameReader(f *os.File, total int64) *frameReader {
	return &frameReader{f: f, total: total, buf: make([]byte, 0, 64*1024)}
}

// next returns the payload and its offset, then advances. If fewer bytes than a
// frame remain, it returns errTornTail with the offset of the last good
// boundary.
func (r *frameReader) next() ([]byte, int64, error) {
	start := r.pos
	remaining := r.total - r.pos
	if remaining == 0 {
		return nil, start, io.EOF
	}
	if remaining < lenPrefix {
		return nil, start, errTornTail
	}
	var lp [lenPrefix]byte
	if _, err := r.f.ReadAt(lp[:], r.pos); err != nil {
		return nil, start, errTornTail
	}
	n := int64(binary.LittleEndian.Uint32(lp[:]))
	if n < 1 || n > MaxFrame {
		return nil, start, fmt.Errorf("%w at offset %d: %d", ErrBadLength, start, n)
	}
	frameLen := lenPrefix + n + crcSuffix
	if remaining < frameLen {
		return nil, start, errTornTail
	}
	if int64(cap(r.buf)) < n {
		r.buf = make([]byte, n)
	}
	buf := r.buf[:n]
	if _, err := r.f.ReadAt(buf, r.pos+lenPrefix); err != nil {
		return nil, start, errTornTail
	}
	var cp [crcSuffix]byte
	if _, err := r.f.ReadAt(cp[:], r.pos+lenPrefix+n); err != nil {
		return nil, start, errTornTail
	}
	want := binary.LittleEndian.Uint32(cp[:])
	if got := crc32.ChecksumIEEE(buf); got != want {
		return nil, start, fmt.Errorf("%w at offset %d: crc %08x != %08x", ErrCorruptMidLog, start, got, want)
	}
	r.pos += frameLen
	return buf, start, nil
}

// FrameLen is the on-disk size of a frame carrying an n-byte payload.
func FrameLen(n int) int64 { return int64(lenPrefix + n + crcSuffix) }

// EncodeFrame returns the on-disk bytes for payload.
func EncodeFrame(payload []byte) []byte {
	buf := make([]byte, lenPrefix+len(payload)+crcSuffix)
	binary.LittleEndian.PutUint32(buf, uint32(len(payload)))
	copy(buf[lenPrefix:], payload)
	binary.LittleEndian.PutUint32(buf[lenPrefix+len(payload):], crc32.ChecksumIEEE(payload))
	return buf
}

// PayloadCRC returns the CRC-32 that belongs in the frame trailer.
func PayloadCRC(payload []byte) uint32 { return crc32.ChecksumIEEE(payload) }

// PathSize returns the current size of path, or 0 if absent.
func PathSize(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.Size()
}

// EnsureDir creates the parent directory of path.
func EnsureDir(path string) error {
	return os.MkdirAll(filepath.Dir(path), 0o755)
}
