# 掩膜 RL 反卷积台（masked-rl-deconvolver）

已知模糊核的照片复原单页工具。按样例包 `约定.txt` 自实现带有效观测掩膜的
Richardson–Lucy 迭代，不使用任何现成反卷积接口；仅使用基础数组运算、浏览器
图像读写与自写 PNG 编解码。

## 打开方式

直接用浏览器打开 `app/index.html` 即可（单文件，除 Google 字体外无外部依赖，
字体加载失败也不影响功能）。需要本地服务时：

```bash
python3 -m http.server 8000
# 访问 http://127.0.0.1:8000/app/index.html
```

## 功能

- 导入单边 ≤ 512 的 8 位灰度 / RGB PNG（编码值 /255，不做 sRGB 解码，RGB 逐通道独立）。
- 导入 PSF JSON：`weights` 二维非负数组 + `anchor=[x,y]`，支持最大 15×15；核按总和归一化为 1。
- 可选同尺寸二值有效观测掩膜 PNG（非 0/255 时按 >127 二值化并给出提示）。
- 1–100 次 RL 迭代，后台分片执行，可随时取消；取消只保留已完成迭代。
- 检视任意迭代的复原图、重模糊图、有效区残差（有符号 / 绝对两种色标）与原始观测。
- 有效区 MSE 曲线（含第 0 次初值），带悬停十字线与数值提示。
- 改参数即作废旧结果，导出按钮同步禁用；每次运行带 runId，异步回调不会写入旧运行。
- 导出：16 位复原 PNG（`clip[0,1]` 后 `floor(65535·v+0.5)`）、8 位重模糊 PNG
  （`floor(255·v+0.5)`）、含核、掩膜摘要与逐次 MSE 的 JSON；量化方式同时写入 PNG tEXt 与 JSON。

## 数学约定（与样例规则一致）

- 反射边界，边缘不重复：`R(k,1)=0`；`n>1` 时 `p=k mod(2n-2)`，`p<n` 则 `R=p`，否则 `R=2n-2-p`。
- 前向（聚集）：`(Ax)[y,x] = Σ h[a,b]·x[R(y+a-ay), R(x+b-ax)]`。
- 反向是前向的**真正伴随**：对每个输出位置按同一组反射索引把贡献**散射累加**回源像素，
  边缘被多个反射映射命中时全部累计——不是“把核翻转再套同一种边界”的卷积。
- `ε=1e-8`；每通道初值 `max(有效观测均值, ε)`，第 0 次即初值。
- 更新：`x⁺ = x·Aᵀ(M·y/max(Ax,ε)) / AᵀM`；`AᵀM=0` 的像素置 0；无额外正则项、无自动停止。
- `MSE = Σ_{像素,通道} M·(Ax−y)² / (有效像素数·通道数)`，残差显示只统计有效区。

## 工程结构

| 路径 | 作用 |
|---|---|
| `app/index.html` | 构建产物，自包含可直接打开的页面 |
| `app/index.template.html` | 页面模板（UI 与页面逻辑），构建时内联下面两个模块 |
| `tools/engine.js` | RL 引擎：反射索引、前向、真伴随、迭代。页面与 Node 测试共用同一份代码 |
| `tools/png_encoder.js` | 8/16 位 PNG 编码（CRC32/Adler-32 自写，CompressionStream + 存储式 zlib 回退） |
| `tools/png_io.py` | 测试用纯标准库 PNG 解码器 |
| `tools/ref_rl.py` | 独立 Python 参考实现，对照样例 `reference.json` |
| `tools/gen_py_expected.py` | 生成 medium 灰度/RGB 的 Python 期望值 |
| `tools/test_engine.js` | 引擎数值测试（reference.json + Python 交叉验证 + 反射规则） |
| `tools/test_png.js` / `check_png.py` | PNG 编码器单元测试与独立解码核对 |
| `tools/e2e_test.js` | Playwright 无头浏览器端到端测试（UI 流程、取消、作废、导出回读） |
| `tools/build.js` | 把 engine/encoder 内联进模板生成 `app/index.html` |
| `tools/run_all_checks.sh` | 一键完整验证流水线 |

## 验证

```bash
bash tools/run_all_checks.sh
```

关键结论：

- 前向、伴随与样例 `reference.json` 的 `A_probe`、`AT_dual`、伴随内积恒等式误差 ~1e-16。
- tiny 掩膜用例 0–3 次迭代的完整图像与 MSE 与参考逐元素一致（~1e-16）。
- medium 灰度 / RGB 与独立 Python 实现交叉一致（x 误差 <3e-14，MSE <4e-15）。
- 偶数尺寸、偏心 anchor 的非对称核 + 掩膜场景，JS 与 Python 逐元素一致（~1e-16）。
- 16/8 位导出 PNG 经独立解码器回读，样本与量化规则逐值相等，tEXt 元数据齐全。
- 无头浏览器 31 项端到端测试全部通过，含取消、参数作废、运行取代、无控制台错误。
- 最坏工况（512×512 RGB、15×15 核、100 次）约 67 秒、约 600 MB 堆内存，可随时取消。
