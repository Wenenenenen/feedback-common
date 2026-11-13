package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"vod-hls-server/internal/media"
	"vod-hls-server/internal/model"
	"vod-hls-server/internal/util"
)

// 上传表单字段名与允许的扩展名
const (
	formFieldFile  = "file"
	formFieldTitle = "title"
)

var allowedExts = map[string]bool{".mp4": true, ".mov": true, ".mkv": true, ".ts": true, ".flv": true}

// Upload 处理 POST /api/videos：multipart 流式落盘 -> ffprobe 校验与探测 -> 定档 -> 建视频与 pending 任务。
func (s *Server) Upload(w http.ResponseWriter, r *http.Request) {
	// 限制整个请求体大小，超出后 Copy 会收到错误，避免磁盘被无限写满
	r.Body = http.MaxBytesReader(w, r.Body, s.MaxUploadBytes)

	// 32MB 以内的部分驻留内存，超出自动落系统临时盘
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "解析上传表单失败（可能超过大小上限）: "+err.Error())
		return
	}
	defer r.MultipartForm.RemoveAll()

	file, header, err := r.FormFile(formFieldFile)
	if err != nil {
		writeError(w, http.StatusBadRequest, "缺少上传文件字段 file")
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowedExts[ext] {
		writeError(w, http.StatusBadRequest, "不支持的文件类型: "+ext)
		return
	}

	videoID, err := util.NewUUID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 存储名只用 UUID + 扩展名，杜绝原始文件名中的特殊字符与穿越风险
	storedName := videoID + ext
	relPath := storedName
	absPath := filepath.Join(s.UploadRoot, storedName)
	if err := os.MkdirAll(s.UploadRoot, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "创建上传目录失败: "+err.Error())
		return
	}

	dst, err := os.Create(absPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "创建目标文件失败: "+err.Error())
		return
	}
	written, copyErr := io.Copy(dst, file)
	closeErr := dst.Close()
	if copyErr != nil || closeErr != nil {
		// 落盘失败要清理半成品，避免垃圾堆积
		_ = os.Remove(absPath)
		if copyErr != nil {
			writeError(w, http.StatusBadRequest, "保存上传文件失败: "+copyErr.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "关闭目标文件失败: "+closeErr.Error())
		return
	}
	if written == 0 {
		_ = os.Remove(absPath)
		writeError(w, http.StatusBadRequest, "上传文件为空")
		return
	}

	// ffprobe 校验：不可解析的文件直接拒绝并清理
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	info, err := media.Probe(ctx, s.FFprobePath, absPath)
	if err != nil {
		_ = os.Remove(absPath)
		writeError(w, http.StatusBadRequest, "视频文件无法识别: "+err.Error())
		return
	}

	rungs := media.BuildLadder(info)
	if len(rungs) == 0 {
		_ = os.Remove(absPath)
		writeError(w, http.StatusInternalServerError, "定档失败，未生成任何转码档位")
		return
	}
	ladderJSON, err := json.Marshal(rungs)
	if err != nil {
		_ = os.Remove(absPath)
		writeError(w, http.StatusInternalServerError, "序列化档位失败: "+err.Error())
		return
	}

	title := strings.TrimSpace(r.FormValue(formFieldTitle))
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(header.Filename), ext)
	}
	now := time.Now().Unix()
	video := &model.Video{
		ID:         videoID,
		Title:      title,
		SourceName: filepath.Base(header.Filename),
		SourcePath: relPath,
		Width:      info.Width,
		Height:     info.Height,
		FrameRate:  info.FrameRate,
		DurationMS: int64(info.DurationSec * 1000),
		SrcVideoBR: info.VideoBR,
		SrcTotalBR: info.TotalBR,
		HasAudio:   info.HasAudio,
		LadderJSON: string(ladderJSON),
		Status:     model.VideoStatusUploaded,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	jobID, err := util.NewUUID()
	if err != nil {
		_ = os.Remove(absPath)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	job := &model.Job{
		ID:        jobID,
		VideoID:   videoID,
		Status:    model.JobStatusPending,
		Attempt:   1,
		CreatedAt: now,
		UpdatedAt: now,
	}

	// 视频与任务在同一函数内顺序写入；单连接池下不会出现并发写冲突
	if err := s.Store.CreateVideo(r.Context(), video); err != nil {
		_ = os.Remove(absPath)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.Store.CreateJob(r.Context(), job); err != nil {
		_ = os.Remove(absPath)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"video": video,
		"job":   job,
	})
}
