# 齐次光栅化校验台

自研的三角形齐次裁剪与软件光栅化校验网页。全部核心计算（裁剪、三角化、覆盖、
透视插值、深度测试）均为手写，不依赖任何图形 API 或现成软件光栅器；PNG 分块、
CRC32、Adler32、zlib stored block 也全部手写，无第三方运行时依赖。

## 目录

- `index.html` — 页面外壳与样式（深色工程工作台，浅色/深色自适应）。
- `src/engine.js` — 核心管线：六平面 Sutherland–Hodgman 裁剪、扇形三角化、
  像素中心边函数覆盖（top-left 规则）、透视正确颜色、z/w 深度、严格深度测试。
- `src/inspector.js` — 逐像素检视：对获胜面重新求值，给出原始面、裁剪顶点、
  子三角形、重心权重、λ/w、z/w 与全部插值中间量。
- `src/exporters.js` — 手写 PNG 编码器与逐像素 JSON 导出、线性→sRGB 编码。
- `src/app.js` — UI 控制器：四视图、网格叠加、点击检视、取消、导出。
- `src/samples/*.json` — 内置样例（含 5000 面压力用例）。
- `tools/` — 独立参考实现与验证脚本（不参与页面运行）。

## 算法约定（与 `samples/.../格式说明.md` 一致）

- 六裁面：`-w≤x≤w`、`-w≤y≤w`、`0≤z≤w`；裁剪插入点的位置 `x` 与颜色 `rgb`
  按同一边参数 `t = dp/(dp-dc)` 线性插值；最终 `w ≤ 1e-12` 的退化部分不栅格化。
- 视口：`x=(x/w+1)*width/2`，`y=(1-y/w)*height/2`，采样点为像素中心。
- 覆盖：屏幕三角形整理成有向面积为正；边函数 `cross(b-a,p-a)` 非负，等于零时
  仅 `dy<0` 或 `dy==0 且 dx>0` 的边纳入（top-left），无背面剔除。
- 颜色：`Σ(λ·rgb/w) / Σ(λ/w)`；深度：`Σ(λ·z/w)`。
- 深度：清屏为无穷，**严格小于**才写入；等深度保留先提交的面。
- 边函数在每个采样点**直接求值**（不做增量累加），避免浮点累加漂移在精确零边处
  翻转填充规则，保证与参考实现逐位一致的零值/符号判定。
- 输出 JSON：行优先 `pixels`，每项 `{face, depth, rgb}`，未覆盖为
  `-1 / null / [0,0,0]`，可选 `coverage`。PNG 为线性颜色钳位后标准分段 sRGB。

## 页面能力

- 四视图：颜色 / 深度 / 面编号 / 覆盖（覆盖视图高亮多重覆盖像素）。
- 网格叠加：裁剪前（蓝）/ 裁剪后（黄），可关。
- 点击任意像素：原始面齐次顶点、裁剪后顶点、命中子三角形、重心 λ、λ/w、z/w、
  Σ(λ/w)、插值深度与线性 RGB，并标注命中的零值边。
- 统计：总面数、有效/裁剪/退化/非法面、子三角形数、覆盖像素、深度否决、多重覆盖。
- 参数或场景变更后重新计算；长任务按面分片让出事件循环，可随时取消。
- 导出 PNG（sRGB）与含逐像素深度、面编号、线性 RGB（及可选 coverage）的 JSON。

## 本地运行

```bash
python3 -I -m http.server 8901   # 任意静态服务器均可
# 浏览器打开 http://localhost:8901/index.html
```

## 验证

引擎由两条独立实现交叉校验，全部用例逐像素一致：

1. `tools/raster_ref.py` — 独立 Python 参考实现，直接对照包内 `reference.json`
   （shared-edge 覆盖数、perspective(0,0) 的 rgb/depth、equal-depth 获胜面、
   degenerate 忽略数）。
2. `tools/verify_independent.py` — 用 NDC 空间点在凸多边形内判定独立核对覆盖
   完整性，用独立行列式重心坐标重算颜色与深度。
3. `tools/node_verify.mjs` — JS 引擎与 Python 参考逐像素比对（含 5000 面
   stress 的全部 65536 像素：face/coverage 完全一致，rgb/depth 误差 ≤ ~1e-13）。
4. `tools/test_inspector.mjs` — 检视器重算值与帧缓冲逐像素一致。
5. `tools/test_exporters.mjs` + Python `zlib` — PNG 分块/CRC/zlib 与 sRGB 字节。
6. `tools/ui_smoke.mjs` — Playwright 无头端到端：四视图、网格、检视、各样例、
   取消、导出。

运行（在仓库根目录）：

```bash
for c in shared-edge perspective equal-depth degenerate behind-eye near-cross invalid-index; do
  python3 -I tools/raster_ref.py samples/extracted/$c.json --check samples/extracted/reference.json
  python3 -I tools/verify_independent.py samples/extracted/$c.json
  node tools/node_verify.mjs samples/extracted/$c.json /tmp/ref_export/$c.json
done
node tools/test_inspector.mjs samples/extracted/stress.json
```

## 限制

- 输出最大 256×256、最多 5000 面（与任务约束一致；导入时校验）。
- stress 全量在浏览器约数秒内完成，按面分片可取消；无 Web Worker，分片粒度为面。
