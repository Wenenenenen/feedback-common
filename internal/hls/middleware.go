package hls

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"vod-hls-server/internal/model"
	"vod-hls-server/internal/sign"
	"vod-hls-server/internal/store"
)

// 资源名白名单：master.m3u8 / v_0.m3u8 / v_0_00001.ts，杜绝 ../、盘符、反斜杠等穿越字符
var safeNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// uuidPattern 视频 ID（RFC 4122 v4 小写）白名单
var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const (
	masterName   = "master.m3u8"
	m3u8Suffix   = ".m3u8"
	tsSuffix     = ".ts"
	cacheControl = "Cache-Control"
)

// Server 持有分发 HLS 所需的依赖。
type Server struct {
	Store       *store.Store
	Signer      *sign.Signer
	HLSRoot     string // HLS 产物根目录（正式目录，.tmp 不在其中）
	DefaultTTL  time.Duration
}

// ServeHTTP 处理 GET /hls/v/{id}/{name...}：验签 -> 定位文件 -> m3u8 重写 / ts 直发。
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 路由前缀 /hls/v/ 之后的剩余路径形如 {id}/{file}
	rest, ok := strings.CutPrefix(r.URL.Path, "/hls/v/")
	if !ok || rest == "" {
		http.Error(w, "路径非法", http.StatusBadRequest)
		return
	}
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || !uuidPattern.MatchString(parts[0]) || !safeNamePattern.MatchString(parts[1]) {
		http.Error(w, "路径非法", http.StatusBadRequest)
		return
	}
	videoID, name := parts[0], parts[1]

	// 验签：签名内容是完整请求路径，过期与签名失败区分状态码，便于前端识别续签
	if err := s.Signer.Verify(r.URL.Path, r.URL.Query()); err != nil {
		if errors.Is(err, sign.ErrExpired) {
			http.Error(w, "链接已过期", http.StatusGone)
			return
		}
		http.Error(w, "签名校验失败", http.StatusForbidden)
		return
	}

	// 二次校验：join 后的真实路径必须仍在该视频目录内，防止任何形式的目录穿越
	videoDir := filepath.Join(s.HLSRoot, videoID)
	fullPath := filepath.Join(videoDir, name)
	absDir, _ := filepath.Abs(videoDir)
	absFile, _ := filepath.Abs(fullPath)
	if !strings.HasPrefix(absFile+string(os.PathSeparator), absDir+string(os.PathSeparator)) {
		http.Error(w, "路径非法", http.StatusBadRequest)
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}

	switch {
	case name == masterName || strings.HasSuffix(name, m3u8Suffix):
		s.servePlaylist(w, r, videoID, name, fullPath)
	case strings.HasSuffix(name, tsSuffix):
		s.serveSegment(w, r, fullPath, info)
	default:
		http.Error(w, "不支持的资源类型", http.StatusForbidden)
	}
}

// servePlaylist 返回重写后的 m3u8：其中所有 URI 都用当前时间重新签名，实现签名接力刷新。
func (s *Server) servePlaylist(w http.ResponseWriter, r *http.Request, videoID, name, fullPath string) {
	f, err := os.Open(fullPath)
	if err != nil {
		http.Error(w, "播放列表不存在", http.StatusNotFound)
		return
	}
	defer f.Close()

	ttl := s.playlistTTL(r.Context(), videoID)
	body, err := RewritePlaylist(f, func(uri string) string {
		childPath := "/hls/v/" + videoID + "/" + uri
		return s.Signer.SignURL(childPath, ttl)
	})
	if err != nil {
		http.Error(w, "解析播放列表失败", http.StatusInternalServerError)
		return
	}

	// 含动态签名的 playlist 禁止任何中间缓存
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
	w.Header().Set(cacheControl, "no-store")
	w.Header().Set("Expires", "0")
	_, _ = w.Write(body)
}

// serveSegment 直接回 ts 分片，支持 Range 请求；分片内容不可变，允许私有长缓存。
func (s *Server) serveSegment(w http.ResponseWriter, r *http.Request, fullPath string, info os.FileInfo) {
	f, err := os.Open(fullPath)
	if err != nil {
		http.Error(w, "分片不存在", http.StatusNotFound)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set(cacheControl, "private, max-age=7200")
	// ServeContent 内部处理 Range/If-Modified-Since，会自行设置 Accept-Ranges
	http.ServeContent(w, r, filepath.Base(fullPath), info.ModTime(), f)
}

// playlistTTL 让 m3u8 签名有效期覆盖完整播放时长：max(视频时长+10 分钟, 默认 TTL)，避免长视频看到一半 403。
func (s *Server) playlistTTL(ctx context.Context, videoID string) time.Duration {
	ttl := s.DefaultTTL
	if v, err := s.Store.GetVideo(ctx, videoID); err == nil && v.DurationMS > 0 {
		cover := time.Duration(v.DurationMS)*time.Millisecond + 10*time.Minute
		if cover > ttl {
			ttl = cover
		}
	}
	return ttl
}

// BuildPlayURL 生成某视频 master.m3u8 的签名访问 URL（供播放页接口调用）。
func (s *Server) BuildPlayURL(ctx context.Context, video *model.Video) (string, error) {
	if video.Status != model.VideoStatusReady {
		return "", fmt.Errorf("视频尚未转码完成，当前状态: %s", video.Status)
	}
	masterPath := "/hls/v/" + video.ID + "/" + masterName
	return s.Signer.SignURL(masterPath, s.playlistTTL(ctx, video.ID)), nil
}
