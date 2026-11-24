# 有理样条节点工作室 · Rational Knot Studio

仪表轮廓用的 **2–5 次夹持有理 B 样条（NURBS 同族）编辑器**。所有有理运算都用
`bigint` 精确分数手写完成，没有使用任何现成样条编辑器/库。

- 按 `samples/rational-knot.json` 的格式导入，最多 **512** 个控制点；
- 用任意 `a/b` 分数插入内部节点，**齐次曲线逐点完全不变**（bigint 精确相等）；
- 删除节点必须同时满足：减点候选**权重全为正**，且把该节点**重插后每个齐次控制点
  `(X,Y,W)` 与原曲线完全相等**，否则拒绝，原曲线不变；
- 移点按投影坐标 `(x,y)` 并保留 `W`；改权重时保留投影位置，自动重算 `X=xW,Y=yW`；
- 指定任意参数 `u`，显示**精确分数坐标、齐次坐标、左/右导数**；端点只显示存在的一侧，
  重复节点分别按左/右极限给出两个不同的导数；
- 所有成功编辑可撤销/重做；任何失败操作都不改曲线、不写栈、**不清空 redo**；
- 导出**约分分数**曲线 JSON，以及每段带 `data-u0/data-u1` 的 SVG 折线；
  自适应细分保证每段在其参数区间内按参数线性插值时，与原曲线的欧氏误差
  **远小于 0.25 个导出坐标单位**（内部目标 0.06，独立 Python 复查最大约 0.06）。

## 运行

无需构建、无运行时依赖、无需联网。

- 直接双击/浏览器打开根目录 **`index.html`** 即可（全部是经典脚本，`file://` 可用；
  此时用内置的样例兜底，页面与 `samples/rational-knot.json` 数学上完全一致）。
- 或起静态服务器（会自动 fetch `samples/rational-knot.json`）：

```bash
python3 -m http.server 8765
# 打开 http://127.0.0.1:8765/index.html
```

## 目录

```
index.html              页面骨架（经典 <script>，file:// 可跑）
css/style.css           样式
js/frac.js              bigint 精确有理数 Frac（解析/约分/四则/十进制格式化）
js/engine.js            校验、Cox–de Boor 单侧基、精确求值与左右导数、
                        Boehm 节点插入、逆 Boehm+重插校验的节点删除、编辑原语、浮点求值
js/tessellate.js        自适应细分 + 0.25 误差 SVG 生成
js/studio.js            有状态 Studio：撤销/重做/失败事务、导入导出、纯数据 API
js/app.js               DOM、画布渲染、控制点拖拽、window.rksAPI
rks.mjs                 Node/验证脚本的 ESM 命名导出入口
tests/run-tests.mjs     275 项精确数学/历史/契约断言（node）
tests/acceptance.mjs    31 项对齐题目六个验收难点的专项（2^-60 精度/窄峰/负权…）
tests/stress.mjs        1000 项随机往返/失败安全/512 点性能
tests/e2e.mjs           57 项 Playwright 端到端（自动起服务，含 file:// 入口）
tests/drag-check.mjs    画布拖拽=一次撤销步的专项检查
tools/dump_exports.mjs  生成 /tmp/rks-check 导出产物
tools/independent_check.py  独立 Python(Fraction+Cox) 评分视角复查 SVG/JSON/齐次不变性
tools/acceptance_ap5.py     验收难点 5 的 Python 精确分数窄峰复查
```

## 自动化 / 验证接口（推荐直接驱动）

页面加载后有三个全局：

### `window.rksAPI`（最稳定的高层接口，全部同步）

```js
rksAPI.load(textOrObject)            // 导入并重置历史 -> {ok,error?}
rksAPI.insertKnot('1/3')             // 分数插入内部节点
rksAPI.removeKnotAt(3)                // 按 knots 出现下标删除
rksAPI.removeKnotValue('1/2')         // 按节点值删除一次出现
rksAPI.movePoint(i, '1/3', '-2/5')    // 投影坐标移点，保留 W
rksAPI.setWeight(i, '4')              // 改权重，保投影
rksAPI.undo(); rksAPI.redo()
rksAPI.canUndo(); rksAPI.canRedo(); rksAPI.history() // {undo,redo}
rksAPI.query('1/2')
// { ok,u,atStart,atEnd,
//   point:{x,y,xDecimal,yDecimal}, homogeneous:{X,Y,W},
//   left:{dx,dy,dxDecimal,dyDecimal}|null,
//   right:{dx,dy,...}|null }
rksAPI.json()        // 导出对象（format,degree,knots,points，全约分字符串）
rksAPI.jsonText(2)
rksAPI.svg()         // 导出 SVG 字符串
rksAPI.segments()    // {count,maxDeviation,limit:0.25,segments:[{u0,u1,...}],svg}
```

失败时这些方法返回 `{ok:false,error}`，且当前曲线与 undo/redo 栈均不变。

### `window.RKS`

包含全部底层模块：`Frac, parseCurveObject, queryAt, insertKnot, removeKnotAt,
moveProjectedPoint, setWeight, buildExportSVG, tessellate, Studio, INT_MAX_CP=512` 等；
`window.RKS.studio === window.rksStudio` 是页面正在使用的同一个 `Studio` 单例。
直接调用 `RKS.studio.*` 也会触发界面刷新。

### Node 中使用

```js
import { Studio, queryAt, insertKnot, Frac, buildExportSVG } from './rks.mjs';
```

`js/*.js` 同时是 CommonJS 兼容的 UMD 风格文件，也可
`const Engine = require('./js/engine.js')`。

## DOM 契约（Playwright 可直接用）

