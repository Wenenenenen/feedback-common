package media

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"vod-hls-server/internal/model"
)

// TestFFmpegRealTranscode 用仓库 samples 里的真实 720p 样片跑一次完整多档转码，
// 验证命令参数、产物结构、进度解析与点播 playlist 类型。需要本机已安装 ffmpeg。
func TestFFmpegRealTranscode(t *testing.T) {
	source := filepath.Join("..", "..", "samples", "sintel_trailer-720p.mp4")
	if _, err := os.Stat(source); err != nil {
		t.Skipf("样片不存在，跳过真实转码测试: %v", err)
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("未找到 ffmpeg，跳过真实转码测试")
	}

	info, err := Probe(context.Background(), "ffprobe", source)
	if err != nil {
		t.Fatalf("ffprobe 探测失败: %v", err)
	}
	rungs := BuildLadder(info)
	if len(rungs) != 3 {
		t.Fatalf("720p 样片应产出 3 档，实际 %d 档", len(rungs))
	}

	tmp := t.TempDir()
	spec := TranscodeSpec{
		Source:         source,
		OutputDir:      tmp,
		Rungs:          rungs,
		HasAudio:       info.HasAudio,
		FrameRate:      info.FrameRate,
		SegmentSeconds: 6,
	}
	args, err := BuildFFmpegArgs(spec)
	if err != nil {
		t.Fatalf("构建 ffmpeg 参数失败: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("ffmpeg 转码失败: %v\n输出尾部:\n%s", err, tail(out))
	}

	// 校验每档 playlist 与 ts 分片
	entries, err := os.ReadDir(tmp)
	if err != nil {
		t.Fatal(err)
	}
	has := map[string]bool{}
	for _, e := range entries {
		has[e.Name()] = true
	}
	for _, r := range rungs {
		if !has[r.Playlist] {
			t.Errorf("缺少 variant playlist: %s", r.Playlist)
		}
	}
	tsCount := 0
	for name := range has {
		if filepath.Ext(name) == ".ts" {
			tsCount++
		}
	}
	if tsCount < len(rungs)*2 {
		t.Errorf("ts 分片数量过少: %d，期望至少 %d", tsCount, len(rungs)*2)
	}

	// 写 master 并校验内容
	master := MasterPlaylist(rungs, info.HasAudio)
	masterPath := filepath.Join(tmp, "master.m3u8")
	if err := os.WriteFile(masterPath, []byte(master), 0o644); err != nil {
		t.Fatal(err)
	}
	masterBytes, _ := os.ReadFile(masterPath)
	t.Logf("master.m3u8 内容:\n%s", string(masterBytes))
}

// tail 返回字节切片末尾 2000 字节，用于失败诊断。
func tail(b []byte) []byte {
	if len(b) <= 2000 {
		return b
	}
	return b[len(b)-2000:]
}

// 确保 model 包被使用
var _ = model.Rung{}
