package worker

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"

	"vod-hls-server/internal/model"
	"vod-hls-server/internal/store"
)

// RecoverOnStartup 服务启动、调度池开启前调用：
//  1. 上次进程残留的 processing 任务全部重置为 pending（不丢任务）；
//  2. 对应视频状态从 transcoding 回退为 uploaded，等待新任务重新驱动；
//  3. 清理所有 *.tmp 临时产物目录（中断的转码结果不完整，不能复用）。
func RecoverOnStartup(ctx context.Context, st *store.Store, hlsRoot string) error {
	videoIDs, err := st.ResetProcessingJobs(ctx)
	if err != nil {
		return err
	}
	for _, vid := range videoIDs {
		if err := st.UpdateVideoStatus(ctx, vid, model.VideoStatusUploaded, "服务重启，等待重新转码"); err != nil {
			log.Printf("回退视频状态失败 video=%s: %v", vid, err)
		}
	}
	if len(videoIDs) > 0 {
		log.Printf("启动恢复：%d 个未完成任务已重新入队", len(videoIDs))
	}
	return cleanTempDirs(hlsRoot)
}

// cleanTempDirs 删除 HLS 根目录下所有以 .tmp 结尾的中断产物目录。
func cleanTempDirs(hlsRoot string) error {
	entries, err := os.ReadDir(hlsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // 首次启动目录还不存在，无需清理
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasSuffix(e.Name(), ".tmp") {
			p := filepath.Join(hlsRoot, e.Name())
			if err := os.RemoveAll(p); err != nil {
				log.Printf("清理临时目录失败 %s: %v", p, err)
			} else {
				log.Printf("已清理中断产物目录 %s", p)
			}
		}
	}
	return nil
}
