# 跨区演练服务（zone handoff）

多人副本玩家跨区演练：切区期间源区冻结、目标区确认后才提交，提交把归属与纪元一起切换；
旧区多收一次操作绝不能把状态分成两份。服务还会在"落盘成功、应答发出前"被杀掉，
重启必须恢复到对应阶段，且日志尾部截断只丢半条、中段校验失败拒绝启动。

样例与落盘格式见 [`samples/zone-handoff.json`](samples/zone-handoff.json)。本项目没有使用任何
现成的事务协调器或日志引擎：帧日志、重放、去重、恢复都由 `internal/wal` 与
`internal/engine` 自己实现。

## 快速开始

```bash
./scripts/dev.sh start      # 构建并在 http://127.0.0.1:8080/ 启动（后台）
./scripts/dev.sh supervise  # 前台守护：模拟崩溃（exit 71）后自动重启并恢复
./scripts/dev.sh status
./scripts/dev.sh restart    # 崩溃演示后用它把进程拉回来
./scripts/dev.sh reset      # 停服并删除日志，回到样例基线
./scripts/dev.sh run        # 前台运行（不自动重启）
```

做崩溃演练时推荐 `supervise`：在页面布置崩溃点、发请求后，进程会按设计死掉，
守护循环立刻用同一份日志重启，页面自动重连并显示恢复后的阶段。

打开页面即可发动作、推进切区、查看实体/迁移/日志，并在"冻结、确认、提交、动作"四个步骤上
布置一次性崩溃点。

```bash
go test ./...                        # 单元 + HTTP 集成测试
go test -race ./...
go run ./cmd/loadgen -n 20000        # 端到端 2 万条动作，超过 8s 预算即失败
```

## 语义

| 规则 | 实现位置 |
| --- | --- |
| 新动作必须从**当前归属区**和**当前纪元**提交 | `internal/engine/action.go` |
| 序号按实体递增、不能跳号（跨区也连续） | 同上 |
| 冻结时返回可重试错误，且**不消耗**该序号 | 同上，`entity_frozen` + `expected_seq` |
| 已落盘的同序号同载荷重试→返回原结果；换载荷→冲突 | 同上；去重**先于**归属核对 |
| 同一实体只能有一笔进行中的切区 | `internal/engine/move.go` |
| `begin` 冻结源区；`confirm` 目标区确认；`commit` 归属切到目标区、纪元 +1；`abort` 只在提交前有效、按原纪元解冻 | 同上 |
| 同一迁移号 + 相同参数的步骤重试返回原步骤结果；已终结的迁移号不能发起新迁移 | 同上 |
| 成功应答在 fsync 之后 | `internal/wal/writer.go` + `Engine.settle` |
| 读取只暴露已 fsync 的前缀 | `Engine.pub`（durable published view） |
| 尾部截断只丢半条，中段校验失败拒绝启动 | `internal/wal/wal.go` |
| 一帧 = `uint32 LE 长度` + JSON + `uint32 LE CRC-32(JSON)`，长度 1..16777216 | 同上 |

补充约定：

* 动作的 `seq` 从 1 开始；冻结期间的冲突会带 `expected_seq`，客户端可在提交后原样重试该序号。
* 提交后，旧区/旧纪元的请求得到 `wrong_owner`；若该序号其实已经落盘，则按"去重优先"返回原结果。
* 迁移号是终态资源：`abort` 之后同一个迁移号不能重新 `begin`（返回 `move_conflict`
  或原 `begin` 应答，取决于参数是否一致）。
* `Entity` 快照里 `frozen`/`move` 让网页与客户端能直接看到冻结归属。

