# 磁带导频校速台 · Pilot Cycle Restorer

纯原生 HTML/CSS/JavaScript 静态网页，无运行时依赖。导入 `samples/pilot-cycle-cases.zip`
（48 kHz 双声道 PCM16 WAV + `project.json` 导频读数），按包内整数代价求全段最小折变的
整圈相位展开，支持手工锚点、无解定位、同源重采样、A/B 对照试听与逐码一致的选区导出。

## 运行

```bash
./scripts/start.sh 8000
# 打开 http://127.0.0.1:8000
```

也可 `npm start -- 8000`，或直接用浏览器打开 `index.html`（`file://` 下不会自动 fetch
样例，用右上角按钮选择 ZIP 即可；也可多选 `project.json` 与 `tape.wav`）。

## 自检

```bash
./scripts/selfcheck.sh
# 或 npm test
```

Node 测试包含：

- 样例 ZIP 的最优路径/代价/输出帧数（与独立 Python `Fraction` 参考一致）；
- 400+ 组随机小规模用例与**穷举搜索**对照：全局最优代价 + 字典序最小 `z` 序列；
- 第一处无法延续读数与独立穷举前缀检查一致；
- 强制 BigInt 安全模式的溢出用例；
- 60 组随机曲线：增量渲染与逐帧 BigInt 直接有理参考**逐码一致**；
- 样例渲染 WAV 与 Python 黄金文件**整文件逐字节相同**；
- 选区 PCM 与整段 WAV 同区间逐码一致；
- 20000 读数 + 锚点重解 / 无解定位的 10 秒性能预算。

## 输入约定（与包内 `约定.txt` 一致）

`project.json`：

```json
{
  "wav": "tape.wav",
  "rate_min": [4, 1],
  "rate_max": [7, 1],
  "marks": [[x, p, k_lo, k_hi], ...],
  "anchors": {"0": 0, "3": 6400}
}
```

- 每行读数：源帧号 `x`（严格升序，首尾为 `0` 与总帧数 `N`）、相位余数 `p∈[0,255]`、
  整圈候选闭区间 `[k_lo,k_hi]`（候选 ≤ 16，`0≤k≤9999999`）。
- 展开相位 `z = 256k + p`。
- 锚点按读数编号绑定到某个展开相位 `z`，必须是该处候选之一；首尾锚点锁定。
- 相邻斜率闭区间：`rate_min = [a,b] ≤ dz/dx ≤ [c,d] = rate_max`，两端都是正 u32 分数。
  整数判定：`a·dx ≤ b·dz` 且 `d·dz ≤ c·dx`。

限制：录音 ≤ 90 s（48 kHz 下 `N ≤ 4,320,000`）、读数 ≤ 20000、每处候选 ≤ 16；
校正结果最多支持 180 s（`8,640,000` 输出帧）。

## 求解器（`solver.js`，UMD：浏览器 `window.PilotSolver` / Node `require('./solver.js')`）

折变代价：

\[
C(z)=\sum_{i=0}^{n-3}\left|dz_i\,dx_{i+1}-dz_{i+1}\,dx_i\right|,
\quad dx_i=x_{i+1}-x_i,\ dz_i=z_{i+1}-z_i .
\]

这是一个二阶链（代价依赖连续三个读数），用状态 `(z_{i-1}, z_i)` 的反向动态规划求全局最优。
每层最多 `16×16` 状态、每状态最多 16 个后继，并用 `Uint16Array` 位掩码保存速度可行邻接。

- **字典序平局**：反向 DP 在代价相同时只保留编号最小（即 `z` 最小）的后继；起点按
  `z` 升序只在严格更优时替换，重建即得到所有最优序列中整条 `z` 序列字典序最小者。
- **精确整数**：速度区间用 BigInt 求精确的 `dz` 整数闭区间；当可证明
  `Σ (max|dz_i|·dx_{i+1} + max|dz_{i+1}|·dx_i) ≤ 2^53−1` 时全程使用安全 Number
  （满额真实案例约百毫秒内），否则自动切换 BigInt 代价模式。
- **第一处无法延续**：只考虑相邻速度约束与锚点的前向候选可达性；第一个可达集合为空的
  读数即“第一处无法延续的读数”。可行性是一阶的，所以该判定与“能否走完全程（含未来锚点）”
  完全等价。

主要 API：

