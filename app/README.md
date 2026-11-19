# RTS 生产队列网页验证器

固定 100ms 逻辑步的即时战略生产队列模拟器，用于核对**科技加速、人口卡住、取消退款**叠加时
队列剩余时间与资源账本是否一致。全部工作量、速度、倍率用 BigInt 精确分数运算，
分数累计不经过浮点，资源/人口为整数。

## 规则实现（对应样例包 `说明.txt`）

| 规则 | 实现位置 |
| --- | --- |
| tick 从 0 开始，每步 100ms，work/速度均为精确有理数 | `src/fraction.js`（BigInt 分数，自动约分） |
| 步骤顺序：本 tick 指令（按 seq）→ 应用上步科技倍率 → 建筑按 ID 升序处理 | `engine.js` 的 `step()` |
| 初始实例按建筑 ID 升序、队列从前到后分配从 1 递增编号，视为已付款、进度 0 | 构造函数 `#addInstance(..., paid=true)` |
| 未暂停建筑先交付队首 ready 成品，能交付才继续 | `step()` 中 `#tryDeliver` 前置 |
| 本步预算 = 建筑 speed × 全局倍率；完成项剩余预算给下一项；不跨 tick 保留 | `step()` 的 budget 循环 |
| 项目在步中途完成，剩余工作量留给后续项目 | `budget.sub(remaining)` 继续循环 |
| unit 超人口：保留 ready、占住队首、丢弃本步剩余预算 | `#canDeliver` 失败分支，发 `ready`+`blocked` 事件 |
| research 立即移除，倍率累积到**下一 tick** 才乘入全局 | `pendingMultipliers`，下一步开头应用 |
| 遍历顺序不受建筑输入顺序影响 | 构造时按代码点排序存 `buildingOrder` |
| cancel 逐资源退款 `floor(cost*(work-progress)/work)`，再按仓上限截断；未开工全退、ready 不退 | `#executeCommand('cancel')` + `Fraction.floor()` |
| destroy 不退且清队列 | `#executeCommand('destroy')` |
| reorder 只允许未取得工作量的非 ready 实例，且必须是完整新顺序 | `#executeCommand('reorder')` |
| 资源不足或参数非法拒绝该指令，后续指令继续 | 每条指令独立 try/catch，发 `accepted:false` 事件 |
| 上限 32 建筑、每队 8 实例 | `MAX_BUILDINGS` / `MAX_QUEUE` 校验 |

实时界面编辑（入队、取消、重排、暂停、摧毁、grant、release）通过 `scheduleLive` 登记到
当前 tick 的指令表，下一次单步时在指令阶段按自动分配的 seq 执行——因此保存/恢复与回放完全确定，
且与预置指令共用同一套 seq 空间（自动避开已用编号）。

## 目录

```
app/
  src/fraction.js          精确有理数
  src/engine.js            模拟引擎（零 DOM 依赖，可在 Node 直接跑）
  src/ui.js                网页控制层（渲染/交互，逻辑全部委托引擎）
  index.template.html      页面结构与样式
  build.mjs                把三个 ES 模块内联打包成单文件
  build/index.html         构建产物（单文件，cases/ 为内置用例）
  test/run-cases.mjs       5 个样例 expected 断言（28 项）
  test/run-edges.mjs       边界规则（退款档位/重排/上限/快照/科技连乘等）
  test/browser-smoke.mjs   无头 Chromium 真实交互冒烟（25 项）
```

## 运行

```bash
# 逻辑测试（无需浏览器）
node app/test/run-cases.mjs work/cases-extract
node app/test/run-edges.mjs

# 构建单文件网页
node app/build.mjs        # 产物 app/build/index.html

# 本地预览
cd app/build && python3 -m http.server 8731
# 浏览器打开 http://localhost:8731/index.html
```

## 网页能力

- 载入内置 5 个用例或上传任意符合规则的 JSON；单步（空格键）、+10/+100、快进、重置
- 每座建筑卡片显示本步预算、每个项目的精确进度分数与百分比、造价、ready/阻塞状态
- 入队（立即扣款）、取消（显示退款）、未开工项目上下移动重排、暂停/恢复、摧毁
- 顶部实时显示 tick、逻辑毫秒、全局倍率、人口（进度条，满员变红）
- 逐步账本可按 工作量 / 资源人口 / 完成阻塞指令 过滤，每笔含 before→after、Δ、应计值、触顶截断标记
- 保存到浏览器本地 / 恢复；导出无损快照 JSON；导出 TSV 结算日志（含资源净变化、人口净变化、精确累计工作量）
- 双主题（跟随系统，亦可强制）、手机窄屏单栏无横向滚动

## 精度说明

所有 Fraction 以最简 BigInt 分数存储，账本事件里的工作量序列化为 `[分子, 分母]` 字符串。
退款的 `floor` 是分数精确向下取整（`Fraction.floor`），不存在“浮点累加后逐步取整”的误差路径；
界面上的小数/百分比仅用于展示，从不回写状态。
