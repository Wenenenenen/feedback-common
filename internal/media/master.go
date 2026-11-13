package media

import (
	"fmt"
	"strings"

	"vod-hls-server/internal/model"
)

// 固定使用 H.264 High@4.0 + AAC-LC 的 CODECS 标识：
// 本服务统一以 yuv420p + High profile 编码（720p/1080p 均兼容该 level），
// 标识只用于播放器能力预判，hls.js 在浏览器内解码时会按实际码流处理。
const (
	videoCodec = "avc1.640028" // High profile, level 4.0
	audioCodec = "mp4a.40.2"   // AAC-LC
	audioGroup = "aud1"
)

// MasterPlaylist 生成点播 master.m3u8 文本。
// 其中 variant 的 URI 只写文件名（如 v_0.m3u8），签名由分发层在响应时逐行重写，磁盘文件不存签名。
func MasterPlaylist(rungs []model.Rung, hasAudio bool) string {
	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	b.WriteString("#EXT-X-VERSION:3\n")

	if hasAudio {
		// 独立 AUDIO 组：所有 variant 共用一组音频描述
		b.WriteString(fmt.Sprintf("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=%q,NAME=%q,DEFAULT=YES,AUTOSELECT=YES\n",
			audioGroup, "原声"))
	}

	for _, r := range rungs {
		// BANDWIDTH 为峰值估算：音视频码率之和上浮 10% 封装开销；AVERAGE-BANDWIDTH 用名义和
		total := r.VideoBitrate + r.AudioBitrate
		bandwidth := int64(float64(total) * 1.1)
		codecs := videoCodec
		if hasAudio {
			codecs = videoCodec + "," + audioCodec
		}
		b.WriteString("#EXT-X-STREAM-INF:")
		attrs := []string{
			fmt.Sprintf("BANDWIDTH=%d", bandwidth),
			fmt.Sprintf("AVERAGE-BANDWIDTH=%d", total),
			fmt.Sprintf("RESOLUTION=%dx%d", r.Width, r.Height),
			fmt.Sprintf("CODECS=%q", codecs),
		}
		if hasAudio {
			attrs = append(attrs, fmt.Sprintf("AUDIO=%q", audioGroup))
		}
		b.WriteString(strings.Join(attrs, ","))
		b.WriteString("\n")
		b.WriteString(r.Playlist)
		b.WriteString("\n")
	}
	return b.String()
}
