package media

import (
	"testing"

	"vod-hls-server/internal/model"
)

func TestBuildLadder(t *testing.T) {
	// 本机 720p 样片 ffprobe 实测参数
	sintel720 := model.MediaInfo{
		Width: 1280, Height: 720, FrameRate: 24, DurationSec: 52,
		VideoBR: 1_033_716, TotalBR: 1_165_822, HasAudio: true,
	}
	// 本机 1080p 样片 ffprobe 实测参数
	sintel1080 := model.MediaInfo{
		Width: 1920, Height: 1080, FrameRate: 24, DurationSec: 52,
		VideoBR: 2_108_423, TotalBR: 2_240_491, HasAudio: true,
	}

	tests := []struct {
		name        string
		info        model.MediaInfo
		wantHeights []int
		// wantMaxBitrate 每档期望视频码率（与 wantHeights 顺序对应）
		wantBitrates []int64
		wantAudio    int64
	}{
		{
			name:         "720p 低码率源：三档且禁升 1080p，高档码率封顶到源水平",
			info:         sintel720,
			wantHeights:  []int{360, 480, 720},
			wantBitrates: []int64{800_000, 1_033_716, 1_033_716},
			wantAudio:    128_000,
		},
		{
			name:         "1080p 低码率源：四档，1080p 档封顶在源视频码率",
			info:         sintel1080,
			wantHeights:  []int{360, 480, 720, 1080},
			wantBitrates: []int64{800_000, 1_200_000, 2_108_423, 2_108_423},
			wantAudio:    128_000,
		},
		{
			name: "高码率 1080p 源：模板码率不被封顶",
			info: model.MediaInfo{
				Width: 1920, Height: 1080, VideoBR: 8_000_000, TotalBR: 8_200_000, HasAudio: true,
			},
			wantHeights:  []int{360, 480, 720, 1080},
			wantBitrates: []int64{800_000, 1_200_000, 2_500_000, 5_000_000},
			wantAudio:    128_000,
		},
		{
			name: "无音频源：音频码率为 0，总码率封顶不扣音频",
			info: model.MediaInfo{
				Width: 1280, Height: 720, VideoBR: 1_000_000, TotalBR: 1_000_000, HasAudio: false,
			},
			wantHeights:  []int{360, 480, 720},
			wantBitrates: []int64{800_000, 1_000_000, 1_000_000},
			wantAudio:    0,
		},
		{
			name: "非标准 540p 源：追加源同高顶级档且不出现 720p",
			info: model.MediaInfo{
				Width: 960, Height: 540, VideoBR: 2_000_000, TotalBR: 2_150_000, HasAudio: true,
			},
			wantHeights:  []int{360, 480, 540},
			wantBitrates: []int64{800_000, 1_200_000, 1_200_000},
			wantAudio:    128_000,
		},
		{
			name: "极低码率源：最低档始终保留",
			info: model.MediaInfo{
				Width: 640, Height: 360, VideoBR: 150_000, TotalBR: 150_000, HasAudio: false,
			},
			wantHeights:  []int{360},
			wantBitrates: []int64{150_000},
			wantAudio:    0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rungs := BuildLadder(tt.info)
			if len(rungs) != len(tt.wantHeights) {
				t.Fatalf("档位数不符：得到 %d 档 %v，期望 %d 档 %v", len(rungs), rungHeights(rungs), len(tt.wantHeights), tt.wantHeights)
			}
			for i, r := range rungs {
				if r.Height != tt.wantHeights[i] {
					t.Errorf("第 %d 档高度：得到 %d，期望 %d", i, r.Height, tt.wantHeights[i])
				}
				if r.VideoBitrate != tt.wantBitrates[i] {
					t.Errorf("第 %d 档(%dp)视频码率：得到 %d，期望 %d", i, r.Height, r.VideoBitrate, tt.wantBitrates[i])
				}
				if r.AudioBitrate != tt.wantAudio {
					t.Errorf("第 %d 档(%dp)音频码率：得到 %d，期望 %d", i, r.Height, r.AudioBitrate, tt.wantAudio)
				}
				if r.Playlist != rungPlaylistName(i) {
					t.Errorf("第 %d 档 playlist 文件名：得到 %s，期望 %s", i, r.Playlist, rungPlaylistName(i))
				}
				if r.Width%2 != 0 || r.Width <= 0 {
					t.Errorf("第 %d 档宽度必须为正偶数，得到 %d", i, r.Width)
				}
			}
		})
	}
}

// TestBuildLadder_NeverUpscale 专门验证任何源都不会产出比源更高的分辨率。
func TestBuildLadder_NeverUpscale(t *testing.T) {
	for _, h := range []int{360, 400, 480, 540, 720, 1080, 1440} {
		info := model.MediaInfo{
			Width: h * 16 / 9, Height: h, VideoBR: 10_000_000, TotalBR: 10_200_000, HasAudio: true,
		}
		rungs := BuildLadder(info)
		if len(rungs) == 0 {
			t.Fatalf("源高 %d 未产出任何档位", h)
		}
		top := rungs[len(rungs)-1]
		if top.Height > h {
			t.Fatalf("源高 %d 出现升档：最高档高度 %d", h, top.Height)
		}
	}
}

// rungHeights 提取档位高度列表，用于失败时输出诊断信息。
func rungHeights(rungs []model.Rung) []int {
	out := make([]int, len(rungs))
	for i, r := range rungs {
		out[i] = r.Height
	}
	return out
}
