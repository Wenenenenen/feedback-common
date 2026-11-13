package media

import (
	"bufio"
	"io"
	"strconv"
	"strings"
)

// ProgressUpdate 是一次进度回调的内容。
type ProgressUpdate struct {
	// Percent 0..99（只有进程正常结束后由调用方置 100）
	Percent int
	// OutTimeMS ffmpeg 已处理时长（毫秒）
	OutTimeMS int64
	// Ended 是否收到 progress=end
	Ended bool
}

// ParseProgress 读取 ffmpeg `-progress pipe:1` 的 key=value 机读输出并回调。
// 每组以 progress=continue/progress=end 结束；百分比按 out_time_us 与总时长计算。
// 该函数阻塞读到 EOF 后返回，应在独立 goroutine 中运行。
func ParseProgress(r io.Reader, durationSec float64, onUpdate func(ProgressUpdate)) error {
	scanner := bufio.NewScanner(r)
	// ffmpeg 单行很短，放大缓冲防止极端情况下切包
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var (
		outTimeUS int64
		ended     bool
	)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "out_time_us":
			// 注意：out_time_ms 在部分版本语义实际是微秒，统一只信 out_time_us
			outTimeUS, _ = strconv.ParseInt(value, 10, 64)
		case "progress":
			ended = value == "end"
			percent := 0
			if durationSec > 0 && outTimeUS > 0 {
				percent = int(float64(outTimeUS) / 1_000_000 / durationSec * 100)
				if percent > 99 {
					percent = 99 // 未确认进程退出码前不提前报 100
				}
				if percent < 0 {
					percent = 0
				}
			}
			if onUpdate != nil {
				onUpdate(ProgressUpdate{
					Percent:   percent,
					OutTimeMS: outTimeUS / 1_000,
					Ended:     ended,
				})
			}
		}
	}
	return scanner.Err()
}
