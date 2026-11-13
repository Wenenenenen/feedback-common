package store

// migration 描述一个数据库版本及其建表/变更语句。
type migration struct {
	version   int
	statement string
}

// migrations 按版本顺序排列，新增变更时在末尾追加，禁止修改已发布版本的语句。
// 说明：本项目使用 SQLite（非 PostgreSQL），字段类型按 SQLite 方言定义；
// 时间统一存 unix 秒整数，布尔用 INTEGER 0/1。
var migrations = []migration{
	{
		version: 1,
		statement: `
CREATE TABLE IF NOT EXISTS videos (
    id            TEXT PRIMARY KEY,                  -- 视频 ID（UUID）
    title         TEXT NOT NULL,                     -- 展示标题
    source_name   TEXT NOT NULL,                     -- 上传时的原始文件名
    source_path   TEXT NOT NULL,                     -- 源文件在数据目录下的相对路径
    width         INTEGER NOT NULL DEFAULT 0,        -- 源视频宽度（像素）
    height        INTEGER NOT NULL DEFAULT 0,        -- 源视频高度（像素）
    frame_rate    REAL NOT NULL DEFAULT 0,           -- 源视频帧率（fps）
    duration_ms   INTEGER NOT NULL DEFAULT 0,        -- 时长（毫秒）
    src_video_br  INTEGER NOT NULL DEFAULT 0,        -- 源视频流码率（bps），探测不到为 0
    src_total_br  INTEGER NOT NULL DEFAULT 0,        -- 源总码率（bps），探测不到为 0
    has_audio     INTEGER NOT NULL DEFAULT 1,        -- 是否含音频流（0/1）
    ladder_json   TEXT NOT NULL DEFAULT '[]',        -- 实际选定码率档位的 JSON 快照
    status        TEXT NOT NULL DEFAULT 'uploaded',  -- uploaded/transcoding/ready/failed
    output_dir    TEXT NOT NULL DEFAULT '',          -- HLS 正式产物目录（相对数据目录）
    error         TEXT NOT NULL DEFAULT '',          -- 最近一次失败原因
    created_at    INTEGER NOT NULL,                  -- 创建时间（unix 秒）
    updated_at    INTEGER NOT NULL                   -- 更新时间（unix 秒）
);

CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT PRIMARY KEY,                -- 任务 ID（UUID）
    video_id        TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE, -- 所属视频，删视频级联删任务
    status          TEXT NOT NULL,                   -- pending/processing/done/failed
    progress        INTEGER NOT NULL DEFAULT 0,      -- 转码进度 0..100
    out_time_ms     INTEGER NOT NULL DEFAULT 0,      -- ffmpeg 已处理时长（毫秒）
    attempt         INTEGER NOT NULL DEFAULT 1,      -- 第几次尝试（重试产生新记录）
    pid             INTEGER NOT NULL DEFAULT 0,      -- 执行中的 ffmpeg 进程号
    worker_id       TEXT NOT NULL DEFAULT '',        -- 认领任务的 worker 标识
    heartbeat_at    INTEGER NOT NULL DEFAULT 0,      -- 最近一次进度心跳（unix 秒），崩溃检测依据
    error           TEXT NOT NULL DEFAULT '',        -- 失败原因
    ffmpeg_log_tail TEXT NOT NULL DEFAULT '',        -- ffmpeg stderr 末尾片段，便于排障
    created_at      INTEGER NOT NULL,                -- 创建时间（unix 秒）
    started_at      INTEGER NOT NULL DEFAULT 0,      -- 开始执行时间
    finished_at     INTEGER NOT NULL DEFAULT 0,      -- 结束时间
    updated_at      INTEGER NOT NULL                 -- 更新时间
);

-- 任务认领主索引：按状态过滤后按创建时间排队
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
-- 按视频查任务历史
CREATE INDEX IF NOT EXISTS idx_jobs_video ON jobs(video_id);
-- 按状态筛选视频
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
`,
	},
}
