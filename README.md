# ECS 屏障调试台

原型（archetype）列存储 + 带代数句柄的 ECS 原型，配套一个单页调试台。引擎不用任何现成 ECS 库。

## 打开

- 直接双击 `index.html`（单文件，样式、引擎、界面都已内联，离线可用）。
- 修改源码后重建：

```bash
node build.js            # 写 index.html
node tests/engine.test.js /tmp/ecs-cases   # 引擎测试（26 项）
node tests/page.test.js                    # 页面测试（需要 playwright）
```

`samples/ecs-barrier-inspector-cases.zip` 是原始样例；解压后把目录传给 `engine.test.js` 即可用真实样例跑回归
（`samples/cases/` 里另存了三个小样例的副本）。

## 源码

| 文件 | 作用 |
| --- | --- |
| `src/engine.js` | 世界、原型列存储、句柄、命令屏障、三个系统、快照。Node 与浏览器共用。 |
| `src/app.js` | 界面：命令录入、单步、原型/查询/迁移/事件/槽表、按句柄定位、快照。 |
| `src/styles.css` | 令牌化的浅色/深色主题。 |
| `src/page.template.html` | 页面骨架，`build.js` 把上面三份内联进去。 |

## 规格落点

- **组件**：`Position{x,y}`、`Velocity{x,y}`、`Health{value}`、`Poison{amount}`、`Frozen{}`、`Spawner{period,vx,vy}`，全部 int32 校验；`period > 0`、`amount >= 0`。未知字段/缺失字段/非整数/越界一律在命令执行时拒绝，只影响该条命令。
- **句柄** `{slot, generation}`：slot 从 0 递增、generation 从 1 起。销毁只把该槽 generation +1 并放回最小堆；分配总取最小空槽，否则扩展。代数不符报 `过期句柄`，槽已空报 `实体为空`，因此旧引用永远改不到复用后的新实体。
- **原型**：不同组件组合即原型；每个组件字段一列，行内连续。迁移时目标原型先追加行、源原型用行尾换位删除，同时维护 slot→(原型, 行) 映射。
- **命令屏障**：外部命令先入 `externalPending`，每个 tick 开头按 seq 升序 flush（seq 全局唯一，重复即失败）。三个系统顺序固定：`integrate`（Position+Velocity 且无 Frozen，按 slot、generation 排序）→ `damage`（Health+Poison，结果 ≤0 排入销毁）→ `emit`（Spawner+Position，`tick % period == 0` 生成子体）。系统产生的结构命令带独立递增内部编号 `iseq`，在三个系统之后按产生顺序 flush。普通写即时生效，结构变更屏障后生效，所以待销毁的生成器当步仍会生成子体，而新生子体下一 tick 才参与系统。
- **查询**：包含集/排除集，交叠直接报错；结果按 slot、generation 稳定排序。
- **int32 溢出**：`integrate` 与 `damage` 的写入若越界，该实体在该系统跳过并记录 `overflow` 事件，不写不溢出值，其他实体照常。
- **快照**：槽代数（含空槽）、空槽最小堆、原型列、slot→(原型,行) 映射、`externalPending`、`systemPending`、外部 seq 历史、内部命令计数、tick 一并保存。恢复后句柄分配、查询结果、事件指纹与连续运行一致。页面的“恢复一致性校验”会把世界克隆两份，其中一份每个 tick 都经过 JSON 往返，逐 tick 对比指纹、槽表、查询和事件数。
- 上限：10000 存活实体、20000 条待执行外部命令。

## 界面

- 顶栏：单步、×10、播放、重置；时钟条显示 tick、存活、两个待执行队列、原型/槽、状态指纹。
- 录入命令：按操作显示字段，支持句柄、组件值、组件组合勾选；可查看将生成的 JSON；可批量粘贴命令数组，或载入内置样例（复用/屏障/迁移/压力）。
- 原型与列：每个原型可展开成列视图（行号、句柄、各字段列）。
- 查询：点组件循环 包含 → 排除 → 忽略，另有三个系统查询预设。
- 迁移与屏障：最近一次 tick 的五段流水、迁移边统计、最近迁移列表。
- 事件轨迹：按类型筛选、只看失败与溢出、分页；点带句柄的事件可定位实体。
- 槽与代数：每个槽的代数、存活状态、所属原型与行号；空槽也列出代数。
- 右侧：按句柄定位、实体详情（组件值 + 该槽最近事件）、世界状态。
- 快捷键：`n` / `→` 单步，`1`–`5` 切标签页，`Esc` 停止播放。
