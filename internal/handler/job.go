package handler

import (
	"net/http"

	"vod-hls-server/internal/model"
)

// ListJobs 处理 GET /api/jobs?video_id=xxx：返回某视频的任务尝试历史（管理页排障与轮询用）。
// 不提供全表任务查询：全局进度通过 GET /api/videos 聚合返回，避免大表扫描。
func (s *Server) ListJobs(w http.ResponseWriter, r *http.Request) {
	videoID := r.URL.Query().Get("video_id")
	if videoID == "" {
		writeError(w, http.StatusBadRequest, "请通过 video_id 参数指定视频，或改用 GET /api/videos 查看全局状态")
		return
	}
	jobs, err := s.Store.ListJobsByVideo(r.Context(), videoID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if jobs == nil {
		jobs = []*model.Job{} // 空结果返回 [] 而非 null
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}
