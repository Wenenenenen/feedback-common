// Package worker 实现转码任务的队列调度、单任务编排与重启恢复。
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"vod-hls-server/internal/media"
	"vod-hls-server/internal/model"
	"vod-hls-server/internal/store"
)

// Runner 编排单个转码任务：建临时目录 -> ffmpeg 转码 -> 校验产物 -> 原子切换 -> 回写状态。
type Runner struct {
	Store          *store.Store
	FFmpegPath     string
	FFprobePath    string
	UploadRoot     string // 上传源文件根目录（绝对路径）
	HLSRoot        string // 正式 HLS 产物根目录（绝对路径）
	SegmentSeconds int
}

// Run 执行一个已被认领（processing）的任务。返回 error 表示任务失败，调用方负责落 failed 状态。
func (r *Runner) Run(ctx context.Context, job *model.Job) error {
	video, err := r.Store.GetVideo(ctx, job.VideoID)
	if err != nil {
		return fmt.Errorf("加载视频记录失败: %w", err)
	}

	// 重新解析档位快照（上传时已定好并落库），保证重试与首次执行行为一致
	rungs, err := decodeLadder(video.LadderJSON)
	if err != nil {
		return fmt.Errorf("解析档位快照失败: %w", err)
	}
	if len(rungs) == 0 {
		return errors.New("档位快照为空，无法转码")
	}

	// 标记视频进入转码中
	if err := r.Store.UpdateVideoStatus(ctx, video.ID, model.VideoStatusTranscoding, ""); err != nil {
		return err
	}

	tmpDir := filepath.Join(r.HLSRoot, video.ID+".tmp")
	finalDir := filepath.Join(r.HLSRoot, video.ID)
	// 清理可能残留的同名临时目录（正常情况下启动恢复已清，这里再兜底一次）
	if err := os.RemoveAll(tmpDir); err != nil {
		return fmt.Errorf("清理临时目录失败: %w", err)
	}
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return fmt.Errorf("创建临时目录失败: %w", err)
	}

	// 无论成功失败，临时目录都不保留
	defer os.RemoveAll(tmpDir)

	// 源文件使用上传根目录 + 记录中的相对路径拼接，避免依赖目录层级的隐式关系
	sourcePath := filepath.Join(r.UploadRoot, filepath.FromSlash(video.SourcePath))
	spec := media.TranscodeSpec{
		Source:         sourcePath,
		OutputDir:      tmpDir,
		Rungs:          rungs,
		HasAudio:       video.HasAudio,
		FrameRate:      video.FrameRate,
		SegmentSeconds: r.SegmentSeconds,
	}
	args, err := media.BuildFFmpegArgs(spec)
	if err != nil {
		return err
	}

	if err := r.runFFmpeg(ctx, job, video, args, tmpDir); err != nil {
		return err
	}

	// 生成服务端 master（磁盘文件不签名，分发时动态重写）
	master := media.MasterPlaylist(rungs, video.HasAudio)
	if err := os.WriteFile(filepath.Join(tmpDir, "master.m3u8"), []byte(master), 0o644); err != nil {
		return fmt.Errorf("写入 master playlist 失败: %w", err)
	}

	// 产物完整性校验：master、每档 playlist 与至少一个 ts 分片必须存在
	if err := verifyArtifacts(tmpDir, rungs); err != nil {
		return err
	}

	// 原子切换：Windows 下 rename 不能覆盖非空目录，先删旧正式目录再改名
	if err := os.RemoveAll(finalDir); err != nil {
		return fmt.Errorf("清理旧产物目录失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(finalDir), 0o755); err != nil {
		return fmt.Errorf("创建 HLS 根目录失败: %w", err)
	}
	if err := os.Rename(tmpDir, finalDir); err != nil {
		return fmt.Errorf("切换正式产物目录失败: %w", err)
	}

	if err := r.Store.MarkJobDone(ctx, job.ID); err != nil {
		return err
	}
	// output_dir 存相对 HLS 根的目录名，删除视频时据此清理
	return r.Store.MarkVideoReady(ctx, video.ID, video.ID)
}

