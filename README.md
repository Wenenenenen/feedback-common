# 循环环境音 · 周期上限限幅台（cyclic-ceiling-limiter）

把首尾相接的循环环境音导入后，按包内 `约定.txt` 做**周期四点插值 4 倍上采样**，
在 192 kHz 的每一帧上求一个**两声道共用的整数增益**，使舍入后的 PCM16 码值
绝不越过填写的绝对码值上限 `ceiling`，同时满足分开设置的逐帧最大升幅 `up` / 降幅 `down`
（末帧→首帧同规则），并支持锁定指定帧增益。求解目标是**环上逐点都最大的可行增益曲线**。

纯静态、零运行时依赖、全部运算在浏览器本地完成。

---

## 打开方式

直接双击 `index.html` 即可（内置了一份 `loop.wav` 的 base64，`file://` 下也能一键载入）。
也可以起任意静态服务：

```bash
npm start
# 或 python3 -m http.server 8080
# 打开 http://localhost:4173/（python 方式为 http://localhost:8080/）
```

右上角 **导入 WAV / cyclic-ceiling-cases.zip** 可直接选择
`samples/cyclic-ceiling-cases.zip`（自动读取其中全部 WAV 与 `settings.json`），
也支持多选 `.wav`。输入要求：

- WAV / PCM16 / **双声道 / 48 kHz**
- 时长 **≤ 60 s**（最多 2,880,000 个基率帧 → 11,520,000 个 192k 帧）

---

## 功能

- **限幅前/后波形**：周期四点插值 192k 波形与原始 48k 波形可切换；双声道蓝/橙叠加。
- **左右峰值**：原始码峰值、插值峰值（三次插值会过冲，可能大于原始峰值）、限幅后峰值，均分别给出 L/R 与 dB 参考所需的原始整数。
- **增益曲线**：逐点最大可行增益（青）、ceiling 传播得到的逐帧上限帽 cap（灰）、锁标记（黄/红）。
- **锁定**：
  - 左侧表单按“192k 帧号 + 整数增益”精确加锁；
  - 增益图上**单击**锁定最近帧（取该帧当前可行增益），**右键**删除附近锁；
  - 每帧至多一个锁，重复添加覆盖；可在行内改值或删除。
- **锁冲突处理**：把锁也作为上限并入传播，传播后曲线低于目标值的锁会列入
  “达不到的锁”，同时列出目标值与传播可达值；此时**保留上一次可行曲线**不被覆盖。
  另在折叠区给出按约定原文“仅把锁当上限（不含 ceiling 帽）”的纯锁间冲突口径。
- **循环试听**：WebAudio 192k 缓冲、`loop=true` 整圈无缝循环；可切换
  限幅后 / 插值未限幅 / 原始 48k，可勾选“只循环选区”。播放中提交新的可行
  限幅曲线会热替换正在播放的缓冲并尽量保持相位；锁冲突时不替换，继续听到
  上一次可行结果。`window.__ccl.playbackLevel()` 可读取分析节点的实时峰值/RMS。
- **选区导出**：三张图上均可拖动框选，也可精确填写左闭右开帧区间 `[start,end)`；
  导出 **192 kHz / 双声道 / PCM16 WAV**。导出码值与页面求解结果逐码相同，
  `[0,4N)` 整圈导出即完整一圈切片，可直接与参考实现逐码比对。
- **性能**：60 s 满长素材在本机 Node 全链（帽+求解+逐码）约 **1.4 s**，
  Chromium 中改一次设定到曲线可查约 **1.6 s**（含绘图约 1.6–4 s，视缓存），
  远低于 12 s 要求。

---

## 精确数学口径（与 `约定.txt` 逐条对应）

一圈 N 个 48k 基率帧，四倍插值后 `n = 4N` 个 192k 帧，编号 `0..4N-1`。

对基率帧 `i` 与下一帧之间相位 `s = j/4`（`j=0,1,2,3`），取**循环**索引
`i-1, i, i+1, i+2` 上的码值 `a,b,c,d`：

```
I(s) = (2b + (-a+c)s + (2a-5b+4c-d)s² + (-a+3b-3c+d)s³) / 2
```

令 `B=-a+c, C=2a-5b+4c-d, D=-a+3b-3c+d`，可化为精确整数分数 `I = K/128`：

```
K = 128b + 16Bj + 4Cj² + Dj³
```

