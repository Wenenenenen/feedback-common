package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"vod-hls-server/internal/model"
)

// ErrNotFound 数据不存在时返回，供 handler 层映射为 404。
var ErrNotFound = errors.New("记录不存在")

// CreateVideo 插入一条视频记录。
func (s *Store) CreateVideo(ctx context.Context, v *model.Video) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO videos (id, title, source_name, source_path, width, height, frame_rate,
                    duration_ms, src_video_br, src_total_br, has_audio, ladder_json,
                    status, output_dir, error, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.ID, v.Title, v.SourceName, v.SourcePath, v.Width, v.Height, v.FrameRate,
		v.DurationMS, v.SrcVideoBR, v.SrcTotalBR, boolToInt(v.HasAudio), v.LadderJSON,
		v.Status, v.OutputDir, v.Error, v.CreatedAt, v.UpdatedAt)
	if err != nil {
		return fmt.Errorf("插入视频记录失败: %w", err)
	}
	return nil
}

// GetVideo 按主键查询视频，不存在返回 ErrNotFound。
func (s *Store) GetVideo(ctx context.Context, id string) (*model.Video, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, title, source_name, source_path, width, height, frame_rate, duration_ms,
       src_video_br, src_total_br, has_audio, ladder_json, status, output_dir, error,
       created_at, updated_at
FROM videos WHERE id = ?`, id)
	v := &model.Video{}
	var hasAudio int
	err := row.Scan(&v.ID, &v.Title, &v.SourceName, &v.SourcePath, &v.Width, &v.Height,
		&v.FrameRate, &v.DurationMS, &v.SrcVideoBR, &v.SrcTotalBR, &hasAudio, &v.LadderJSON,
		&v.Status, &v.OutputDir, &v.Error, &v.CreatedAt, &v.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("查询视频失败: %w", err)
	}
	v.HasAudio = hasAudio == 1
	return v, nil
}

// ListVideos 返回全部视频（按创建时间倒序），并附带每条视频最新一条任务的状态与进度。
func (s *Store) ListVideos(ctx context.Context) ([]*model.VideoWithJob, error) {
	// 关联子查询取每个视频最新任务，LEFT JOIN 保证尚未产生任务的视频也能列出
	rows, err := s.db.QueryContext(ctx, `
SELECT v.id, v.title, v.source_name, v.source_path, v.width, v.height, v.frame_rate,
       v.duration_ms, v.src_video_br, v.src_total_br, v.has_audio, v.ladder_json,
       v.status, v.output_dir, v.error, v.created_at, v.updated_at,
       COALESCE(j.status, ''), COALESCE(j.progress, 0), COALESCE(j.error, '')
FROM videos v
LEFT JOIN jobs j ON j.id = (
    SELECT id FROM jobs WHERE video_id = v.id ORDER BY created_at DESC, rowid DESC LIMIT 1
)
ORDER BY v.created_at DESC, v.rowid DESC`)
	if err != nil {
		return nil, fmt.Errorf("查询视频列表失败: %w", err)
	}
	defer rows.Close()

	var out []*model.VideoWithJob
	for rows.Next() {
		v := &model.VideoWithJob{}
		var hasAudio int
		if err := rows.Scan(&v.ID, &v.Title, &v.SourceName, &v.SourcePath, &v.Width, &v.Height,
			&v.FrameRate, &v.DurationMS, &v.SrcVideoBR, &v.SrcTotalBR, &hasAudio, &v.LadderJSON,
			&v.Status, &v.OutputDir, &v.Error, &v.CreatedAt, &v.UpdatedAt,
			&v.JobStatus, &v.JobProgress, &v.JobError); err != nil {
			return nil, fmt.Errorf("扫描视频行失败: %w", err)
		}
		v.HasAudio = hasAudio == 1
		out = append(out, v)
	}
	return out, rows.Err()
}

// UpdateVideoStatus 更新视频状态与错误信息，同时刷新 updated_at。
func (s *Store) UpdateVideoStatus(ctx context.Context, id, status, errMsg string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE videos SET status = ?, error = ?, updated_at = strftime('%s','now') WHERE id = ?`,
		status, errMsg, id)
	if err != nil {
		return fmt.Errorf("更新视频状态失败: %w", err)
	}
	return ensureAffected(res)
}

// MarkVideoReady 转码成功后标记可播放并记录产物目录、清空错误。
func (s *Store) MarkVideoReady(ctx context.Context, id, outputDir string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE videos SET status = ?, output_dir = ?, error = '', updated_at = strftime('%s','now') WHERE id = ?`,
		model.VideoStatusReady, outputDir, id)
	if err != nil {
		return fmt.Errorf("标记视频就绪失败: %w", err)
	}
	return ensureAffected(res)
}

// DeleteVideo 删除视频记录；jobs 通过外键 ON DELETE CASCADE 自动清理。
func (s *Store) DeleteVideo(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM videos WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("删除视频失败: %w", err)
	}
	return ensureAffected(res)
}

// boolToInt 布尔转 SQLite 整数。
func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ensureAffected 校验语句确实命中一行，否则视为记录不存在。
func ensureAffected(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
