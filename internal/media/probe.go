package media

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	"vod-hls-server/internal/model"
)

// ffprobeOutput 对应 ffprobe -print_format json -show_format -show_streams 的输出结构，仅保留需要的字段。
type ffprobeOutput struct {
	Streams []ffprobeStream `json:"streams"`
	Format  ffprobeFormat   `json:"format"`
}

type ffprobeStream struct {
	CodecType  string `json:"codec_type"`
	CodecName  string `json:"codec_name"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Duration   string `json:"duration"`
	BitRate    string `json:"bit_rate"`
	AvgFrameRt string `json:"avg_frame_rate"`
	RFrameRt   string `json:"r_frame_rate"`
}

type ffprobeFormat struct {
	Duration string `json:"duration"`
	BitRate  string `json:"bit_rate"`
	Size     string `json:"size"`
}

// Probe 调用 ffprobe 解析源视频的关键媒体信息；找不到视频流时返回错误。
func Probe(ctx context.Context, ffprobePath, source string) (model.MediaInfo, error) {
	cmd := exec.CommandContext(ctx, ffprobePath,
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		source)
	raw, err := cmd.Output()
	if err != nil {
		return model.MediaInfo{}, fmt.Errorf("ffprobe 执行失败: %w", err)
	}

	var out ffprobeOutput
	if err := json.Unmarshal(raw, &out); err != nil {
		return model.MediaInfo{}, fmt.Errorf("解析 ffprobe 输出失败: %w", err)
	}

	var (
		video   *ffprobeStream
		hasAud  bool
		info    model.MediaInfo
	)
	for i := range out.Streams {
		st := &out.Streams[i]
		switch st.CodecType {
		case "video":
			// 只认第一条视频流，封面图等附加流忽略
			if video == nil && st.Width > 0 && st.Height > 0 {
				video = st
			}
		case "audio":
			hasAud = true
		}
	}
	if video == nil {
		return model.MediaInfo{}, fmt.Errorf("源文件中没有可识别的视频流")
	}

	info.Width = video.Width
	info.Height = video.Height
	info.HasAudio = hasAud
	info.FrameRate = parseFrameRate(video.AvgFrameRt, video.RFrameRt)

	// 时长优先取容器 format，其次视频流
	info.DurationSec = firstPositiveFloat(out.Format.Duration, video.Duration)
	if info.DurationSec <= 0 {
		return model.MediaInfo{}, fmt.Errorf("无法解析视频时长，文件可能已损坏")
	}

	// 码率探测存在较多缺失场景，按 视频流 -> 总码率 -> 各流求和 -> 文件大小估算 的顺序兜底
	info.VideoBR = parseInt64(video.BitRate)
	info.TotalBR = parseInt64(out.Format.BitRate)
	if info.TotalBR <= 0 {
		var sum int64
		for i := range out.Streams {
			sum += parseInt64(out.Streams[i].BitRate)
		}
		info.TotalBR = sum
	}
	if info.TotalBR <= 0 {
		if size := parseInt64(out.Format.Size); size > 0 && info.DurationSec > 0 {
			info.TotalBR = int64(float64(size*8) / info.DurationSec)
		}
	}
	return info, nil
}

// parseFrameRate 解析 ffmpeg 的分数帧率（如 "24/1"、"30000/1001"），分子为 0 时回退到 r_frame_rate。
func parseFrameRate(avg, rfr string) float64 {
	if v := parseRatio(avg); v > 0 {
		return v
	}
	return parseRatio(rfr)
}

// parseRatio 解析 "num/den" 形式的分数为浮点数。
func parseRatio(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	parts := strings.SplitN(s, "/", 2)
	num, err := strconv.ParseFloat(parts[0], 64)
	if err != nil || num <= 0 {
		return 0
	}
	if len(parts) == 1 {
		return num
	}
	den, err := strconv.ParseFloat(parts[1], 64)
	if err != nil || den <= 0 {
		return 0
	}
	return num / den
}

// parseInt64 解析整型字符串，非法或空值返回 0。
func parseInt64(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}

// firstPositiveFloat 返回第一个能解析为正数的字符串值。
func firstPositiveFloat(vals ...string) float64 {
	for _, v := range vals {
		if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && f > 0 {
			return f
		}
	}
	return 0
}
