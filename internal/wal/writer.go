package wal

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
	"os"
	"sync"
	"time"
)

// ErrClosed is returned after the writer has been closed.
var ErrClosed = errors.New("wal: writer closed")

// errShortWrite means the kernel accepted fewer bytes than requested.
var errShortWrite = errors.New("wal: short write")

// Writer appends frames in the on-disk format produced by EncodeFrame.
// Concurrent submitters are group-committed: each Submit is assigned a
// monotonically increasing frame sequence, a single background goroutine
// writes every queued frame and fsyncs once, and Wait(seq) unblocks once that
// frame is durable. A caller must not acknowledge success before Wait returns
// nil.
type Writer struct {
	f *os.File

	mu    sync.Mutex
	cond  *sync.Cond
	queue []*job
	// nextSeq is the last assigned frame sequence number.
	nextSeq uint64
	// durable is the last sequence number known to be fsynced.
	durable uint64
	// off is the durable end-of-file offset.
	off      int64
	writing  bool
	err      error
	closed   bool
	done     chan struct{}
	maxBatch int
	// coalesce is how long the writer lets frames accumulate before a batch.
	// Group commit amortises one fsync over every frame that arrived in this
	// window; it only adds latency when the queue is nearly empty.
	coalesce time.Duration
}

type job struct {
	frames [][]byte
	last   uint64
}

// NewWriter opens path for appending at size (the size after torn-tail
// truncation). A background writer performs the fsyncs.
func NewWriter(path string, size int64) (*Writer, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	if st, err := f.Stat(); err == nil {
		size = st.Size()
	}
	w := &Writer{f: f, off: size, maxBatch: 4096, coalesce: 250 * time.Microsecond, done: make(chan struct{})}
	w.cond = sync.NewCond(&w.mu)
	go w.loop()
	return w, nil
}

// Submit queues frames as one atomic journal write and returns the sequence
// number of the last frame (0 when frames is empty). Submission order equals
// sequence order, so callers that serialize submissions get journal order.
func (w *Writer) Submit(frames [][]byte) (uint64, error) {
	if len(frames) == 0 {
		return 0, nil
	}
	for _, p := range frames {
		if len(p) < 1 || len(p) > MaxFrame {
			return 0, ErrBadLength
		}
	}
	w.mu.Lock()
	if w.err != nil {
		err := w.err
		w.mu.Unlock()
		return 0, err
	}
	if w.closed {
		w.mu.Unlock()
		return 0, ErrClosed
	}
	w.nextSeq += uint64(len(frames))
	last := w.nextSeq
	w.queue = append(w.queue, &job{frames: frames, last: last})
	w.cond.Broadcast()
	w.mu.Unlock()
	return last, nil
}

// Wait blocks until every frame up to seq is durable, or the writer failed.
func (w *Writer) Wait(seq uint64) error {
	if seq == 0 {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for w.durable < seq && w.err == nil {
		if w.closed {
			return ErrClosed
		}
		w.cond.Wait()
	}
	if w.err != nil {
		return w.err
	}
	return nil
}

// Err reports a fatal write error, if any.
func (w *Writer) Err() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err
}

// Size returns the durable journal size in bytes.
func (w *Writer) Size() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.off
}

// Durable returns the last frame sequence known to be fsynced.
func (w *Writer) Durable() uint64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.durable
}

func (w *Writer) loop() {
	defer close(w.done)
	for {
		w.mu.Lock()
		for len(w.queue) == 0 && w.err == nil && !w.closed {
			w.cond.Wait()
		}
		if w.err != nil || (w.closed && len(w.queue) == 0) {
			w.mu.Unlock()
			return
		}
		small := len(w.queue) < w.maxBatch
		w.mu.Unlock()
		if small {
			// Brief window so concurrent submitters share this fsync.
			time.Sleep(w.coalesce)
		}
		w.mu.Lock()
		if w.err != nil {
			w.mu.Unlock()
			return
		}
		if len(w.queue) == 0 {
			// Close may have drained the queue; re-evaluate the exit condition.
			w.mu.Unlock()
			continue
		}
		batch := w.queue
		w.queue = nil
		w.writing = true
		base := w.off
		w.mu.Unlock()

		err := w.writeBatch(base, batch)

		w.mu.Lock()
		w.writing = false
		if err == nil {
			w.off = base + batchBytes(batch)
			if last := batch[len(batch)-1].last; last > w.durable {
				w.durable = last
			}
		} else {
			w.err = err
		}
		w.cond.Broadcast()
		w.mu.Unlock()
		if err != nil {
			return
		}
	}
}

func batchBytes(batch []*job) int64 {
	var n int64
	for _, j := range batch {
		for _, p := range j.frames {
			n += FrameLen(len(p))
		}
	}
	return n
}

func (w *Writer) writeBatch(base int64, batch []*job) error {
	total := int(batchBytes(batch))
	buf := make([]byte, 0, total)
	for _, j := range batch {
		for _, p := range j.frames {
			buf = appendFrame(buf, p)
		}
	}
	n, err := w.f.WriteAt(buf, base)
	if err == nil && n != len(buf) {
		err = errShortWrite
	}
	if err == nil {
		err = w.f.Sync()
	}
	if err != nil {
		// Roll the tail back so no partial frame survives in the live file.
		_ = w.f.Truncate(base)
		return err
	}
	return nil
}

func appendFrame(dst, payload []byte) []byte {
	var hdr [lenPrefix]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(payload)))
	var crc [crcSuffix]byte
	binary.LittleEndian.PutUint32(crc[:], crc32.ChecksumIEEE(payload))
	dst = append(dst, hdr[:]...)
	dst = append(dst, payload...)
	dst = append(dst, crc[:]...)
	return dst
}

// Close drains and flushes queued frames, then closes the file. It fails if
// frames remain unflushed or the writer already failed.
func (w *Writer) Close() error {
	w.mu.Lock()
	for (len(w.queue) > 0 || w.writing) && w.err == nil {
		w.cond.Wait()
	}
	w.closed = true
	pending := w.nextSeq > w.durable
	err := w.err
	w.cond.Broadcast()
	w.mu.Unlock()

	<-w.done
	if err != nil {
		_ = w.f.Close()
		return err
	}
	if pending {
		_ = w.f.Close()
		return ErrClosed
	}
	return w.f.Close()
}
