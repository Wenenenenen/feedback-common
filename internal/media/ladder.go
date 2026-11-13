package media

import (
	"math"
	"strconv"

	"vod-hls-server/internal/model"
)

// 固定码率阶梯模板：高度 -> 视频码率（bps）。只描述"理想模板"，实际输出还要经过禁升档与码率封顶。
var ladderTemplate = []struct {
	Height       int
	VideoBitrate int64
}{
	{360, 800_000},
	{480, 1_200_000},
	{720, 2_500_000},
	{1080, 5_000_000},
}

const (
	// audioBitrate 统一音频码率 128kbps
	audioBitrate int64 = 128_000
	// minVideoBitrateFloor 视频码率地板，低于该值的非最低档直接丢弃（压到这么低已无观看价值）
	minVideoBitrateFloor int64 = 200_000
	// minSafeVideoBitrate 总码率减去音频后所剩下限，避免源片码率探测异常时算出接近 0 的目标码率
	minSafeVideoBitrate int64 = 100_000
)

// BuildLadder 根据源片探测信息决定实际转码档位（纯函数，便于表驱动单测）。
//
// 规则：
//  1. 禁升分辨率：高度大于源高的模板档一律剔除，720p 源绝不会产出 1080p；
//  2. 码率封顶而非丢档：每档目标视频码率不超过源视频码率与源总码率扣除音频后的余量，
//     避免对低码率源做无意义的"高码率转码"；
//  3. 封顶后低于地板的档位丢弃，但最低档始终保留，保证任何源都至少有一条可播流；
//  4. 源高不在模板上（如 540p）时，追加一个与源同高的顶级档，原片清晰度不丢。
func BuildLadder(info model.MediaInfo) []model.Rung {
	if info.Width <= 0 || info.Height <= 0 {
		return nil
	}

	// 第一步：收集高度不超过源高的模板档
	type candidate struct {
		height       int
		videoBitrate int64
	}
	candidates := make([]candidate, 0, len(ladderTemplate)+1)
	for _, t := range ladderTemplate {
		if t.Height <= info.Height {
			candidates = append(candidates, candidate{t.Height, t.VideoBitrate})
		}
	}

	// 源比最低模板还矮：以源高作为唯一档位
	if len(candidates) == 0 {
		candidates = append(candidates, candidate{info.Height, minVideoBitrateFloor})
	} else if candidates[len(candidates)-1].height != info.Height {
		// 源高落在两档之间（非标准分辨率）：追加源同高档，码率沿用最高模板档，后续统一做封顶
		topBR := candidates[len(candidates)-1].videoBitrate
		candidates = append(candidates, candidate{info.Height, topBR})
	}

	// 第二步：逐档计算偶数宽度、码率封顶，并应用地板规则
	rungs := make([]model.Rung, 0, len(candidates))
	for _, c := range candidates {
		width := scaleWidthEven(info.Width, info.Height, c.height)
		br := clampBitrate(c.videoBitrate, info, rungsAudioBR(info.HasAudio))

		// 非首档低于地板则丢弃；首档无条件保留，保证至少有一条可播流
		if br < minVideoBitrateFloor && len(rungs) > 0 {
			continue
		}
		rungs = append(rungs, model.Rung{
			Height:       c.height,
			Width:        width,
			VideoBitrate: br,
			AudioBitrate: rungsAudioBR(info.HasAudio),
			Playlist:     rungPlaylistName(len(rungs)),
		})
	}
	return rungs
}

// rungsAudioBR 有音频时返回统一音频码率，无音频返回 0。
func rungsAudioBR(hasAudio bool) int64 {
	if hasAudio {
		return audioBitrate
	}
	return 0
}

// scaleWidthEven 按源宽高比把目标高度换算成宽度，并向下取偶数（libx264 要求宽高均为偶数）。
func scaleWidthEven(srcW, srcH, targetH int) int {
	w := int(math.Round(float64(targetH) * float64(srcW) / float64(srcH)))
	if w < 2 {
		w = 2
	}
	return w - w%2
}

// clampBitrate 在模板码率基础上，用源片实际码率做封顶；源码率探测为 0 时不封顶。
func clampBitrate(templateBR int64, info model.MediaInfo, audioBR int64) int64 {
	out := templateBR
	// 封顶一：不超过源视频流码率
	if info.VideoBR > 0 && info.VideoBR < out {
		out = info.VideoBR
	}
	// 封顶二：不超过源总码率扣除音频后的余量
	if info.TotalBR > 0 {
		totalCap := info.TotalBR - audioBR
		if totalCap < minSafeVideoBitrate {
			totalCap = minSafeVideoBitrate
		}
		if totalCap < out {
			out = totalCap
		}
	}
	return out
}

// rungPlaylistName 返回第 index 档的 variant playlist 文件名，与 ffmpeg var_stream_map 序号对应。
func rungPlaylistName(index int) string {
	return "v_" + strconv.Itoa(index) + ".m3u8"
}
