# 深度区间合成台（Deep Interval Compositor）

把分通道交付的**烟雾（体积）**与**透明展板（表面）**深度样本，按物理透射模型合成为
逐像素线性预乘 RGBA 的离线网页工具。纯静态、零第三方依赖、离线可用。

## 为什么不能“按每条记录的起点排序”

一条视线往往同时穿过多条**互相交叠**的体积（不同渲染通道各自给出一段 `[z0, z1)`）。
若把每条体积当成一个整体、只按 `z0` 排序后顺序叠加，会犯两个错：

1. **交叠区的消光被整体化。** 两条烟雾在 `[2, 4)` 同时活跃时，该区间的总消光应是
   `σ = σ₁ + σ₂`、源颜色按各自消光加权 `C = (σ₁rgb₁ + σ₂rgb₂) / σ`；
   整条排序叠加无法表示“区间内活跃集合变化”，交叠段颜色与透射率都会算错。
2. **同深度事件有强制次序。** 一个体积在 `z=4` 结束、另一个在 `z=4` 开始、同一深度还有
   表面和遮挡样本时，处理顺序直接改变结果。规范要求：
   **先结束体积 → 再处理遮挡样本（holdout）→ 再按编号处理表面 → 最后开始新体积。**

本工具因此不做“记录排序叠加”，而是把每条记录拆成**深度事件**，对单条视线做一次
事件扫描，在相邻事件深度之间对“当前活跃体积集合”做解析积分。

## 物理模型

视线沿 `+z` 由近及远。对一个活跃集合恒定的积分段 `[z0, z1)`，段长 `dt = z1 − z0`：

- 总消光 `σ = Σ σᵢ`
- 段源颜色（消光加权）`C = Σ σᵢ·rgbᵢ / σ`
- 段透射率 `T_out = T_in · exp(−σ·dt)`
- 体积吸收份额 `= T_in · (1 − exp(−σ·dt))`
- 体积预乘颜色贡献 `= 吸收份额 · C`

表面（不透明度量 `a`、线性直色 `rgb`）：

- 吸收份额 `= T_in · a`，预乘贡献 `= T_in · a · rgb`
- 透射率更新 `T ← T · (1 − a)`

遮挡样本（holdout）：

- 直接把透射率切断为 `T = 0`，**自身不进入 A，也不产生 RGB**；其后一切记录不可见。

像素的 `A` 是所有**可见吸收份额之和**（体积段与表面计入，holdout 不计），
导出为浮点**线性预乘** RGBA，空像素全零。全部运算使用 Float64。

## 目录结构

```
web/
  index.template.html   页面模板（引擎占位符）
  index.html            由 build-page.sh 生成，引擎源码内联（file:// 可直接打开）
  engine.js             核心引擎：校验/定长打包/事件扫描/像素检查（Node 与浏览器同源）
  app.js                主线程：Blob 内联 Worker、错误保帧、取消、预览、检查、导出
  sample-data.js        内置样例
src/server.py           纯标准库静态服务器
tools/reference.py      Python 参考实现（独立编写，用于与 JS 交叉核对）
tests/
  node_check.mjs        手工真值 + 校验路径 + 40 组随机 fuzz 的 JS/Python 逐值比对
  fixtures.mjs          E2E 夹具（含 100 万层交错样本生成器）
  e2e.mjs               Playwright 端到端（file:// 与 http:// 双入口）
scripts/
  build-page.sh         把 engine.js 注入模板生成 index.html
  start.sh              启动本地服务
  selfcheck.sh          不依赖浏览器的一键自检
samples/deep-intervals.json
```

## 使用

直接双击 `web/index.html` 即可（`file://` 下 Worker 经 Blob 内联运行，无需服务）；
或：

```bash
./scripts/start.sh          # http://127.0.0.1:8000/
```

- **导入 JSON**：按钮选择或把文件拖入窗口；也可载入内置样例。
- **点击像素**：右侧列出每个体积积分段的活跃介质 id、σ、入射/出射透射率、
  吸收份额与预乘 RGB 贡献，以及同深度事件次序明细。
- **导出**：
  - RGBA64 二进制：头 `DIC1`(4B) + width(u32LE) + height(u32LE) +
    行主序 Float64 小端 RGBA；
  - JSON：`linear-premultiplied-rgba-float64`，仅列非空像素，空像素声明为全零。
- **取消 / 失败保帧**：导入中可取消；任何解析或校验失败都保留上一份可检查、可导出的
  结果，错误信息标明记录位置（JSONPath 风格，语法错误给行列号）。

## 精度与性能

- JS 引擎与 Python 参考实现独立编写，40 组随机场景逐像素逐分量交叉核对，
  最大偏差约 `1e-16`（远严于 `1e-6` 要求）；E2E 另对 100 万层夹具抽样 200 像素交叉核对。
- 512×512、约 **102 万条交错层记录**（116 MB JSON）从导入到出现可点画面约
  **1.2–1.9 秒**（无头 Chromium，普通笔记本量级），低于 10 秒预算。
  解析与合成在 Worker 线程，主线程不卡顿；结果缓冲以 transfer 零拷贝回传。

## 测试

```bash
./scripts/selfcheck.sh                          # 构建 + Node 单测 + Python 校验
node tests/e2e.mjs                              # 浏览器 E2E（自动起静态服务）
python3 -I tools/reference.py render <场景.json> -o out.json   # 参考实现单独出帧
python3 -I tools/reference.py inspect <场景.json> <x> <y>      # 参考实现分段检查
```

E2E 使用全局 Playwright（非本地依赖）。所有临时夹具写在 `os.tmpdir()`，不污染仓库。
