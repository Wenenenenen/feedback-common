# 拜耳 RAW 去马赛克对比台

纯 JavaScript（零第三方运行时依赖）实现的相机 RAW 拜耳去马赛克对比工具：浏览器页面实时切换算法、局部放大、单通道采样位置查看、PSNR 指标与 16 位 PNG/JSON 导出；同一套核心库在 Node 下做参考校验与命令行批处理。

## 实现的算法

| 算法 | 说明 |
|---|---|
| 双线性 | 严格按样例《格式说明.md》定义：R/B 位置 G 取四邻域、另一主色取四角；G 位置按行/列方向取两邻域；边界镜像 −1→1、w→w−2，**不裁剪** |
| Hamilton-Adams | 边缘自适应（US 5629734）：R/B 位置的 G 用含拉普拉斯二阶项的水平/垂直梯度判决，再以色差 G−C 双线性回填主色，抑制细线摩尔纹与拉链边 |

处理顺序与样例约定完全一致：

1. `v = (raw − black) / (white − black)`，乘所在颜色的白平衡增益，限幅 0..1；
2. 去马赛克得到每像素 RGB；
3. 16 位量化 `floor(v × 65535 + 0.5)`。

全程 float64 计算，双线性输出与 `ref-bilinear/*.png` **逐像素完全一致**，对 truth 的 PSNR 与 `reference.json` 精确吻合。

## 目录结构

```
lib/                 核心库（浏览器与 Node 共用，纯 ES Module）
  mirror.js          镜像下标映射（边界不裁剪）
  raw.js             BYR1 文件头解析、四种 CFA 排列、归一化与白平衡
  demosaic.js        双线性 / Hamilton-Adams、16 位量化、PSNR
  png.js             16 位 PNG 编码与 PNG 解码（zlib 走原生 CompressionStream/node:zlib）
  pipeline.js        端到端管线封装
web/                 对比页面（Worker 后台重算，不阻塞 UI）
tools/
  verify.js          Node 校验：逐像素对齐参考、PSNR、异常 RAW、PNG 回环
  e2e.js             Playwright 浏览器端到端测试
  e2e-upload.js      本地 RAW 上传与无效文件拒绝测试
  cli.js             命令行批量导出
  serve.js           零依赖静态服务器 + /api/cases 数据接口
```

## 使用

先解压样例（数据按不可信输入隔离在 `samples/extracted/`，已在 .gitignore）：

```bash
unzip samples/bayer-demosaic-bench-cases.zip -d samples/extracted
```

启动对比台：

```bash
npm run serve          # http://localhost:8123
```

页面功能：

- 样例切换（zone/edges/lines/colorbars，覆盖 RGGB/BGGR/GRBG/GBRG 四种排列与 10/12/14/16 四种位深）；
- 算法切换、白平衡增益修改后 **120ms 防抖自动重算**，序列号机制丢弃过期结果；
- 全图导航点击/拖拽，左右分屏对比当前结果与 truth，三个滚动窗位置联动；
- 1×/2×/4×/8× 最近邻放大，RGB/仅 R/仅 G/仅 B 通道切换；
- 底部独立 CFA 视图显示每个像素**实际采样的那个颜色**（去马赛克前），4× 以上可叠加采样格；
- PSNR 总体值与分通道值（定义 `10·log₁₀(65535²/MSE)`，三通道全部像素）；
- 导出当前结果的 16 位 PNG 与含参数、指标、处理约定的 JSON；
- 支持打开本地 BYR1 RAW（无 truth 时 PSNR 标记为不适用，非法文件给出明确错误且不污染当前状态）。

命令行批量导出：

```bash
npm run export -- samples/extracted/lines.raw samples/extracted/lines.json hamiltonAdams out/
# 产出 out/lines-hamiltonAdams.png（16 位 RGB）与 out/lines-hamiltonAdams.json（含 PSNR）
```

## 校验

```bash
npm run verify         # 核心库对参考数据的全部断言
node tools/e2e.js      # 浏览器端到端（需 Playwright 的 Chromium）
node tools/e2e-upload.js
```

校验结论（本机实测）：

- 双线性 4 个用例对 `ref-bilinear` 逐像素零差异，对 truth 的 PSNR 与参考值误差 < 0.01 dB；
- Hamilton-Adams 在纹理用例上 PSNR 全面优于双线性，例如 lines 15.704 → 20.956 dB、edges 22.228 → 24.438 dB；colorbars 为理想硬色块，边缘自适应的过冲使其略低（25.999 → 24.542 dB），属算法特性，测试中只记录不设断言；
- 三个异常 RAW（错误魔数、非法排列号、文件截断）均被拒绝并给出中文原因；
- 16 位 PNG 经 ffmpeg 独立解码验证。

## 设计要点

- **边界不裁剪**：所有邻域访问（含 HA 的 ±2）经 `mirrorIndex` 反射，反射后仍落在同色 CFA 位置，输出尺寸与 RAW 完全相同。
- **无回绕**：自适应插值在硬过渡处中间值可能超出 0..1，量化前统一 clamp，避免 Uint16 回绕伪影。
- **显示与计算分离**：sRGB 伽马只用于画布显示，PSNR 与导出始终在线性 16 位数据上进行。
