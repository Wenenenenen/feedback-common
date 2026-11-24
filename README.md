# 剪辑点波形核对台

一个纯前端、零依赖的网页：导入最多 8 份 48kHz/双声道/16-bit PCM WAV（每份 ≤10 分钟），
把它们作为源轨拼成一条可反复编辑的时间线，并在缩到整段时仍能看出每个尖峰来自哪条轨。

## 能力对照

| 需求 | 实现 |
|---|---|
| 最多 8 份 48kHz 双声道 16-bit PCM WAV，每份 ≤10 分钟 | `js/wav.js` 严格解析 RIFF/WAVE，逐项校验并拒绝不符格式 |
| 拼接轨 ≤2 万段、总长 ≤2³¹−1 帧 | `js/timeline.js` 容量校验 |
| 段引用源轨半开区间，可拆分/移动/倒序/静音 | `Timeline`；拆分逐帧不变，倒序镜像切分且不交换声道，静音按零样本统计 |
| 每列双声道 min/max/count/精确平方和 | `js/pyramid.js` 分层金字塔；L1 用 Float64（块内 <2⁵³ 精确），上层 BigInt64 任意长度精确 |
| 静音计入零样本 | `zeroStat`：min=max=0、count 照计、sumSq=0 |
| 平方和十进制字符串导出 | BigInt `toString()`，JSON/CSV 均为字符串 |
| 所选 n 帧分 B 列，第 j 边界 floor(jn/B)，B=1..2048 | `Timeline.columnStats`；空列 min/max 为 null、count=0、sumSq="0" |
| 点单帧查源位置和值 | `Timeline.inspectFrame` + 画布点击 |
| 导出当前区间和列统计 | `js/exporter.js`，JSON（含段清单/区间聚合）与 CSV |
| 撤销后再编辑清掉旧重做，撤销/重做后波形/定位/导出一致 | `js/history.js` 快照栈，push 即截断 redo |
| 2 万段编辑后刷新 1024 列 ≤2s（四核 8GB） | 实测满规模约 116ms（见下） |

## 目录

```
index.html          页面（明暗双主题、响应式）
js/wav.js           WAV 严格解析
js/pyramid.js       源轨统计金字塔（区间精确聚合）
js/timeline.js      拼接轨：段、拆分/移动/倒序/静音、列统计、逐帧定位
js/history.js       撤销/重做
js/exporter.js      JSON/CSV 导出
js/render.js        画布渲染（分段身份条 + 双声道列波形）
js/colors.js        8 轨固定身份色（已过 CVD/对比度校验）
js/app.js           UI 状态与交互
tests/              Node 单测、性能、Playwright 端到端与交叉核对
samples/            样例 WAV
```

## 运行

任意静态服务器即可（ES module 不能用 `file://`）：

```bash
python3 -m http.server 8747
# 浏览器打开 http://localhost:8747/index.html
```

页面会自动尝试载入 `samples/wave-edit-source.wav` 并预置“正向 / 倒序 / 静音”三段作为可操作初始状态；
也可用“导入 WAV”选择本地文件。

## 测试

```bash
node tests/pyramid.test.js     # 金字塔区间统计 vs 暴力逐样本（1 万+ 断言）
node tests/timeline.test.js    # 拼接/拆分/倒序/静音/列/定位/撤销
node tests/wav.test.js         # WAV 解析与格式拒绝
node tests/perf.test.js        # 性能冒烟；--full 跑满 8×10 分钟
node tests/e2e.mjs             # Playwright 端到端（需先起静态服务器）
node tests/crosscheck.mjs      # 浏览器导出 vs Node 参照逐值核对
```

## 性能（本机 Node 22，满规模 8 轨 × 28,800,000 帧）

- 8 条源轨金字塔总构建：约 6.2s（一次性，源轨读入时）
- 2 万段、刷新 1024 列统计：**约 116ms**（指标 ≤2000ms）
- 单帧定位 10 万次：约 10ms（二分 O(log 段数)）

## 精确性说明

16-bit 样本平方 ≤ 32768² = 2³⁰。叶子块 256 帧的平方和 < 2³⁸，远小于 2⁵³，
故 L1 用 Float64 逐样本累加仍精确；自 L2 起全部转 BigInt64 保存与合并，
因此任意 ≤2³¹−1 帧的平方和都精确，最终以十进制字符串导出，无浮点舍入。
