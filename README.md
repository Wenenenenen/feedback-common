# 伙伴状态图调试台 · Companion Statechart Reel

伙伴角色（跟随动作 ‖ 表情）状态图的调试网页：**自研零依赖确定性运行器**，
支持单步（含内部事件 / 定时器微步）、可拖拽时间轴、事件轨迹、
快照导出 / 导回续跑。无需构建、无第三方运行时依赖。

样例与图格式见 [`samples/companion-chart.json`](samples/companion-chart.json)，
另含一个完整演示 [`samples/companion-parallel.json`](samples/companion-parallel.json)
（动作 × 表情并行、剧情打断 + 历史恢复、旧定时器失效）。

## 运行

直接用浏览器打开 [`web/index.html`](web/index.html) 即可（经典脚本，`file://` 也能用）。
或起静态服务：

```bash
npm start                 # = python3 -m http.server 8123 --directory web
# 打开 http://localhost:8123/
```

也可以：

```bash
cd web && python3 -m http.server 8000
```

## 测试

```bash
npm test                  # 契约语义 14 例（含 5 万输入规模）
npm run test:extra        # 时间轴重放 / 逐步快照 / 深层并行历史等 7 例
```

运行器同时兼容浏览器（全局 `CompanionRunner`）与 Node（`require('./web/runner.js')`）。

## 图格式（与 samples 一致）

```jsonc
{
  "root": 1,
  "vars": { "mood": 0 },              // 整数变量初值；guard 中未声明变量按 0
  "states": [
    { "id": 1, "initial": 2 },        // 普通复合节点：进入 initial
    { "id": 2, "parent": 1 },
    { "id": 3, "parent": 1,
      "timers": [{ "after": 8, "event": "rest" }] },
    // { "id": 9, "parent": 1, "parallel": true } // parallel：进入全部直接子节点
  ],
  "edges": [
    { "id": 1, "source": 2, "exitRoot": 1, "target": 3, "event": "follow",
      "guard": { "mood": 0 },         // 可选：变量整数等值表
      "set":   { "mood": 1 },         // 可选：赋值表
      "emit":  ["blink"],             // 可选：内部事件 FIFO
      "history": true }               // 可选：历史重入
  ],
  "inputs": [{ "ms": 0, "event": "follow" }]
}
```

上限：**512 状态 / 2048 转移 / 50000 输入事件**，超出在 `CompanionRunner.create`
编译期报错（错误信息分别含 `512` / `2048` / `50000`）。
`parallel` 也兼容 `"type" | "kind": "parallel"` 写法；状态可用 `name` / `label` 标注中文名。

## 运行语义（调试台严格实现）

- **进入**：普通复合节点进入 `initial`；`parallel` 节点进入全部直接子节点（按 states 数组顺序）。
- **一个事件可让多条转移一起生效**：
  - 所有 `guard` 一律读取本**微步步首**的变量快照，同一步内的 `set` 不影响本步守卫；
  - 候选边按 **source 节点深度降序、edge id 升序**排序；
  - 依次选入胜出边：若候选边的 `exitRoot` 与任一已选边的 `exitRoot`
    **相同或互为祖先**，丢弃后来者；
  - 胜出边严格按**选中顺序**执行：取旧历史 → 退出子树并记录 → 重入 → `set` → `emit`。
- **退出 / 重入 / 历史**：`exitRoot` 必须等于 `source` 或是其祖先（“包含 source”）。
  退出时记录该子树的**完整活跃配置**（含退出根自身、各并行分区的全部活跃状态 / 叶，
  按深度、id 排序）。重入时 `target` 指定一条 root→target 路径，途经 parallel 的
  其余分区走默认初始值；`history: true` 时优先恢复**上一次退出**记录的完整配置，
  从无记录则走默认。
- **定时器从属于“本次进入”**：进入状态时按 `after`（正整数 ms）登记，
  退出该状态（含被冲突 / 跨 exitRoot 退出）立即作废；到点发布内部同名事件。
  同毫秒多个有效定时器按**登记顺序**（全局 `timerSeq`）处理；
  **同毫秒定时器先于外部输入**，外部输入之间按（稳定排序后的）输入顺序。
- **内部事件 FIFO**：一个顶层事件（外部输入或定时器）`emit` 出的内部事件按入队顺序
  排空，处理中再 `emit` 的事件排到队尾；全部排空后才处理下一个顶层项。
- **生效微步与回滚**：只有存在胜出边的事件才计为一个“生效微步”，无转移事件不计。
  同一顶层项（含其内部事件链）累计 **超过 256 个生效微步**时，把机器状态回滚到该
  顶层项开始前的检查点，追加一条 `kind:"rollback"` 轨迹并永久 `halted`；
  已产生的 256 条生效轨迹保留，便于复盘是哪条链失控。

## 编程接口（测试契约）

```js
const R = require('./web/runner.js');
const r = R.create(chart);
r.step();          // 投递下一个事件，返回该轨迹条目
r.runToEnd();      // 跑到无下一项 / halted / 安全上限
r.hasNext();
r.serialize();     // JSON 安全的纯状态
r.restore(state);
r.spawn(state);    // 同编译结果 + 纯状态派生 runner（时间轴重放用）
r.state;           // time, config[], vars, timers[], queue[], history{},
                   // nextInput, timerSeq, halted, haltReason, micro, effective, ...
r.trace;           // {seq, ms, kind, event, fired[], effective, ...extra}
```

## 调试网页功能

- **单步**：一次一个微步（输入 / 定时器 / 内部 / 回滚）；**上一步**、**重置**；
  **下一输入**直接跳到下一条外部输入被处理；**播放 / 暂停**分块自动推进，不卡 UI。
  键盘 `→` / `←` / `Home` 单步 / 回退 / 回零。
- **状态图**：递归嵌套盒表达复合节点，虚线双栏表达 parallel 分区；当前配置高亮，
  当前微步胜出边在图上绘制连线与 `#id event` 标签（回滚候选为红色虚线），
  转移列表同步高亮，可按事件 / 状态 / id 筛选。
- **实时检查器**：变量、挂起定时器（到期时间 / 剩余 ms / 登记序号）、
  内部事件 FIFO、各 `exitRoot` 的历史配置，以及“本微步解说”。
- **时间轴**：拖动滑块到任意微步。每 64 步存一个纯状态检查点，拖动时从最近检查点
  确定性重放至多 63 步，因此 50000 输入也不爆内存、拖动保持流畅。
- **轨迹**：虚拟滚动只渲染可见行，5 万行不卡顿；点击任意行跳转，类型 / 时间 /
  胜出边一目了然，播放时自动跟随当前步。
- **导出 / 导入快照**：导出 `{kind,version,chart,cursor,state,trace}` JSON
  （图定义 + 游标处完整机器状态 + 完整轨迹）。导回时会**从头确定性重放校验**，
  提示与快照是否一致；确认后继续运行，转移、变量与事件轨迹和不中断的原运行完全一致。
  也兼容测试用的裸 `{chart,state,trace}` 快照。
- **规模**：事件名 → 转移的预排序索引 + 活跃状态集合，5 万输入端到端约 0.6s
  （Node 22，含编译）；UI 侧后台分块推演，时间轴逐步填满。

## 目录

```
web/runner.js    确定性运行器（浏览器 / Node 通用，无依赖）
web/index.html   调试台结构
web/style.css    深色仪器台主题 + 响应式
web/app.js       时间轴 / 虚拟轨迹 / 快照 / 状态图渲染
tests/           Node 语义测试（契约 14 例 + 增强 7 例）
samples/         基础样例与并行剧场样例
```