### 错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `bad_request` | 400 | 字段缺失、delta 越界（±1000000）、未知 op |
| `not_found` | 404 | 实体或迁移不存在 |
| `entity_frozen` | 409 | 冻结中，可重试；带 `expected_seq` |
| `wrong_owner` | 409 | 归属区或纪元不是当前值 |
| `seq_not_next` | 409 | 序号跳号（应为 `当前 seq + 1`） |
| `seq_payload_conflict` | 409 | 同序号已提交但载荷不同 |
| `move_in_progress` | 409 | 该实体已有进行中的切区 |
| `move_not_confirmed` | 409 | 未 `confirm` 就 `commit` |
| `move_terminal` | 409 | 迁移已提交/已取消，不能再继续 |
| `move_conflict` | 409 | 同迁移号但参数不同 |

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 演练网页 |
| `POST` | `/api/action` | 单条动作：`{"id","zone","epoch","seq","delta"}` |
| `POST` | `/api/batch` | 批量动作：`{"items":[{...}, ...]}`，一次落盘；逐条返回结果 |
| `POST` | `/api/move` | `{"op":"begin|confirm|commit|abort","id","move","to"}` |
| `GET` | `/api/state` | 实体、迁移、恢复信息、崩溃点、日志大小 |
| `GET` | `/api/log?from=-1&limit=200` | 日志分页；`from=-1` 表示尾页 |
| `GET/POST` | `/api/crash` | 查看/布置一次性崩溃点：`{"op":"action|begin|confirm|commit|abort|"}` |
| `GET` | `/api/health` | 存活与日志字节数 |

`/api/batch` 的 `items` 按顺序在同一把锁内校验，因此后一条能看到前一条的效果；
被拒绝的条目单独报错，不中断整批。整批共用一次 fsync。

## 崩溃恢复

崩溃点通过 `SetCrashPoint` 布置，`Engine.settle` 在**帧已 fsync、应答尚未写出**时触发。
服务端钩子直接 `os.Exit(71)`（`cmd/server/main.go`），因此客户端只会看到连接被断开
（curl: `Empty reply from server`）。重启后：

* `begin` 后崩溃：实体仍冻结、迁移 `begun`；重试 `begin` 返回原应答。
* `confirm` 后崩溃：迁移 `confirmed`、实体仍冻结；重试 `confirm` 返回原应答，`commit` 才能推进。
* `commit` 后崩溃：归属已是目标区、纪元已 +1、实体解冻；重试 `commit` 返回原应答且不再 +1。
* `action` 后崩溃：值已生效；用同序号同载荷重试返回原结果，不会二次累加。

崩溃点是内存状态，重启后自动清空（页面会显示"崩溃点：无"）。

## 日志与恢复细节

* 写入端是 group commit：并发提交在后台合并成一次 `write` + `fsync`；
  `Submit` 只排队，`Wait(seq)` 返回后调用者才允许应答。
* 每个记录都内嵌它自己的应答字节（`resp`），所以重试在重启前后都能返回**逐字节相同**的结果。
* `Replay` 每帧校验长度与 CRC：尾部不足一帧 → 截断到最后一个完整帧并上报
  `torn_tail`/`truncated_bytes`；完整帧 CRC 错或长度越界 → 返回 `ErrCorruptMidLog`，
  `cmd/server` 打印错误后退出（拒绝启动），不修改文件，便于取证。
* 读取视图 `pub` 只在记录对应 seq ≤ 已 fsync 的 seq 时才推进，
  因此 `GET /api/state` 不会展示一次崩溃就会丢失的状态。

## 性能

`4 核 8GB`、本机 NVMe 下：

```text
$ go run ./cmd/loadgen -n 20000 -batch 1000
applied=20000 elapsed=298ms rate=67213/s  final_seq=20000 final_value=20010
OK within 8s budget

$ 单个 2 万条 batch（HTTP 一次请求，一次 fsync）
status=200 took=161ms applied=20000
GET /api/state     < 1ms
GET /api/log 尾页   1ms

$ 重启重放 2 万帧
restart=0.46s
```

注意：按序号串行依赖意味着单条动作在**单连接串行**时受 fsync 节流（约 300/s）。
要跑满 8s / 2 万条的指标，请用 `/api/batch`（一次落盘一批），
或在客户端保持多个在途请求（32 路并发实测 ≈ 5 万/s）。

## 目录

```text
cmd/server        服务入口
cmd/loadgen       端到端压测（2 万条 / 8s 预算）
internal/wal      帧日志：Replay、Writer（group commit）、长度/CRC 校验
internal/engine   状态机：动作、切区、去重、恢复、批量
internal/server   HTTP 路由 + 内嵌网页（index.html）
scripts/dev.sh    构建/启动/停止/重启/重置
samples/          题目样例
```

## 数据目录

默认 `data/`（已在 `.gitignore` 中）：

* `data/journal.wal` — 帧日志，重启基线的唯一来源
* `data/server.log` — 后台运行日志
* `data/server.pid`、`data/bin/` — 进程号与构建产物

基线实体每次启动都从 `samples/zone-handoff.json` 读取，必须保持一致，否则重放语义会变。