| 区域 | 选择器 |
| --- | --- |
| 撤销/重做 | `#btn-undo` `#btn-redo`，计数 `#history-info` |
| 样例/文件 | `#btn-load-sample` `#btn-open-file` `#file-input[type=file]` |
| 下载 | `#btn-download-json` `#btn-download-svg`，复制 `#btn-copy-json/#btn-copy-svg` |
| 状态/错误 | `#status-message`（失败时 class 含 `error`） |
| 参数输入/查询 | `#query-u` `#btn-query` |
| 精确坐标 | `#q-point`（带 `data-x/data-y` 精确分数字符串）；十进制 `#q-point-decimal`；齐次 `#q-homogeneous` |
| 左/右导数 | `#q-left-exact` `#q-right-exact`（带 `data-dx/data-dy`；不存在时文本为“不存在”，外层 `.qr-left/.qr-right` 有 `data-present="false"` 和 `.absent`） |
| 插入节点 | `#insert-u` `#btn-insert-knot` |
| 节点出现列表 | `#knot-list .knot-chip[data-select-r="<r>"]`，其中 `button[data-remove-r="<r>"]` |
| 选中节点/删除 | `#selected-knot` `#btn-remove-knot` |
| 移点表单 | `#cp-x` `#cp-y` `#btn-move-cp` |
| 权重表单 | `#cp-w` `#btn-set-weight` |
| 控制点表 | `#cp-tbody tr[data-i="<i>"]` |
| 画布 | `svg#stage`，手柄 `.cp-handle[data-i]`，节点 `.knot-marker[data-r]` |
| JSON 导出文本 | `textarea#export-json` |
| SVG 导出文本 | `textarea#export-svg` |
| SVG DOM 预览 | `#svg-export-host`（内含与文本框相同的 `<svg>`） |
| 误差自检 | `#svg-stats` |

快捷键：非输入框聚焦时 `Ctrl/⌘+Z` 撤销，`Ctrl+Shift+Z` 或 `Ctrl+Y` 重做。

## 导出 SVG 形态与误差判据

每个参数段是一个二点 `<polyline class="rks-segment">`，同时带齐三种端点读取方式：

```svg
<polyline class="rks-segment" data-index="0"
          data-u0="0" data-u1="0.25"
          points="1,0 0.931034483,0.379310345"
          x1="1" y1="0" x2="0.931034483" y2="0.379310345"
          data-x1="..." data-y1="..." data-x2="..." data-y2="..." .../>
```

- `data-u0/data-u1` 是十进制参数端点（域与 JSON 的 knots 相同，为 `[U0,U_last]`）；
- 坐标就是**样条坐标原值**，没有 fit 缩放、没有 y 翻转，`data-scale="1"`；
  外层 `viewBox` 仅用于预览取景，不影响任何属性数值；
- 同文件另有一条完整的 `#rks-full-polyline`（不带 `data-u0/u1`，避免被当成一个大段）；
- 检查方可对每个 `[data-u0][data-u1]`：
  `u=u0+t(u1-u0)`，期望点
  `=(1-t)P0+tP1`，与独立实现的原曲线 `C(u)` 比欧氏距离。
  导出端点做了 9 位十进制四舍五入（误差 `<1e-8`），参数 12 位；
- 细分策略：先在所有**不同节点值**处强制断段（尖角/重节点成为精确顶点），
  再按 32 点网格测得的弦误差递归二分（阈值 0.06、最深 24 层、每区间至少分一次），
  最后用 80 点网格审计并对漏网段继续劈开。独立 Python 以最多 240 点/段复查，
  样例/尖角/2–5 次随机/512 点曲线最大误差均 ≈0.06。

## 精确数学约定

- `Frac = bigint num / 正 bigint den`，构造即 `gcd` 约分；
  解析接受 `整数`、`a/b`、有限十进制串（也容忍数字类型与首尾空格）。
- Cox–de Boor 按题面：零分母项取 0；右侧端点取左极限。
  单侧值通过切换零次指示函数归属实现：
  右侧 `[U_i,U_{i+1})`，左侧 `(U_i,U_{i+1}]`，从而在重复节点处得到真正的左右极限。
- 齐次导数：
  `H'(u)=p Σ_{j=1}^{N-1} (P_j-P_{j-1})/(U_{j+p}-U_j)·N_{j,p-1}(u)`（零跨度项取 0），
  再用商法则得到投影坐标导数
  `x'=(X'W-XW')/W²`、`y'=(Y'W-YW')/W²`。
- 插入用标准 Boehm 公式，全部 `Frac`，因此 `H_before(u)===H_after(u)` 是 bigint 精确相等。
- 删除：删掉 `knots[r]` 得候选节点向量 → 用“逆 Boehm + 左右扫描”求唯一候选齐次点 →
  先查所有 `W_i>0` → 再把节点插回候选曲线，逐分量 `eq` 比较 `X,Y,W`。
  任一不过即拒绝。该判据不会有“误放行”：通过重插精确相等就数学上保证同一条齐次曲线。

## 测试

```bash
npm test                 # run-tests(275) + acceptance(31) + stress(1000)
node tests/run-tests.mjs
node tests/acceptance.mjs
node tests/stress.mjs
node tests/e2e.mjs           # 57 通过（使用全局 Playwright Chromium）
node tests/drag-check.mjs
npm run verify:py            # 导出 + 两个独立 Python 检查器
```

黄金值（样例二次有理 Bézier）：`C(1/2)=(5/7,5/7)`，
左右导数均为 `(-8/7, 8/7)`；端点 `C(0)=(1,0)`、`C(1)=(0,1)`，
`u=0` 只有右导数、`u=1` 只有左导数。
