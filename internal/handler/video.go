package handler

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"vod-hls-server/internal/model"
	"vod-hls-server/internal/store"
	"vod-hls-server/internal/util"
)

// ListVideos 处理 GET /api/videos：返回视频列表及每条视频最新任务的状态与进度。
func (s *Server) ListVideos(w http.ResponseWriter, r *http.Request) {
	videos, err := s.Store.ListVideos(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if videos == nil {
		videos = []*model.VideoWithJob{} // 保证前端拿到 [] 而不是 null
	}
	writeJSON(w, http.StatusOK, map[string]any{"videos": videos})
}

// GetVideo 处理 GET /api/videos/{id}：视频详情 + 任务尝试历史。
func (s *Server) GetVideo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	video, err := s.Store.GetVideo(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "视频不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jobs, err := s.Store.ListJobsByVideo(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"video": video, "jobs": jobs})
}

// DeleteVideo 处理 DELETE /api/videos/{id}：级联删任务记录，并清理源文件与 HLS 产物目录。
func (s *Server) DeleteVideo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	video, err := s.Store.GetVideo(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "视频不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 正在转码的视频不允许直接删除，避免删掉记录后 ffmpeg 仍在写孤儿文件
	latest, _ := s.Store.GetLatestJob(r.Context(), id)
	if latest != nil && latest.Status == model.JobStatusProcessing {
		writeError(w, http.StatusConflict, "视频正在转码中，请等待完成后再删除")
		return
	}

	if err := s.Store.DeleteVideo(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 记录删除成功后再尽力清理磁盘文件，清理失败只记录不阻断响应
	removeQuiet(filepath.Join(s.UploadRoot, filepath.FromSlash(video.SourcePath)))
	removeQuiet(filepath.Join(s.HLS.HLSRoot, id))
	removeQuiet(filepath.Join(s.HLS.HLSRoot, id+".tmp"))
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

// RetryVideo 处理 POST /api/videos/{id}/retry：为失败视频新建一条 pending 任务，保留历史尝试。
func (s *Server) RetryVideo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// 先确认视频存在，不存在直接 404
	if _, err := s.Store.GetVideo(r.Context(), id); errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "视频不存在")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	latest, err := s.Store.GetLatestJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if latest != nil && latest.Status == model.JobStatusProcessing {
		writeError(w, http.StatusConflict, "视频正在转码中，无需重试")
		return
	}

	attempt := 1
	if latest != nil {
		attempt = latest.Attempt + 1
	}
	jobID, err := util.NewUUID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().Unix()
	job := &model.Job{
		ID:        jobID,
		VideoID:   id,
		Status:    model.JobStatusPending,
		Attempt:   attempt,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.Store.CreateJob(r.Context(), job); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.Store.UpdateVideoStatus(r.Context(), id, model.VideoStatusUploaded, ""); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"job": job})
}

// PlayURL 处理 GET /api/videos/{id}/play-url：返回签名后的 master playlist 地址。
func (s *Server) PlayURL(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	video, err := s.Store.GetVideo(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "视频不存在")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	url, err := s.HLS.BuildPlayURL(r.Context(), video)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"url":      url,
		"video_id": id,
		"ladder":   json.RawMessage(orEmptyArray(video.LadderJSON)),
	})
}

// orEmptyArray 保证 ladder 字段为空时返回 [] 而不是 null。
func orEmptyArray(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return "[]"
	}
	return raw
}

// removeQuiet 删除文件或目录，忽略不存在错误；其余错误写日志但不影响接口响应。
func removeQuiet(path string) {
	if err := os.RemoveAll(path); err != nil && !os.IsNotExist(err) {
		log.Printf("清理磁盘文件失败 path=%s: %v", path, err)
	}
}
