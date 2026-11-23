package wal

import (
	"path/filepath"
	"sync"
	"testing"
)

// BenchmarkWriterGroupCommit measures group commit throughput. Run with:
//
//	go test ./internal/wal -bench WriterGroupCommit -benchtime 20000x
func BenchmarkWriterGroupCommit(b *testing.B) {
	for _, workers := range []int{1, 16, 64} {
		b.Run(workerName(workers), func(b *testing.B) {
			dir := b.TempDir()
			w, err := NewWriter(filepath.Join(dir, "j.wal"), 0)
			if err != nil {
				b.Fatal(err)
			}
			defer w.Close()
			payload := []byte(`{"op":"action","id":"runner1","seq":1000,"delta":1,"zone":"east","epoch":0,"value":11}`)
			var wg sync.WaitGroup
			per := b.N / workers
			b.ResetTimer()
			for i := 0; i < workers; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					for j := 0; j < per; j++ {
						seq, err := w.Submit([][]byte{payload})
						if err != nil {
							b.Error(err)
							return
						}
						if err := w.Wait(seq); err != nil {
							b.Error(err)
							return
						}
					}
				}()
			}
			wg.Wait()
		})
	}
}

func workerName(n int) string {
	switch n {
	case 1:
		return "workers=1"
	case 16:
		return "workers=16"
	default:
		return "workers=64"
	}
}
