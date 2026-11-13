package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"vod-hls-server/internal/model"
)

// CreateJob 插入一条转码任务。
func (s *Store) CreateJob(ctx context.Context, j *model.Job) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO jobs (id, video_id, status, progress, out_time_ms, attempt, pid, worker_id,
                  heartbeat_at, error, ffmpeg_log_tail, created_at, started_at,
                  finished_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		j.ID, j.VideoID, j.Status, j.Progress, j.OutTimeMS, j.Attempt, j.PID, j.WorkerID,
		j.HeartbeatAt, j.Error, j.FFmpegLogTail, j.CreatedAt, j.StartedAt,
		j.FinishedAt, j.UpdatedAt)
	if err != nil {
		return fmt.Errorf("插入任务记录失败: %w", err)
	}
	return nil
}

// jobColumns 任务查询的统一列清单，保证 Scan 顺序与 scanJob 一致。
const jobColumns = `id, video_id, status, progress, out_time_ms, attempt, pid, worker_id,
       heartbeat_at, error, ffmpeg_log_tail, created_at, started_at, finished_at, updated_at`

// scanJob 统一处理任务行扫描。
func scanJob(scanner interface {
	Scan(dest ...any) error
}) (*model.Job, error) {
	j := &model.Job{}
	err := scanner.Scan(&j.ID, &j.VideoID, &j.Status, &j.Progress, &j.OutTimeMS, &j.Attempt,
		&j.PID, &j.WorkerID, &j.HeartbeatAt, &j.Error, &j.FFmpegLogTail, &j.CreatedAt,
		&j.StartedAt, &j.FinishedAt, &j.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return j, nil
}

// ClaimNext 原子认领最早的一条 pending 任务并置为 processing。
// 单连接池下天然串行，这里仍用单条 UPDATE...RETURNING 保证语义原子；无任务时返回 (nil, nil)。
func (s *Store) ClaimNext(ctx context.Context, workerID string, pid int) (*model.Job, error) {
	row := s.db.QueryRowContext(ctx, `
UPDATE jobs
SET status = ?, worker_id = ?, pid = ?,
    started_at = strftime('%s','now'), heartbeat_at = strftime('%s','now'),
    updated_at = strftime('%s','now')
WHERE id = (
    SELECT id FROM jobs WHERE status = ?
    ORDER BY created_at, rowid LIMIT 1
)
RETURNING `+jobColumns,
		model.JobStatusProcessing, workerID, pid, model.JobStatusPending)

	j, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil // 队列空闲
	}
	if err != nil {
		return nil, fmt.Errorf("认领任务失败: %w", err)
	}
	return j, nil
}

// UpdateProgress 节流后的进度落库，同时刷新心跳，让看门狗/重启逻辑知道任务仍存活。
func (s *Store) UpdateProgress(ctx context.Context, jobID string, progress int, outTimeMS int64) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE jobs SET progress = ?, out_time_ms = ?, heartbeat_at = strftime('%s','now'),
                updated_at = strftime('%s','now')
WHERE id = ?`, progress, outTimeMS, jobID)
	if err != nil {
		return fmt.Errorf("更新任务进度失败: %w", err)
	}
	return nil
}

// MarkJobDone 任务成功：进度置 100、状态 done 并记录结束时间。
func (s *Store) MarkJobDone(ctx context.Context, jobID string) error {
	res, err := s.db.ExecContext(ctx, `
UPDATE jobs SET status = ?, progress = 100, error = '', ffmpeg_log_tail = '',
                finished_at = strftime('%s','now'), updated_at = strftime('%s','now')
WHERE id = ?`, model.JobStatusDone, jobID)
	if err != nil {
		return fmt.Errorf("标记任务成功失败: %w", err)
	}
	return ensureAffected(res)
}

// MarkJobFailed 任务失败：记录错误原因与 ffmpeg 日志片段、状态 failed、结束时间。
func (s *Store) MarkJobFailed(ctx context.Context, jobID, errMsg, logTail string) error {
	res, err := s.db.ExecContext(ctx, `
UPDATE jobs SET status = ?, error = ?, ffmpeg_log_tail = ?,
                finished_at = strftime('%s','now'), updated_at = strftime('%s','now')
WHERE id = ?`, model.JobStatusFailed, errMsg, logTail, jobID)
	if err != nil {
		return fmt.Errorf("标记任务失败失败: %w", err)
	}
	return ensureAffected(res)
}

// GetLatestJob 返回某视频最新一条任务，没有任务时返回 (nil, nil)。
func (s *Store) GetLatestJob(ctx context.Context, videoID string) (*model.Job, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+jobColumns+` FROM jobs WHERE video_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
		videoID)
	j, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("查询最新任务失败: %w", err)
	}
	return j, nil
}

// ListJobsByVideo 返回某视频的全部任务（新的在前），用于管理页展示尝试历史。
func (s *Store) ListJobsByVideo(ctx context.Context, videoID string) ([]*model.Job, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+jobColumns+` FROM jobs WHERE video_id = ? ORDER BY created_at DESC, rowid DESC`,
		videoID)
	if err != nil {
		return nil, fmt.Errorf("查询任务历史失败: %w", err)
	}
	defer rows.Close()

	var out []*model.Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// ResetProcessingJobs 启动恢复：把上次进程残留的 processing 任务全部重置回 pending，不丢任务。
// 返回受影响的视频 ID 列表，供调用方把视频状态从 transcoding 回退。
func (s *Store) ResetProcessingJobs(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
UPDATE jobs SET status = ?, worker_id = '', pid = 0,
                error = '服务重启，任务重新入队',
                heartbeat_at = 0, updated_at = strftime('%s','now')
WHERE status = ?
RETURNING video_id`, model.JobStatusPending, model.JobStatusProcessing)
	if err != nil {
		return nil, fmt.Errorf("重置残留任务失败: %w", err)
	}
	defer rows.Close()

	seen := make(map[string]struct{})
	var videoIDs []string
	for rows.Next() {
		var vid string
		if err := rows.Scan(&vid); err != nil {
			return nil, err
		}
		if _, ok := seen[vid]; !ok {
			seen[vid] = struct{}{}
			videoIDs = append(videoIDs, vid)
		}
	}
	return videoIDs, rows.Err()
}
