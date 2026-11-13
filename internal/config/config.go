// Package config 负责加载服务运行配置，全部配置项支持环境变量覆盖并提供内网场景的合理默认值。
package config

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config 服务运行配置。
type Config struct {
	// HTTP 监听地址，例如 ":8080"
	Addr string
	// DataDir 运行数据根目录（数据库、密钥、上传源文件、HLS 产物）
	DataDir string
	// WorkerConcurrency 同时执行的 ffmpeg 转码任务上限，默认 1 避免把机器拖死
	WorkerConcurrency int
	// MaxUploadBytes 单个上传文件大小上限，默认 5GB
	MaxUploadBytes int64
	// SegmentSeconds HLS 分片目标时长（秒）
	SegmentSeconds int
	// SignTTLSeconds 签名默认有效期（秒），m3u8 实际有效期还会结合视频时长取较大值
	SignTTLSeconds int
	// HMACKey HMAC 签名密钥（可选，为空时首次启动自动生成并落盘）
	HMACKey []byte
	// FFmpegPath / FFprobePath 可执行文件路径，默认从 PATH 查找
	FFmpegPath  string
	FFprobePath string
}

// 默认配置常量。
const (
	defaultAddr             = ":8080"
	defaultDataDir          = "data"
	defaultConcurrency      = 1
	defaultMaxUploadBytes   = int64(5 * 1024 * 1024 * 1024)
	defaultSegmentSeconds   = 6
	defaultSignTTLSeconds   = 2 * 60 * 60
	defaultFFmpeg           = "ffmpeg"
	defaultFFprobe          = "ffprobe"
	envHMACKey              = "VOD_HMAC_KEY"
	envSignTTLSeconds       = "VOD_SIGN_TTL"
)

// Load 从环境变量加载配置；dataDir 为相对路径时转换为绝对路径，保证子进程工作目录变化后仍可定位。
func Load() (*Config, error) {
	cfg := &Config{
		Addr:              getenv("VOD_ADDR", defaultAddr),
		DataDir:           getenv("VOD_DATA_DIR", defaultDataDir),
		WorkerConcurrency: getenvInt("VOD_WORKER_CONCURRENCY", defaultConcurrency),
		MaxUploadBytes:    int64(getenvInt("VOD_MAX_UPLOAD_BYTES", int(defaultMaxUploadBytes))),
		SegmentSeconds:    getenvInt("VOD_SEGMENT_SECONDS", defaultSegmentSeconds),
		SignTTLSeconds:    getenvInt(envSignTTLSeconds, defaultSignTTLSeconds),
		FFmpegPath:        getenv("VOD_FFMPEG_PATH", defaultFFmpeg),
		FFprobePath:       getenv("VOD_FFPROBE_PATH", defaultFFprobe),
	}

	// 并发数至少为 1，否则队列永远无法消费
	if cfg.WorkerConcurrency < 1 {
		return nil, fmt.Errorf("VOD_WORKER_CONCURRENCY 必须 >= 1，当前值: %d", cfg.WorkerConcurrency)
	}
	if cfg.SegmentSeconds < 1 {
		return nil, fmt.Errorf("VOD_SEGMENT_SECONDS 必须 >= 1，当前值: %d", cfg.SegmentSeconds)
	}
	if cfg.SignTTLSeconds < 60 {
		return nil, fmt.Errorf("VOD_SIGN_TTL 不能小于 60 秒，当前值: %d", cfg.SignTTLSeconds)
	}

	// 数据目录转为绝对路径，ffmpeg 子进程不继承工作目录时也能正确读写
	absData, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("解析数据目录绝对路径失败: %w", err)
	}
	cfg.DataDir = absData

	// 可选：通过环境变量直接注入 base64 编码的 HMAC 密钥，便于多实例共享
	if raw := strings.TrimSpace(os.Getenv(envHMACKey)); raw != "" {
		key, err := decodeBase64(raw)
		if err != nil {
			return nil, fmt.Errorf("环境变量 %s 不是合法 base64: %w", envHMACKey, err)
		}
		if len(key) < 16 {
			return nil, fmt.Errorf("环境变量 %s 解码后长度不足 16 字节，安全性不够", envHMACKey)
		}
		cfg.HMACKey = key
	}
	return cfg, nil
}

// UploadDir 上传源文件目录。
func (c *Config) UploadDir() string {
	return filepath.Join(c.DataDir, "uploads")
}

// HLSDir HLS 产物根目录。
func (c *Config) HLSDir() string {
	return filepath.Join(c.DataDir, "hls")
}

// DBPath SQLite 数据库文件路径。
func (c *Config) DBPath() string {
	return filepath.Join(c.DataDir, "vod.db")
}

// SecretKeyPath 自动生成的 HMAC 密钥落盘路径。
func (c *Config) SecretKeyPath() string {
	return filepath.Join(c.DataDir, "secret.key")
}

// getenv 读取环境变量，缺省时返回默认值。
func getenv(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// getenvInt 读取整型环境变量，缺失或非法时返回默认值。
func getenvInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// decodeBase64 解码标准 base64 字符串为原始字节。
func decodeBase64(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}