```js
const prep = PilotSolver.prepare(project);
const { anchorIdx, errors } = PilotSolver.resolveAnchors(prep, project.anchors);
const res = PilotSolver.solvePrepared(prep, anchorIdx);
// res.ok ? { z, zIndices, cost(Number|bigint), costText, numberSafe, elapsedMs }
//        : { ok:false, firstBad }
PilotSolver.firstBadReading(prep, anchorIdx);
PilotSolver.outputFrameCount(res.z);
```

## 重采样与导出（`audio.js`）

- 每个读数的校正时间 `y_i = 3(z_i−z_0)/16`（输出帧，可为分数）。
- 只渲染整数输出帧 `0 ≤ f < y_last`，帧数 `ceil(y_last)`。
- 段内线性反查源帧。令 `A=16f−3(z_i−z_0)`、`Q=3dz_i`，则
  `x_src = x_i + dx_i·A/Q`；用每段一次 BigInt 初始化 + 每帧整数增量
  （余数加 `16dx`）精确定位整数源帧与插值权重。
- 两声道共用同一源时钟做线性插值；右邻点越过末帧时沿用末帧。
- 插值结果按精确有理数量化到 PCM16，**正中取偶（ties-to-even）**。
- 整段渲染为一个交错 `Int16Array`；选区导出是同一缓冲的 `subarray` 拷贝后用同一
  `encodeWav16` 编码，因此选区 PCM 码与整段 WAV 对应区间逐码一致。

## 页面操作

- 顶部 **导入 cases ZIP**（`#fileInput`，另有 `#file-input` 兼容钩子）或 **载入内置样例**；
  支持拖放与多选 `project.json + tape.wav`。
- 左栏添加中间锚点：输入读数 `#` → 选择候选 `z` → 提交；也可在“读数明细”点候选 chip。
  `#0` 与最后一个读数为首尾锁定锚点，不可删改。
- 无解时顶部红色横幅给出 **第一处无法延续：#i** 与原因，可一键定位；黄色徽标提示当前
  试听/导出仍是**上一条可用结果**；“还原到上一条可用锚点”可恢复。
- 相位图（全部候选点 + 最优路径 + 锚点 + 无解标记）与速度图（允许区间带 + `dz/dx`）
  十字线联动和悬浮读数。
- 数据表包含全部读数行（任意 `tr[data-index="i"]` 都在 DOM 中），展示候选 `k` 范围、
  全部候选 `z`、最终选值、入段斜率与锚点/异常标记；支持编号跳转与只看锚点/异常。
- **对照试听**：同一 `<audio>` 在“听原带 / 听校速”间切换，并按曲线把当前声音位置
  在输出帧 ↔ 源帧之间映射。
- **导出整段 WAV**（`#exportBtn`）与按秒/帧选区间的 **导出选区 WAV**
  （`#exportSelectionBtn`）。

## 自动化钩子

页面暴露 `window.PilotApp`（别名 `window.__pilot` / `window.pilotRestorer`）：

```js
PilotApp.getState();
PilotApp.addAnchor(index, z);                 // z 必须是候选展开相位
PilotApp.addAnchor(index, ci, 'candidateIndex');
PilotApp.removeAnchor(index);
PilotApp.revertToLastGood();
PilotApp.exportWav(startFrame?, endFrame?);   // 返回 Uint8Array WAV
PilotApp.scrollToIndex(i);
PilotApp.outputFrameToSourceX(f);
PilotApp.sourceXToOutputFrame(x);
PilotApp.loadSyntheticForTest(project);        // 合成等长 PCM，供性能测试
window.solvePilotCase(project, anchors?);
```

关键 DOM：`#status-text`、`#fileInput` / `#file-input`、`#exportBtn`、
`#exportSelectionBtn`、`#anchorForm`、`#anchorIndex`、`#anchorValue`、
`#anchorList`、`#firstBadIndex`、`#errorBox`、`#lastGoodBadge`、
`#markTbody tr[data-index]`、`#phaseCanvas`、`#speedCanvas`。

## 文件

- `solver.js` — 校验 / 邻接 / 可达性诊断 / 最优 DP（UMD）
- `audio.js` — WAV 解析编码、精确重采样、量化（UMD）
- `zipio.js` — 零依赖 ZIP 读取与案例装配（UMD）
- `app.js` / `index.html` / `styles.css` — 界面
- `tests/` — Node 测试与黄金 WAV
- `scripts/start.sh`、`scripts/selfcheck.sh`
- `src/*.js` — 指向根模块的 CommonJS 兼容转发
