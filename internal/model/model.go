// Package model 定义服务的领域对象与状态常量。
package model

// 视频整体状态。
const (
	VideoStatusUploaded    = "uploaded"    // 已上传，等待/尚未开始转码
	VideoStatusTranscoding = "transcoding" // 转码进行中
	VideoStatusReady       = "ready"       // 转码完成可播放
	VideoStatusFailed      = "failed"      // 最新一次转码失败
)

// 转码任务状态。
const (
	JobStatusPending    = "pending"    // 排队中
	JobStatusProcessing = "processing" // 转码中
	JobStatusDone       = "done"       // 成功完成
	JobStatusFailed     = "failed"     // 失败（可重试）
)

// Video 对应 videos 表，记录源视频信息、探测结果与最新状态。
type Video struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	SourceName  string  `json:"source_name"`
	SourcePath  string  `json:"-"` // 服务端本地路径，不对外暴露
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	FrameRate   float64 `json:"frame_rate"`
	DurationMS  int64   `json:"duration_ms"`
	SrcVideoBR  int64   `json:"src_video_br"`  // 源视频流码率（bps），探测不到时为 0
	SrcTotalBR  int64   `json:"src_total_br"`  // 源总码率（bps），探测不到时为 0
	HasAudio    bool    `json:"has_audio"`
	LadderJSON  string  `json:"ladder_json"`   // 实际选定档位快照
	Status      string  `json:"status"`
	OutputDir   string  `json:"-"`
	Error       string  `json:"error,omitempty"`
	CreatedAt   int64   `json:"created_at"`
	UpdatedAt   int64   `json:"updated_at"`
}

// Job 对应 jobs 表，一次转码尝试一条记录（重试产生新行，保留历史）。
type Job struct {
	ID           string `json:"id"`
	VideoID      string `json:"video_id"`
	Status       string `json:"status"`
	Progress     int    `json:"progress"`      // 0..100
	OutTimeMS    int64  `json:"out_time_ms"`   // ffmpeg 已处理时长
	Attempt      int    `json:"attempt"`
	PID          int    `json:"-"`
	WorkerID     string `json:"-"`
	HeartbeatAt  int64  `json:"-"`
	Error        string `json:"error,omitempty"`
	FFmpegLogTail string `json:"ffmpeg_log_tail,omitempty"`
	CreatedAt    int64  `json:"created_at"`
	StartedAt    int64  `json:"started_at"`
	FinishedAt   int64  `json:"finished_at"`
	UpdatedAt    int64  `json:"updated_at"`
}

// VideoWithJob 列表接口返回的聚合结构：视频信息 + 最新任务进度。
type VideoWithJob struct {
	Video
	// 最新一条任务的状态与进度，没有任务时为空
	JobStatus   string `json:"job_status"`
	JobProgress int    `json:"job_progress"`
	JobError    string `json:"job_error,omitempty"`
}

// Rung 表示码率阶梯中的一档（一个 variant）。
type Rung struct {
	// Height 目标分辨率高度（像素）
	Height int `json:"height"`
	// Width 目标分辨率宽度（像素，偶数）
	Width int `json:"width"`
	// VideoBitrate 目标视频码率（bps，已经过源片码率封顶）
	VideoBitrate int64 `json:"video_bitrate"`
	// AudioBitrate 音频码率（bps），无音频时为 0
	AudioBitrate int64 `json:"audio_bitrate"`
	// Playlist 该档 variant playlist 文件名，例如 v_0.m3u8
	Playlist string `json:"playlist"`
}

// MediaInfo 是 ffprobe 探测结果的内部传递结构。
type MediaInfo struct {
	Width       int     // 视频宽度
	Height      int     // 视频高度
	FrameRate   float64 // 帧率（fps）
	DurationSec float64 // 时长（秒）
	VideoBR     int64   // 视频流码率 bps，可能为 0
	TotalBR     int64   // 容器总码率 bps，可能为 0
	HasAudio    bool    // 是否存在音频流
}
