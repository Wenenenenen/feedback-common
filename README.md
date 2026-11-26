# Anchored Partial Synth · 锚相分音谐波合成台

纯原生 HTML/CSS/JavaScript 静态网页，无运行时依赖。按 `samples/anchored-partials.json` 的约定导入独立分音轨，在浏览器中自行求解整圈相位、计算 Hermite 相位曲线、合成并导出 48 kHz / 双声道 / PCM16 WAV。

## 运行

```bash
npm start
# 或 ./scripts/start.sh 8000
# 打开 http://127.0.0.1:8000
```

也可以直接打开 `index.html`：页面内置了样例副本，因此 `file://` 下不能 fetch 本地 JSON 时仍会载入同一份样例；也可用“选择 JSON…”导入。

## 自检

```bash
npm test          # 求解、精确平局、取整、WAV、切片一致性
npm run test:perf # 128 轨 / 60000 锚点 / 1440000 帧性能用例
npm run check     # 语法检查 + 核心测试
```

可选浏览器冒烟（需要 Playwright）：

```bash
QA_PLAYWRIGHT=/path/to/playwright npm run test:browser
```

## 实现要点

### 数据上限

- 最多 128 轨；
- 全工程最多 60,000 个锚点；
- 输出时长为最大末锚帧号，最多 1,440,000 帧（30 秒）；
- 每点为 `[x, p, fMilliHz, ampL, ampR]`：
  - `x`：工程帧号；
  - `p`：0..65535 相位余数；
  - `fMilliHz`：整数毫赫兹；
  - `ampL/ampR`：0..32767 的左右声道幅度。

### 整圈数与频率约束

段长 `h=x1-x0`，右端相位为 `p1/65536+k`。相位是三次 Hermite 曲线，端点导数为：

\[
m_0 = h f_0 / 48000,\qquad m_1 = h f_1 / 48000
\]

频率多项式乘以 `32h` 后全部是整数系数。`synth-core.js` 用 `BigInt` 检查二次多项式端点/顶点，不依赖 epsilon 放行数学边界。可行 `k` 集合是连续整数区间；目标值为：

\[
k_{\text{ideal}}=
\frac{h(f_0+f_1)}{96\,000\,000}
-\frac{p_1-p_0}{65536}
\]

代码用公共分母上的 `BigInt` 距离比较，因此像 `h=625、f0=143092 mHz、f1=87308 mHz` 这种数学上精确的 `k=1.5` 不会被浮点误差推成 `1.5000000000000002`；平局严格取较小 `k`。

若端点频率或段内顶点使瞬时频率超出 `20..20000 Hz`，该候选圈数无效。没有可行整数时，错误对象和页面横幅给出：

- 轨道 id；
- 从零开始的段 `#index`；
- 从一开始的“第 N 段”；
- 帧区间。

### 合成与量化

每轨身份独立，分音频率交叉时不合并、不重编号。左右幅度分别线性插值。所有可听轨道先累加到两个 `Float64Array`，全轨叠加完成后才：

1. 最近整数舍入；
2. 半值取偶；
3. 削顶到 `-32768..32767`；
4. 写成 interleaved little-endian PCM16 WAV。

`Math.sin(2π/12)` 在常见引擎中会低一个 ULP，可能把数学上精确的奇数幅度半值（如 `1003*0.5=501.5`）推到平局线以下。核心会把 `1/12、5/12、7/12、11/12` 圈等基数角度吸附到精确的 `±0.5`，保证这种数学正中情形按偶数舍入。

### 上一版保留

编辑或导入会先做结构校验和所有段的整圈求解。任一段无可用圈数时：

- 显示轨与段；
- 检查器跳到该段并显示“无可用圈数”；
- 不覆盖 `state.good.pcm/WAV`；
- 试听、选区导出和整轨导出继续使用上一版成功结果。

### 选区一致性

选区输入为工程帧号，左闭右开 `[start,end)`。选区 WAV 直接从整轨 `Int16Array` 取 interleaved subarray 并编码，因此样本码与整轨对应区间构造上逐码一致；核心测试也会独立再渲染一次区间并比较。

独听单轨时仍分配/输出全工程时长（最大末锚帧号），段外为静音。

## 文件

- `index.html` / `styles.css` / `app.js`：页面、状态、Canvas 波形、交互和播放；
- `synth-core.js`：校验、BigInt 圈数求解、频率极值、Float64 合成、半偶舍入、WAV 编解码；UMD，可在浏览器或 Node `require`；
- `synth-core.mjs`：同一核心的 ESM 命名导出包装；
- `sample-data.js`：样例 JSON 的内置副本，支持 `file://`；
- `tests/synth.test.cjs`：核心回归；
- `tests/perf.test.cjs`：满额性能；
- `tools/browser-smoke.cjs`：可选 Playwright 冒烟。
