// Package main 是 vod-hls-server 的入口，负责装配配置、存储、转码池、HTTP 路由与优雅启停。
package main

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"vod-hls-server/internal/config"
	"vod-hls-server/internal/handler"
	hlsdist "vod-hls-server/internal/hls"
	"vod-hls-server/internal/sign"
	"vod-hls-server/internal/store"
	"vod-hls-server/internal/web"
	"vod-hls-server/internal/worker"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	// 运行期目录统一创建
	for _, dir := range []string{cfg.DataDir, cfg.UploadDir(), cfg.HLSDir()} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Fatalf("创建目录 %s 失败: %v", dir, err)
		}
	}

	// 1. 数据库
	st, err := store.Open(cfg.DBPath())
	if err != nil {
		log.Fatalf("初始化数据库失败: %v", err)
	}
	defer st.Close()

	// 2. HMAC 签名密钥（环境变量优先，否则首次启动自动生成落盘）
	key, err := sign.LoadOrCreateKey(cfg.HMACKey, cfg.SecretKeyPath())
	if err != nil {
		log.Fatalf("加载签名密钥失败: %v", err)
	}
	signer, err := sign.New(key)
	if err != nil {
		log.Fatalf("初始化签名器失败: %v", err)
	}

	// 3. 启动恢复：残留 processing 任务重新入队、清理 .tmp 中断产物
	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := worker.RecoverOnStartup(rootCtx, st, cfg.HLSDir()); err != nil {
		log.Fatalf("启动恢复失败: %v", err)
	}

	// 4. 转码池
	runner := &worker.Runner{
		Store:          st,
		FFmpegPath:     cfg.FFmpegPath,
		FFprobePath:    cfg.FFprobePath,
		UploadRoot:     cfg.UploadDir(),
		HLSRoot:        cfg.HLSDir(),
		SegmentSeconds: cfg.SegmentSeconds,
	}
	pool := worker.NewPool(st, runner, cfg.WorkerConcurrency)
	pool.Start(rootCtx)

	// 5. HLS 签名分发与业务 handler
	hlsServer := &hlsdist.Server{
		Store:      st,
		Signer:     signer,
		HLSRoot:    cfg.HLSDir(),
		DefaultTTL: time.Duration(cfg.SignTTLSeconds) * time.Second,
	}
	api := &handler.Server{
		Store:          st,
		UploadRoot:     cfg.UploadDir(),
		HLS:            hlsServer,
		FFprobePath:    cfg.FFprobePath,
		SegmentSeconds: cfg.SegmentSeconds,
		MaxUploadBytes: cfg.MaxUploadBytes,
	}

	mux := http.NewServeMux()
	registerRoutes(mux, api, hlsServer)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second, // 只限制读头部，整体 ReadTimeout 不设，避免掐断大文件上传
		// Windows 下无 WriteTimeout 也能正常流式输出；分片走 ServeContent，长连接由客户端控制
	}

	// 6. 启动 HTTP 服务，出错即取消根 context 让转码池一起退出
	errCh := make(chan error, 1)
	go func() {
		log.Printf("HTTP 服务监听 %s，数据目录 %s", cfg.Addr, cfg.DataDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-rootCtx.Done():
		log.Println("收到关停信号，开始优雅退出……")
	case err := <-errCh:
		if err != nil {
			log.Printf("HTTP 服务异常: %v", err)
		}
		stop()
	}

	// 先停 HTTP 再接新请求，再等待在跑转码任务收尾（取消信号会让 ffmpeg 退出）
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("HTTP 优雅关停超时: %v", err)
	}
	pool.Wait()
	log.Println("服务已退出")
}

// registerRoutes 注册全部路由。Go 1.22+ ServeMux 支持方法与 {id}、{path...} 路径变量。
func registerRoutes(mux *http.ServeMux, api *handler.Server, hlsServer *hlsdist.Server) {
	// 业务接口
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /api/videos", api.Upload)
	mux.HandleFunc("GET /api/videos", api.ListVideos)
	mux.HandleFunc("GET /api/videos/{id}", api.GetVideo)
	mux.HandleFunc("DELETE /api/videos/{id}", api.DeleteVideo)
	mux.HandleFunc("POST /api/videos/{id}/retry", api.RetryVideo)
	mux.HandleFunc("GET /api/videos/{id}/play-url", api.PlayURL)
	mux.HandleFunc("GET /api/jobs", api.ListJobs)

	// HLS 签名分发（m3u8 动态重写、ts 直发）
	mux.Handle("GET /hls/v/{id}/{path...}", hlsServer)

	// 前端静态资源（embed）。静态资源走 FileServer；页面路由单独处理，避免 FileServer 对目录路径产生重定向环
	staticFS, err := fs.Sub(web.Assets, "assets")
	if err != nil {
		log.Fatalf("加载嵌入静态资源失败: %v", err)
	}
	fileServer := http.FileServer(http.FS(staticFS))
	mux.Handle("GET /static/", http.StripPrefix("/static/", fileServer))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		// 页面路由映射到嵌入 FS 中的具体 HTML 文件，直接读字节返回，不经过目录重定向
		var page string
		switch r.URL.Path {
		case "/", "/index.html":
			page = "index.html"
		case "/play", "/play/", "/play.html":
			page = "play.html"
		default:
			// 未知路径交给 FileServer，由其返回标准 404
			fileServer.ServeHTTP(w, r)
			return
		}
		data, err := fs.ReadFile(staticFS, page)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	})
}
