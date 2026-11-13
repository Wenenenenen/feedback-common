package media

import (
	"bytes"
	"sync"
)

// LogTail 是线程安全的定长环形缓冲，只保留最近 maxBytes 字节的 ffmpeg stderr，
// 失败时写入 jobs.ffmpeg_log_tail 供管理页排障，避免日志无限膨胀。
type LogTail struct {
	mu       sync.Mutex
	buf      []byte
	maxBytes int
}

// NewLogTail 创建容量为 maxBytes 的日志缓冲。
func NewLogTail(maxBytes int) *LogTail {
	if maxBytes <= 0 {
		maxBytes = 64 * 1024
	}
	return &LogTail{maxBytes: maxBytes}
}

// Write 实现 io.Writer，超容量时丢弃最旧数据。
func (l *LogTail) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.buf = append(l.buf, p...)
	if len(l.buf) > l.maxBytes {
		// 保留末尾 maxBytes，并尽量从换行边界截断，避免半行乱码
		cut := len(l.buf) - l.maxBytes
		if idx := bytes.IndexByte(l.buf[cut:], '\n'); idx >= 0 {
			cut += idx + 1
		}
		l.buf = append([]byte(nil), l.buf[cut:]...)
	}
	return len(p), nil
}

// String 返回当前缓冲内容的字符串副本。
func (l *LogTail) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return string(l.buf)
}
