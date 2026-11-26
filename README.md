# 多底图直通 Alpha 反推工作台

从 2–8 张已知底图上的合成观测，按包内整数公式反推样片的直通（straight, non-premultiplied）RGBA。
纯前端单文件应用，不调用任何现成抠像接口；求解在 Web Worker 内完成。

## 反推原理

包内合成约定（全部在整数码值域，无颜色空间转换）：

```
O = floor((A·F + (255−A)·B + 127) / 255)
```

对每个像素、每个候选 `A ∈ 0..255`，由容差 `t` 把每个**未排除观测的每个通道**
单独夹成可行 `F` 区间：

```
O−t ≤ floor((A·F + (255−A)·B + 127)/255) ≤ O+t   （码值夹到 0..255）
```

区间用整数上下取整直接算出（见 `tools/src/solver.js` 的 `channelInterval`），
再对同一通道跨全部参与组取交集。三个通道交集都非空，该 `A` 才可行。

- **交片解**：可行 `A` 中取最小 `A`；该 `A` 下 `R、G、B` 各自取区间下界
  （即按 R、G、B 依次最小）。
- **未测**：像素在所有组都被掩膜排除（或组被关闭）。
- **无解**：容差内没有任何 `A` 能同时满足全部未排除观测通道。
- 未测与无解在 RGBA 交片中一律写透明黑 `(0,0,0,0)`，并在状态 PNG 中分别用
  灰度码 `0`（未测）、`2`（无解）、`1`（可行）标出。
- 误差一律按 **预测 − 观测** 记录。

## 目录结构

```
tools/src/        与网页内联的同一套已测 ESM 模块
  pnm.js          P5/P6（8 位, maxval=255）解析，含完整输入校验
  solver.js       整数区间求解、全图求解、像素检查器
  png.js          零依赖 PNG 编码（RGBA / 灰度；含存储型 deflate 后备）
  recomposite.js  用同一整数公式重合成到底图或自选纯色
web/
  app.template.html  页面骨架与样式
  main.js            应用状态机、渲染、导出、同一次求解的版本控制
  worker.js          Web Worker（求解 / 检查 / 编码 / 重合成）
  sample-data.js     由真实样片字节生成的内置演示数据（构建产物）
  app.html           构建产物：单文件应用
tools/test/
  node-smoke.mjs        Node 数值冒烟测试（含 Python 参考实现逐像素比对）
  built-page-test.mjs   验证构建产物内联代码与模块一致
  e2e.mjs               Playwright 端到端测试（真实 Chromium）
tools/reference_solve.py  Python 参考实现（暴力枚举交叉验证用）
tools/reference_dump.py   导出逐像素参考解
tools/make_synth.py       生成带掩膜/坏点的合成压力数据集
```

## 构建与测试

```bash
node tools/build.mjs          # 生成 web/app.html（单文件，可直接双击打开）
bash tools/run_tests.sh       # 数值测试 + Python 逐像素一致性 + 解析器拒绝用例
node tools/test/built-page-test.mjs
node tools/test/e2e.mjs       # 需要 Playwright Chromium
```

## 网页使用

1. 拖入数据集文件夹、多选文件，或点“载入内置样片”。识别 `groups.json`，
   或按 `bg{i}.ppm / obs{i}.ppm / valid{i}.pgm` 命名自动配对。
2. 容差 0–8 可调；改动后全图重新求解，检查器、预览、导出始终来自同一次求解
   （求解带版本号，过期面板会整体刷新，不混用旧结果）。
3. 预览可切换直通 RGBA / 状态图 / 重合成；重合成可选任一输入底图或自选纯色。
4. 点像素在检查器查看全部可行 `A`、每个 `A` 的逐通道 `F` 区间，以及逐组
   底图、观测、预测与 `预测−观测` 误差。
5. 导出：直通 RGBA PNG（导出前做 PNG 字节级自检，确保保留所选直通字节）、
   状态 PNG（灰度 0/1/2）、当前重合成 PNG。

## 已验证的边界

- 区间法与 256 档 `F` 暴力枚举在小样全部 `(A, 组, 通道)` 组合上一致。
- JS 求解与 Python 参考实现逐像素状态、交片解、可行 `A` 计数完全一致。
- 上限规模 384×384 × 8 组在 Worker 内约 6 秒内完成，UI 不阻塞。
- 掩膜缺省视为全有效；所有组关闭/掩膜全关判为未测；损坏观测判为无解。
- 截断、错误 magic、超 384、非 8 位 maxval 的输入都会被显式拒绝。