每帧增益 `g ∈ [0,65536]` 为整数，两声道共用。输出码：

```
y = round_half_to_even(K·g / (128·65536))
  = rhe(K·g / 2²³)
```

全部用整数余数判定实现“四舍六入五成双”（含负数中点），无浮点边界误差。
**先舍入，后检查** `|y| ≤ ceiling`，不另做削顶。

### 逐帧上限帽

令 `C0 = ceiling`、`A = |K|`、`T = (2C0+1)·2²²`。条件 `|rhe(Kg/2²³)| ≤ C0`
等价于 `Ag ≤ T`（`C0` 偶时中点 `Ag=T` 允许，奇时不允许），故单声道帽为：

```
cap_ch = C0 偶 ? floor(T/A) : floor((T-1)/A)
cap[k] = min(65536, cap_L, cap_R)
```

### 环上逐点最大传播

相邻帧 `k→k+1`（模 n）：

```
g[k+1] ≤ g[k] + up      （升幅）
g[k]   ≤ g[k+1] + down  （降幅）
```

给定上界数组 `hi`（ceiling 帽，冲突检查时再把锁目标 `g[f]≤target` 并入），
最大不动点为：

```
g*[k] = min_j min( hi[j] + up·((k-j) mod n),
                   hi[j] + down·((j-k) mod n) )
```

用长度 `2n` 的复制数组各做一次前向/后向 min-plus 扫描，**O(n)**、`Int32Array`。
该解已用 O(n²) 显式公式、小系统全增益组合穷举、数十万随机用例验证。

### 锁冲突

把锁仅作为上界并入 `hi` 后求 `g*`；若某锁 `f` 上 `g*[f] < target_f`，
该锁无法被精确满足，列为冲突。无冲突时 `g*[f] = target_f` 对所有锁成立，
`g*` 即逐点最大且锁全部命中的可行曲线。冲突时 UI 保留 `state.good`
（上一版可行结果），只更新候选与冲突列表。

---

## 目录结构

```
index.html            单页界面
css/style.css         深色工作台主题（声道配色通过 CVD 校验）
js/ccl-core.js        精确数学：K、rhe、cap、传播、锁、整链 processCycle（UMD）
js/wav-codec.js       PCM16 WAV 解码 / 左闭右开区间编码
js/zip-read.js        最小 ZIP 读取（stored / deflate-raw）
js/sample-data.js     内置 loop 案例（base64，自动生成）
js/app.js             状态、Canvas 波形/增益、框选/锁定、WebAudio、下载、测试句柄
samples/              原始 zip + 解出的 loop.wav / settings.json
tests/run-tests.js    Node 无依赖测试台（53 项）
tests/browser-verify.js Playwright 端到端（34 项，含播放热替换、导入停旧声、新素材冲突统计重置、60s 性能与下载逐码）
tools/py_oracle.py    独立 Python oracle，与 JS 逐码交叉验证
tools/dump_for_oracle.js 生成 Python oracle 所需 JSON/WAV
tools/serve.js        零依赖本地静态服务器（npm start）
```

## 测试

```bash
# 核心算法 / 精确性 / WAV / ZIP / 60s 性能
npm test

# 浏览器端到端（使用全局 playwright 时）
NODE_PATH=$(npm root -g) npm run test:browser

# HTTP 导入冒烟
NODE_PATH=$(npm root -g) npm run test:http

# Python 独立 oracle 交叉核对
node tools/dump_for_oracle.js
python3 -I tools/py_oracle.py "$PWD"
```

页面还暴露了自动化句柄：

- `window.CCL`：全部纯函数与 `lastResult`（含 `gains/caps/outL/outR` 类型化数组）。
- `window.__ccl` / `window.CCL.app`：
  `snapshot()`、`applySettings({ceiling,up,down,locks})`、
  `gainAt/outAt/capAt(i)`、`encodeSlice(start,end)`、`loadArrayBuffer(buf)`。
- `<html data-curve-ready data-rev data-conflict>` 与 `#solve-time[data-ms]`
  可用于等待/计量“提交 → 曲线可查”。
- 主要控件均有稳定 `id` 与 `data-testid`（`file-input`、`ceiling-input`、
  `up-input`、`down-input`、`apply-button`、`conflict-list`、
  `selection-start/end`、`download-selection-button` 等）。
