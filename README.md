# vod-hls-server

内网培训视频的自动转码与 HLS 点播服务。后台上传视频后，服务自动用 ffmpeg 转成多档码率的 HLS，
外地弱网同事可用 hls.js 按网速自适应清晰度播放；m3u8 与 ts 分片全部带 HMAC 签名和过期时间，
链接拷走一段时间即失效。

## 功能特性

- **自动多档转码**：单条 ffmpeg 命令产出 360p/480p/720p/1080p 多档 HLS（MPEG-TS 分片）并生成 master playlist
- **智能定档**：只降不升（720p 源绝不转 1080p）；目标码率按源片实际码率封顶，不做无意义的高码率转码
- **排队与限流**：转码并发数可配（默认 1），任务排队执行，不会把机器拖死
- **进度与重试**：管理页实时显示每个任务进度；失败可一键重试，保留每次尝试历史
- **重启不丢任务**：服务崩溃或重启后，未完成任务自动重新入队，中断的临时产物自动清理
- **自适应播放**：hls.js 根据网速自动切清晰度，支持手动选档，并实时显示当前实际播放档位
- **防盗链**：master/variant/ts 三层资源全部 HMAC-SHA256 签名 + 过期时间，逐层接力重签
- **单二进制部署**：前端页面与 hls.js 通过 `go:embed` 打进可执行文件，运行期零公网依赖
- **纯 Go SQLite**：使用 modernc.org/sqlite，无需 CGO、无需额外数据库

## 环境要求

- Go 1.22+（构建用，本机已验证 1.27）
- ffmpeg / ffprobe 已安装并在 PATH 中（需含 libx264；AAC 用 ffmpeg 原生编码器）
- 验证版本：ffmpeg 9.0.2

## 快速开始

```bash
# 1. 构建（产出单个可执行文件）
go build -o bin/vod-server.exe ./cmd/server

# 2. 启动（默认监听 :8080，数据写 ./data）
./bin/vod-server.exe

# 3. 浏览器打开管理页
#    http://127.0.0.1:8080/
```

上传视频后会自动排队转码，状态变为“可播放”后点击卡片上的“播放”即可。
`samples/` 下提供了 Sintel 预告片（© Blender Foundation，CC BY 3.0）用于测试。

## 配置

全部配置通过环境变量提供，均为可选项，见 [.env.example](.env.example)。常用项：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VOD_ADDR` | `:8080` | HTTP 监听地址 |
| `VOD_DATA_DIR` | `data` | 数据根目录（数据库、密钥、上传、HLS 产物） |
| `VOD_WORKER_CONCURRENCY` | `1` | 同时运行的 ffmpeg 数量 |
| `VOD_MAX_UPLOAD_BYTES` | `5368709120`（5GB） | 单文件上传上限 |
| `VOD_SEGMENT_SECONDS` | `6` | HLS 分片时长（秒） |
| `VOD_SIGN_TTL` | `7200` | 签名默认有效期（秒） |
| `VOD_HMAC_KEY` | 自动生成 | base64 签名密钥，多实例共享时配置 |
| `VOD_FFMPEG_PATH` / `VOD_FFPROBE_PATH` | `ffmpeg` / `ffprobe` | 可执行文件路径 |

## 目录结构

```
cmd/server/        程序入口与路由装配
internal/config/   环境变量配置
internal/model/    领域模型与状态常量
internal/store/    SQLite 连接、迁移、视频与任务数据访问
internal/media/    ffprobe 探测、码率定档、ffmpeg 命令、进度解析、master 生成
internal/worker/   转码调度池、单任务编排、启动恢复
internal/sign/     HMAC-SHA256 签名与密钥管理
internal/hls/      签名校验、m3u8 动态重写、媒体分发
internal/handler/  HTTP 接口
internal/web/      嵌入的前端页面与静态资源（含本地 hls.js）
data/              运行期数据（不入库）：vod.db、secret.key、uploads/、hls/
```

## 工作机制

### 码率定档

固定模板 360p/800k、480p/1200k、720p/2500k、1080p/5000k，在此基础上：

1. 剔除高度超过源片的档位（禁止升分辨率）；
2. 每档视频码率不超过源视频码率、也不超过源总码率扣除音频后的余量（码率封顶而非丢档）；
3. 始终保留最低档，保证任何源都至少有一条可播流。

例如一个总码率仅 1.17Mbps 的 720p 源，会产出 360p/480p/720p 三档，后两档码率自动压到源水平，
既保留原片清晰度又不浪费带宽。

### 队列与重启恢复

- worker 用信号量控制并发，通过单条 `UPDATE ... RETURNING` 原子认领任务；
- 转码产物先写 `data/hls/<id>.tmp/`，成功并校验齐全后原子切换到正式目录；
- 启动时把所有残留 `processing` 任务重置为 `pending`，并清理 `.tmp` 目录，任务整体重跑、不丢失。

### 防盗链签名

- HMAC-SHA256 对 `路径 + 过期时间` 签名，查询参数为 `exp` 与 `sign`；
- master playlist 中的 variant 地址、variant 中的 ts 地址，在每次响应时用当前时间重新签名（接力刷新）；
- m3u8 有效期覆盖“视频时长 + 10 分钟”，避免长视频看到一半失效；播放器遇到 403/410 会自动续签续播；
- 路径做 UUID 与文件白名单校验，拦截目录穿越。

## Windows 常驻运行

### 方式一：nssm 注册为服务（推荐）

1. 下载 [nssm](https://nssm.cc/)；
2. 管理员命令行执行：

```bat
nssm install VodHLSServer "E:\...\vod-server.exe"
nssm set VodHLSServer AppDirectory "E:\...\vod-hls-server"
nssm set VodHLSServer AppEnvironmentExtra VOD_ADDR=:8080 VOD_WORKER_CONCURRENCY=1
nssm start VodHLSServer
```

### 方式二：任务计划程序

创建“计算机启动时”触发的任务，操作指向 `vod-server.exe`，起始目录设为项目根目录，
勾选“不管用户是否登录都运行”。

> 建议把 `data/` 目录加入杀毒软件排除项，避免实时扫描 `-wal`/`-shm` 文件造成数据库偶发锁。

## 常用接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/videos` | multipart 上传视频并创建转码任务（字段 `file`，可选 `title`） |
| GET | `/api/videos` | 视频列表（含最新任务状态与进度） |
| GET | `/api/videos/{id}` | 视频详情与任务历史 |
| POST | `/api/videos/{id}/retry` | 失败重试（新建任务） |
| DELETE | `/api/videos/{id}` | 删除视频并级联清理文件 |
| GET | `/api/videos/{id}/play-url` | 获取签名后的 master playlist 地址 |
| GET | `/hls/v/{id}/{file}` | 签名校验后分发 m3u8/ts |
| GET | `/healthz` | 健康检查 |

## 开发与测试

```bash
go vet ./...          # 静态检查
go test ./...         # 单元测试（含真实 ffmpeg 转码测试，需本机安装 ffmpeg）
go build ./...        # 编译
```
