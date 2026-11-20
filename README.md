# 平行束 Ram-Lak 滤波反投影重建台

纯前端网页，按测试台 README 的坐标、角权与离散滤波约定自行实现平行束
Ram-Lak 滤波反投影（FBP），并提供未滤波反投影对照。**不调用任何断层重建
库/接口**：滤波核、卷积、角权、插值与反投影全部在 `web/fbp-core.js` 中显式
实现，仅使用 TypedArray 数值运算；ZIP 解压使用浏览器原生
`DecompressionStream('deflate-raw')`，无第三方依赖。

## 目录

```
web/
  index.html      界面
  fbp-core.js     数值引擎（UMD，可在 Node 中直接 require 测试）
  unzip.js        最小 ZIP 读取（中央目录解析 + 原生 DEFLATE + CRC32）
  app.js          文件处理、渲染与交互
  test-core.js    Node 单元/一致性测试（node web/test-core.js）
tools/
  reference_fbp.py  纯标准库 Python 参考实现（python3 -I 运行）
  e2e-smoke.js      Playwright 端到端测试
  screenshot.js     视觉检查截图脚本
samples/            测试台导出的样例包（不入库解压副本）
```

## 数值约定（与样例 README 完全一致）

- 输入：小端 float32 正弦图，角度行 × 探测器列；角度弧度、范围 `[0, π)`，
  允许乱序，**重复角度拒绝**；排序时数据行与逐行 `offset` 一起重排。
- 探测器物理位置 `s = (k − (D−1)/2 − offset[row]) · ds`。
- 像素中心 `x = (col − (W−1)/2) · pixel_size`，
  `y = ((H−1)/2 − row) · pixel_size`。
- 角权：周期 π 上的圆形 Voronoi 权，相邻前后角间隔之和的一半；单角权重 π。
- Ram-Lak 离散核：`h[0] = 1/(4 ds²)`，非零偶数项为 0，
  奇数项 `h[n] = −1/(π² n² ds²)`；`q[k] = ds · Σ_j h[k−j] p[j]` 为完整
  线性卷积（核对称 `h[−n]=h[n]`），不做循环回绕。
- 反投影 `f(x,y) = Σ_θ w_θ · q((x cosθ + y sinθ)/ds + (D−1)/2 + offset)`，
  q 相邻探测器线性插值，索引范围外取 0。
- 未滤波对照直接令 `q = p`。
- 重建值保持 float64 内部精度、原始尺度与符号，**不为显示做缩放或截断负值**；
  色窗只作用于画布渲染。
- PFM 导出：`Pf`、负尺度 `-1.0`、小端 float32、底行优先。

## 验证

```bash
# 1) Python 参考实现：脉冲样例精确匹配 + 重复角度拒绝
python3 -I tools/reference_fbp.py _case_data /tmp/fbp_ref_out

# 2) JS 引擎与 Python 双精度参考逐值比对（17+ 项）
node web/test-core.js

# 3) 浏览器端到端（导入 ZIP、点选联动、PFM、参数重载、重复角度拒绝）
NODE_PATH=<global-node-modules> node tools/e2e-smoke.js
```

关键结果：

- `impulse.raw` 重建与 `impulse-expected.json` 在 1e-15 容差内逐值相等
  （`[0, −1/π, π/4, −1/π, 0]`）。
- phantom 的 JS 重建与 Python 参考在 float64 下最差偏差 ≤ 2e-13；
  对随附 `truth.raw` 的 RMSE ≈ 0.057，0.5/1.0 区域重建均值 0.47/0.98。
- 乱序输入重排后重建逐位相同；角权之和恒为 π。

## 使用

浏览器直接打开 `web/index.html`（或用任意静态服务器托管 `web/`）。
导入测试台 ZIP，或同时选择 `.json` + `.raw`；可调输出尺寸（≤256×256）、
像素间距与统一附加中心偏移，切换 Ram-Lak / 未滤波，点选重建像素查看其在
各角度命中的探测器位置，并导出 PFM 与可重载的参数 JSON。
