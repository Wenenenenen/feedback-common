# 响应式行为树调试器（reactive-tree-courier）

NPC 行为树的网页编辑与调试工具，针对两个典型 bug 场景设计：

- **高优先级任务抢占**：配送角色改了高优先级任务后仍把旧动作走完 —— 本工具的
  `reactiveSelector` 每 tick 从首个孩子重新求值，运行分支切换时递归中止旧子树、
  清除动作进度（等待计数、序列游标），并在轨迹中记录 abort 及原因；角色位置不回退。
- **存档恢复重复执行**：`memorySequence` 用游标记住运行中的孩子，已完成节点不会
  重新执行；快照完整保存游标/等待计数/运行分支，恢复后轨迹与不中断运行逐步一致
  （由 `test/engine.test.js` 的快照一致性用例保证）。

## 运行

纯静态页面，无构建步骤：

```bash
# 任选其一
python3 -m http.server 8000   # 然后打开 http://localhost:8000
# 或直接用浏览器打开 index.html
```

## 测试

```bash
node test/engine.test.js   # 引擎语义测试（对照 samples 中各用例的 expected 值）
node test/ui.smoke.js      # UI 冒烟测试（需要本机可用的 playwright + chromium）
```

## 功能

- **树图**：运行（蓝）/ 成功（绿）/ 失败（红）/ 中止（橙）/ 空闲（灰）五色状态，
  节点上显示参数摘要、等待计数、序列游标、选择器当前运行分支。
- **角色预览**：1m 网格、坐标轴、move 目标点、位置轨迹与实时坐标。
- **调试**：单步、固定 50ms 节拍播放/暂停、复位；黑板可直接编辑（JSON 值）；
  支持按 tick/seq 调度的黑板输入事件。
- **快照**：保存包含 tick、树版本、黑板、位置、序列游标、等待计数与运行分支的
  快照；快照绑定树版本，树被编辑后旧快照标记为不可恢复。
- **编辑**：点选节点修改类型与参数、增删/排序子节点、删除子树、重命名 id；
  也可直接编辑树定义 JSON。导入/编辑时校验：环、共享子节点、不可达节点、
  重复 id、无效参数（负 ticks、非正 speed、非标量 equals 等）、超过 128 节点上限。
- **轨迹**：逐条记录 tick、节点、旧状态 → 新状态与 abort 原因，以及输入事件、
  根结束复位、快照恢复等标记。

## 节点语义（依据 samples/说明.txt 实现，未使用现成行为树引擎）

| 类型 | 语义 |
| --- | --- |
| `reactiveSelector` | 每 tick 从首个孩子起取第一个非失败孩子；与上 tick 运行孩子不同则递归中止旧子树并记录 abort；全部失败即失败 |
| `memorySequence` | 记住运行中的孩子，成功立即访问下一个，失败立即失败；结束时整棵子树复位 |
| `condition` | 严格比较 JSON 标量 `blackboard[key] === equals`，缺 key 视为失败 |
| `set` | 立即赋值并成功 |
| `wait` | 激活时计数 0 并 running，随后每次访问 +1，到 `ticks` 成功；`ticks=0` 激活即成功 |
| `move` | 激活 tick 也前进 `speed*dt`（dt=0.05s），沿直线朝 target，剩余距离不足截到目标并成功；中止不回退位置 |

每 tick 先按 seq 应用该 tick 的全部黑板输入，再从根求值；根成功或失败时整树复位，
下一 tick 可再次激活。

## 文件

- `engine.js` — 引擎（校验 / 求值 / 快照），浏览器与 Node 通用
- `app.js` / `index.html` — 网页 UI
- `test/engine.test.js` — 语义与快照一致性测试
- `test/ui.smoke.js` — Playwright UI 冒烟测试
- `samples/` — 样例用例（含说明.txt 与 expected 值）
