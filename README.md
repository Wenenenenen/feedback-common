# 三对三组队匹配服务

整队（1–3 人）排队、精确选择合法六人组合、原子分房的匹配服务，附带一个可交互的调试网页。
纯 Python 标准库 + SQLite，无第三方依赖。

```
python3 -m pma --port 8765 --db data/matches.db
# 打开 http://127.0.0.1:8765/
```

## 规则实现

| 规则 | 实现位置 |
| --- | --- |
| 每票 1–3 人，整队不可拆分 | `pma/model.py` 校验；`pma/matcher.py` 以整票为单位分配 |
| 队列上限 24 张活动票 | `pma/storage.py::join`（事务内计数） |
| 票阈值 `min(400, 100 + 10·floor((now-createdAt)/1000))` | `matcher.threshold_for` |
| 六人最大 skill − 最小 skill ≤ 任何入选票阈值 | `matcher._iter_combination_candidates` |
| 地区仅 r1/r2/r3，缺地区不可用，六人 ping ≤ 80 | `matcher._view` / 地区循环 |
| 候选排序键 | `Candidate.sort_key`（见下） |
| 每轮取全局最小、移除、重算 | `matcher.run_matching` |
| 房间号随 tick 递增 | `storage.tick` |
| 请求键幂等、同键异载荷 409 | `storage._lookup_request` |
| 分房与票据状态原子落盘 | 单一 `BEGIN IMMEDIATE` 事务 |
| 重启后可查旧请求结果 | `requests` 表（响应 JSON 永久保留） |

### 排序键

依次为：

1. 入选票按 `(createdAt, id)` 升序形成的序列；
2. `|A 队 skill 总和 − B 队 skill 总和|`；
3. 该地区六人的最大 ping；
4. 地区名；
5. 规范化 A 队成员 ID 序列；
6. B 队成员 ID 序列。

两队无标签：各自成员 ID 排序后，字典序较小的队记为 A。序列按逐项字典序比较。

候选组合的生成顺序就是排序键的第一项：`itertools.combinations` 按人数分组后由
`heapq.merge` 合并成单一字典序流，因此可以**边生成边取全局最小**，既能精确求解，
又能让调试接口分页浏览，无需先物化全部候选。

24 张票的全部六人组合约 19 万个，低于内部预算（`MATCH_BUDGET = 1_000_000`），
所以 24 票上限内求解总是精确的，不会截断。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/tickets` | `{requestKey, id, members}` 入队 |
| POST | `/cancel` | `{requestKey, ticketId}` 取消 |
| POST | `/tick` | `{requestKey, now}` 推进逻辑时钟并匹配 |
| GET | `/state` | 时钟、票、房间、计数 |
| GET | `/requests/{requestKey}` | 某次写请求的永久结果 |
| GET | `/requests?limit=` | 最近请求记录 |
| GET | `/debug/candidates?offset=&limit=&now=` | 按排序键排列的候选 + 淘汰原因 |
| POST | `/admin/reset` | 清空数据库（仅调试/联调用） |

### 写请求语义

- 成功写操作返回**完整结果 JSON**，并按 `requestKey` 永久保存。
- 同键 + 同规范化 JSON 载荷（键序、空白不影响）→ 返回原结果，**不重复执行**。
- 同键 + 不同载荷 → `409 request_key_conflict`。
- 失败的写操作整体回滚，不留下请求记录，修正后可用同一个键重试。
- `requestKey` 跨路由复用同样算冲突。

### 取消语义

| 场景 | 结果 |
| --- | --- |
| 取消排队中的票 | `200`，终态 `cancelled` |
| 取消已取消的票 | `200`，`alreadyCancelled: true`，返回原取消终态与 `cancelledBy` |
| 取消已分房的票 | `409 ticket_already_matched`（含 `roomId`） |
| 取消不存在的票 | `404 ticket_not_found` |

`ticketId` 永久唯一：即使票已取消，也不能再用同一个 id 入队。

### 并发

- 每个线程独立 SQLite 连接，WAL + `busy_timeout=30s`。
- 所有写操作在 `BEGIN IMMEDIATE` 中执行，SQLite 串行化写者。
- 取消与推进同时发生时只有一个先提交：取消先提交 → 票离开队列、不进房间；
  推进先提交 → 票已分房、取消返回 409。**不会出现一人进两个房间。**
- `room_members(member_id)` 上有唯一索引，作为应用层检查之外的数据库级兜底。
- 同一 `requestKey` 的并发重试只有一个真正执行，其余返回同一结果。

## 淘汰原因（无候选时）

`GET /debug/candidates` 的 `diagnosis` 会遍历所有六人票组合，按**第一个不满足的规则**
归类，每类给出数量与示例：

- `insufficient_players` 人数不足（含「玩家够但票面凑不出恰好 6 人」）
- `party_unsplittable` 整队无法分边（如 2+2+2）
- `skill_spread_exceeded` 分差超限
- `no_common_region` 无共同地区（列出每个地区被哪些票卡住）

扫描有预算（默认 20 万组合），超出时 `truncated: true` 明确告知结果不完整。

## 调试网页

`http://127.0.0.1:8765/` 提供：

- **编辑票据 / 入队**：每票 1–3 名成员，逐地区填写 ping（留空 = 该地区不可用）。
- **队列**：状态、`createdAt`、房间归属；可取消、载入编辑器、复制为新票。
- **候选分房（并排）**：按排序键排列的每个候选，显示入选票、A/B 队成员与总分、
  实力差、最大延迟、地区，以及原始排序键。
- **淘汰原因**：四类原因并列展示，带示例。
- **房间**：A/B 队归属、实力差、延迟、所属 tick。
- **请求记录**：点击任一记录通过 `GET /requests/{key}` 重放，验证结果永久保留。
- **取消 / 推进并发实验**：同时发出取消与推进，显示谁的 `requestKey` 先提交、
  票的终态与房间归属。
- 顶部可推进逻辑时钟（可跳 +5 秒），也可用「预览时钟」只看候选不落盘。

## 测试

```bash
python3 -m unittest discover -s tests -t .        # 54 项，含并发与重启
python3 tools/replay_samples.py samples/party-match-allocator-cases.zip
python3 tools/smoke_http.py http://127.0.0.1:8765 samples/party-match-allocator-cases.zip
```

`tests/test_concurrency.py` 覆盖：

- 取消与推进 20 轮真实竞争，逐轮断言「取消成功 ⇒ 无房间」/「推进成功 ⇒ 取消必须 409」；
- 4 个 tick 并发抢同一队列，断言没有任何玩家出现在两个房间；
- 30 个并发入队，队列严格不超 24；
- 同一 `requestKey` 10 路并发，只执行一次且返回同一结果。

`tests/test_http.py::PersistenceTests` 关闭服务后用同一数据库重启，断言
`/state`、`/requests/{key}` 与房间编号递增都延续。

## 设计取舍

- **精确而非贪心**：候选流本身按排序键有序，取第一个即全局最小，等价于全量排序后取首。
- **整票参与**：房间只记录「哪些票」，队伍由票集合划分，天然保证不拆队。
- **原子性优先**：分房、票状态、请求记录、房间号计数在同一个事务里，任何一步失败整体回滚。
- **诊断可解释**：不是只返回「没匹配」，而是说明卡在人数、分边、分差还是延迟。
