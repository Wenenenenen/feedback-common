// Package handler 实现全部 HTTP 接口：上传、视频管理、任务查询、播放签名与 HLS 分发。
package handler

import (
	"encoding/json"
	"log"
	"net/http"

	"vod-hls-server/internal/hls"
	"vod-hls-server/internal/store"
)

// errorResponse 统一错误响应结构。
type errorResponse struct {
	Error string `json:"error"`
}

// Server 聚合所有 handler 依赖，在 main 中装配一次。
type Server struct {
	Store          *store.Store
	UploadRoot     string      // 上传源文件根目录
	HLS            *hls.Server // HLS 签名分发
	FFprobePath    string      // 上传后校验用
	SegmentSeconds int         // 转码分片时长（runner 实际读取配置，这里保留供接口展示）
	MaxUploadBytes int64       // 单文件大小上限
}

// writeJSON 写出 JSON 响应并统一 Content-Type。
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("写出 JSON 响应失败: %v", err)
	}
}

// writeError 写出统一错误响应。
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorResponse{Error: msg})
}