// runFFmpeg 启动 ffmpeg 子进程并实时解析进度；Windows 下确保取消时进程树被强杀。
func (r *Runner) runFFmpeg(ctx context.Context, job *model.Job, video *model.Video, args []string, tmpDir string) error {
	cmd := exec.CommandContext(ctx, r.FFmpegPath, args...)
	// 直接调 ffmpeg.exe 不经 shell 包壳，避免取消时只杀掉 shell 而 ffmpeg 成为孤儿
	cmd.Cancel = func() error {
		// Go 1.20+ Windows 支持 Process.Kill（TerminateProcess）；再用 taskkill /T 兜底进程树
		killErr := cmd.Process.Kill()
		if cmd.Process != nil {
			_ = exec.Command("taskkill", "/T", "/F", "/PID", fmt.Sprint(cmd.Process.Pid)).Run()
		}
		return killErr
	}
	cmd.WaitDelay = 10 * time.Second // 强杀后强制回收，防止句柄与管道泄漏

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("创建 stdout 管道失败: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("创建 stderr 管道失败: %w", err)
	}
	logTail := media.NewLogTail(64 * 1024)

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 ffmpeg 失败: %w", err)
	}

	// 进度写库节流：距上次 >=1s 且百分比变化 >=1 才落库，避免高频写占满单连接
	durationSec := float64(video.DurationMS) / 1000
	var (
		lastWrite time.Time
		lastPct   = -1
	)
	progressDone := make(chan struct{})
	go func() {
		_ = media.ParseProgress(stdout, durationSec, func(u media.ProgressUpdate) {
			now := time.Now()
			if u.Percent != lastPct && (now.Sub(lastWrite) >= time.Second || u.Ended) {
				_ = r.Store.UpdateProgress(ctx, job.ID, u.Percent, u.OutTimeMS)
				lastWrite = now
				lastPct = u.Percent
			}
		})
		close(progressDone)
	}()
	// stderr 必须并发读到 EOF，否则管道缓冲写满后 ffmpeg 会阻塞假死
	go func() { _, _ = io.Copy(logTail, stderr) }()

	waitErr := cmd.Wait()
	<-progressDone // 等进度协程把最后的输出消费完

	if ctx.Err() != nil {
		return fmt.Errorf("转码被取消: %w", ctx.Err())
	}
	if waitErr != nil {
		return fmt.Errorf("ffmpeg 退出异常: %w；日志尾部: %s", waitErr, logTail.String())
	}
	return nil
}

// verifyArtifacts 校验转码产物齐全，防止半成品被切换到正式目录。
func verifyArtifacts(dir string, rungs []model.Rung) error {
	masterPath := filepath.Join(dir, "master.m3u8")
	if _, err := os.Stat(masterPath); err != nil {
		return fmt.Errorf("master playlist 缺失: %w", err)
	}
	for _, rung := range rungs {
		plPath := filepath.Join(dir, rung.Playlist)
		if _, err := os.Stat(plPath); err != nil {
			return fmt.Errorf("档位 playlist 缺失 %s: %w", rung.Playlist, err)
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return fmt.Errorf("读取产物目录失败: %w", err)
		}
		// v_0.m3u8 对应的分片前缀为 v_0_，用 playlist 名去掉扩展名后加下划线得到
		segmentPrefix := strings.TrimSuffix(rung.Playlist, filepath.Ext(rung.Playlist)) + "_"
		hasSegment := false
		for _, e := range entries {
			name := e.Name()
			if !e.IsDir() && strings.HasPrefix(name, segmentPrefix) && filepath.Ext(name) == ".ts" {
				hasSegment = true
				break
			}
		}
		if !hasSegment {
			return fmt.Errorf("档位 %s 没有产出任何 ts 分片", rung.Playlist)
		}
	}
	return nil
}

// decodeLadder 解析 videos.ladder_json 中的档位快照。
func decodeLadder(raw string) ([]model.Rung, error) {
	var rungs []model.Rung
	if err := json.Unmarshal([]byte(raw), &rungs); err != nil {
		return nil, err
	}
	return rungs, nil
}
