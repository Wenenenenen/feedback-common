# 观战快照分片通道联调台

针对游戏观战场景的确定性分片协议模拟器与联调网页。复现并排查两类问题：网络抖动时旧画面覆盖新画面、旁观席收到本不该显示的实体。

## 运行

```bash
# 单元测试（协议编解码 + 收发状态机 + 确定性，26 项）
node --test tests/protocol.test.js tests/simulator.test.js

# 网页（任意静态服务器，需 ES module）
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080/index.html

# 浏览器端到端测试（需本机 Playwright）
node tests/browser-e2e.mjs
```

## 线格式（对齐 samples/spectator-channel.json）

每席一条独立字节通道，分片结构：

```
| tick:u32 | base:u32 | index:u16 | total:u16 | 载荷 ≤256B | CRC32/IEEE:u32 |
```

- 全小端；片头 12 字节，CRC 覆盖片头与载荷，小端 4 字节。
- 记录连续排列：删除 `tag=0, id:u32, gen:u32`（9B）；新增/更新 `tag=1, id:u32, gen:u32, x:i32, y:i32`（17B）。
- 记录按 id 升序，同 id 删除在前。全量 `base=0` 且只允许 tag=1；空记录也发一片。
- `index` 从 0 起；`base` 为增量基线 tick，0 表示全量。

## 协议语义

**发端（每席）**
- 先按席位可见位过滤实体（`seenBy` 不进入协议），得到该席完整投影。
- 增量基线 = 该席最后确认且仍在保留环（最近 8 份）内的快照；否则发全量。
- 增量从基线拷贝再改：删除必须匹配老代数；id 复用换代先删老代再插新代。
- 确认只认该席已提交的帧号，不回退；收到全量恢复请求后下一次发送强制全量。

**收端（每席）**
- CRC/格式校验、同号片去重；收齐全部分片才原子提交，绝不显示半帧。
- 同号片内容冲突 → 整帧作废并请求全量恢复；删除代数不匹配、未删先换代同样作废。
- 严格按序提交，旧帧（tick ≤ 已提交）一律丢弃，旧帧不覆盖新帧。
- 缺增量基线 → 请求全量恢复；全量帧作为无条件新基线，可跨过缺口建立接续。
- 只保留已提交快照，最近 8 份。

**确定性**
- 同逻辑时刻的模拟动作按安排数组顺序处理；随机源为内置 MT19937，状态随检查点保存。
- 导出的网络安排可重新导入，重放得到完全相同的提交序列（见 `commitHash` 与逐帧比对）。

## 网络安排动作

| 类型 | 字段 | 含义 |
| --- | --- | --- |
| `drop` | at, seat, tick, index? | 丢弃分片（index 省略=整帧） |
| `corrupt` | at, seat, tick, index?, offset?, times? | 翻转字节致 CRC 失败 |
| `duplicate` | at, seat, tick, index?, at2? | 注入副本，at2 省略则同 tick 再投 |
| `delay` | at, seat, tick, index?, to | 改投递时刻，制造乱序 |
| `ack-delay` | at, seat, ticks, count? | 延后后续确认 |

## 代码结构

```
js/engine.js   纯 ES 模块：CRC32、线格式编解码、生成/脚本世界、发端、收端、确定性模拟器
js/app.js      UI 控制器：场景装载、逐帧渲染、调度、包查看、导入导出
css/app.css    工程控制台主题（明暗双态、响应式）
tests/         Node 单元测试与 Playwright 端到端测试
samples/       协议样例
```

引擎不依赖 DOM，可单独在 Node 引用。快照内部用并行类型化数组（SoA）存储，2 万帧 × 2048 实体整跑约 12 秒、堆内存约 80MB；检查点每 500 帧一份，支持快速 seek 且重放结果与整跑一致。
