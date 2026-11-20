# LUT 链校验台

颜色查找表（LUT）多级串联校验网页。纯静态页面，直接用浏览器打开 `index.html` 即可，无构建步骤、无外部依赖。

## 功能

- **`.cube` 解析**：`TITLE`、`DOMAIN_MIN/MAX`、`LUT_1D_SIZE`(2..4096)、`LUT_3D_SIZE`(2..65)、`#` 注释、空白与科学计数法；单文件一种表，未给 DOMAIN 默认 0..1。数据条数不符、DOMAIN min≥max 等错误会在页面上明确报出。
- **链管理**：最多 8 级，可上移/下移排序、逐级开关、移除。
- **逐级求值**：每级先按各通道 DOMAIN 归一化并夹到 [0,1]；1D 逐通道线性插值；3D 四面体插值（分数降序、平手按 R/G/B，顶点 000、e_a、e_a+e_b、111，权重 1−f_a、f_a−f_b、f_b−f_c、f_c）。表输出可超出 [0,1]，**级间不夹紧**，只在下一级 DOMAIN 输入处或最终展示时夹紧。
- **图像**：8 位 RGBA PNG，边长 ≤ 1024。解码经 WebGL 未预乘读回，**不预乘、保留 alpha 及透明像素的 RGB**。点选像素或输入浮点 RGB 可查看每级输入输出。
- **烘焙**：按指定输入 DOMAIN 与网格边长（2..65）把完整启用链采样成单张 3D `.cube`；可导出，也可一键载入为对比表（或从文件载入烘焙结果），用 DOMAIN 内**连续随机探针**（非网格点）对比原链与烘焙表，给出最大/平均/RMS 误差及误差最大的前 50 条。
- **导出**：处理后 PNG（自实现编码器，透明像素 RGB 原样写出）、烘焙 `.cube`、含完整表内容/顺序/启用状态/烘焙设置的工程 JSON（可重新载入）。

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` / `style.css` / `app.js` | 页面与 UI 逻辑 |
| `lut-core.js` | 纯计算核心（解析、插值、链、烘焙、PNG 编码、探针对比），浏览器与 Node 通用 |
| `test/lut-core.test.js` | 核心算法测试：`node test/lut-core.test.js <样例目录>` |
| `test/browser-smoke.test.js` | 浏览器全流程冒烟（需 playwright）：`NODE_PATH=$(npm root -g) node test/browser-smoke.test.js <样例目录>` |
| `test/alpha-roundtrip.test.js` | 透明像素 RGB 端到端保留验证 |

## 关键实现说明

- **不预乘管线**：浏览器 canvas 2D 内部是预乘的，直接 `getImageData` 会丢失透明像素的 RGB。这里用 `createImageBitmap(blob, {premultiplyAlpha:'none'})` + WebGL（`UNPACK_PREMULTIPLY_ALPHA_WEBGL=false`）读回原始 RGBA；导出时自实现 PNG 编码器（`CompressionStream('deflate')` 产 zlib 流 + 手工 CRC32），绕开 canvas 的预乘。
- **四面体插值的"网格点一致"陷阱**：源表的折痕平面若与烘焙网格对齐（如源 N=3、烘焙 N=17），网格点乃至整体都可能完全吻合；只有连续探针才能暴露非对齐情形（如链中含 1D shaper、或边长不整除）下网格点之间的误差。对比面板因此只使用连续随机探针。
