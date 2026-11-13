package media

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"vod-hls-server/internal/model"
)

// TranscodeSpec 描述一次转码任务所需的全部输入参数。
type TranscodeSpec struct {
	Source         string        // 源文件绝对路径
	OutputDir      string        // .tmp 输出目录（调用方负责创建）
	Rungs          []model.Rung  // 已定档的码率阶梯
	HasAudio       bool          // 源是否含音频
	FrameRate      float64       // 源帧率，用于计算 GOP 长度
	SegmentSeconds int           // 分片目标时长（秒）
}

// BuildFFmpegArgs 按规范生成多 variant 单命令的 ffmpeg 参数。
// 设计要点：一次解码多路输出、各档独立音频映射、关键帧按分片边界对齐、点播 playlist、MPEG-TS 分片。
func BuildFFmpegArgs(spec TranscodeSpec) ([]string, error) {
	if len(spec.Rungs) == 0 {
		return nil, fmt.Errorf("转码档位为空，无法构建 ffmpeg 命令")
	}
	if spec.SegmentSeconds <= 0 {
		return nil, fmt.Errorf("分片时长非法: %d", spec.SegmentSeconds)
	}

	// Windows 路径统一转正斜杠：反斜杠在 filter/文件名中有转义风险
	src := filepath.ToSlash(spec.Source)
	outDir := filepath.ToSlash(spec.OutputDir)
	segmentPattern := outDir + "/v_%v_%05d.ts"
	playlistPattern := outDir + "/v_%v.m3u8"

	args := []string{
		"-nostats",      // 关闭 stderr 统计行，进度只看 -progress
		"-hide_banner",  // 减少噪音日志
		"-y",            // 覆盖输出（.tmp 目录内无冲突）
		"-i", src,
	}

	// filter_complex：每档一路缩放，-2 保证宽度自动取偶数；档位已经过禁升档过滤，不会放大
	var filters []string
	for i, r := range spec.Rungs {
		filters = append(filters, fmt.Sprintf("[0:v]scale=-2:%d[v%d]", r.Height, i))
	}
	args = append(args, "-filter_complex", strings.Join(filters, ";"))

	// 映射：每档视频后紧跟一路独立音频（无音频源只映射视频）
	for i := range spec.Rungs {
		args = append(args, "-map", fmt.Sprintf("[v%d]", i))
		if spec.HasAudio {
			args = append(args, "-map", "0:a:0")
		}
	}

	// 通用视频编码参数
	args = append(args,
		"-c:v", "libx264",
		"-preset", "veryfast",
		"-pix_fmt", "yuv420p",
		// 让各档关键帧严格落在分片边界上，ABR 切换才平滑
		"-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%d)", spec.SegmentSeconds),
		"-sc_threshold", "0",
	)
	// GOP 长度按帧率×分片时长计算（24fps、6s -> 144）
	if spec.FrameRate > 0 {
		gop := int(spec.FrameRate*float64(spec.SegmentSeconds) + 0.5)
		if gop < 1 {
			gop = 1
		}
		args = append(args, "-g", strconv.Itoa(gop), "-keyint_min", strconv.Itoa(gop))
	}

	// 通用音频编码参数；本机 ffmpeg 无 libfdk_aac，使用原生 AAC 编码器
	if spec.HasAudio {
		args = append(args,
			"-c:a", "aac",
			"-b:a", "128k",
			"-ar", "48000",
			"-ac", "2",
		)
	}

	// 每档独立码控参数：单遍 ABR + 适度上限与缓冲，内网培训场景无需 two-pass
	for i, r := range spec.Rungs {
		br := r.VideoBitrate
		maxrate := int64(float64(br) * 1.07) // 峰值码率上浮 7%
		bufsize := br * 3 / 2                // 缓冲约为目标码率 1.5 倍
		args = append(args,
			"-b:v:"+strconv.Itoa(i), strconv.FormatInt(br, 10),
			"-maxrate:v:"+strconv.Itoa(i), strconv.FormatInt(maxrate, 10),
			"-bufsize:v:"+strconv.Itoa(i), strconv.FormatInt(bufsize, 10),
		)
		if spec.HasAudio {
			args = append(args, "-b:a:"+strconv.Itoa(i), strconv.FormatInt(r.AudioBitrate, 10))
		}
	}

	// HLS 封装参数
	args = append(args,
		"-f", "hls",
		"-hls_time", strconv.Itoa(spec.SegmentSeconds),
		"-hls_playlist_type", "vod", // 点播 playlist，结尾带 #EXT-X-ENDLIST，避免 hls.js 按直播轮询
		"-hls_list_size", "0",       // 保留全部分片
		"-hls_flags", "independent_segments+temp_file", // 分片独立可切换 + 先写临时文件再原子改名
		"-hls_segment_type", "mpegts",
		"-hls_segment_filename", segmentPattern,
	)

	// var_stream_map：把每档的视频/音频流编号绑定成一个 variant
	var streamMap []string
	for i := range spec.Rungs {
		if spec.HasAudio {
			streamMap = append(streamMap, fmt.Sprintf("v:%d,a:%d", i, i))
		} else {
			streamMap = append(streamMap, fmt.Sprintf("v:%d", i))
		}
	}
	args = append(args, "-var_stream_map", strings.Join(streamMap, " "))

	// 机读进度输出到 stdout，runner 据此计算百分比
	args = append(args,
		"-progress", "pipe:1",
		playlistPattern,
	)
	return args, nil
}
