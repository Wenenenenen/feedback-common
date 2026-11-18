# PNG 扫描行实验室（png-scanline-lab）

纯前端 PNG 扫描行编码校验工具，用于定位重压缩后偶发的错行问题（隔行图与 16 位灰度尤其难查）。
块解析、CRC 校验、五种扫描行过滤、Adam7 隔行重组全部自行实现；仅 zlib 压缩/解压使用平台能力
（浏览器与 Node 18+ 原生的 `DecompressionStream` / `CompressionStream`），**不借助任何图像库或浏览器图像解码**。

## 使用

直接用浏览器打开 `index.html`（无需服务器、无外部依赖），拖入或选择 PNG 文件。

支持的格式（与 `samples/约定.json` 一致）：

- 灰度（类型 0）8/16 位；RGB（类型 2）/ RGBA（类型 6）8 位；索引色（类型 3）1/2/4/8 位
- 压缩方法 0、过滤方法 0、隔行 0（无）或 1（Adam7）
- 宽高 1–2048，文件 ≤ 20MB

功能：

- **校验**：签名、块长度、CRC32、IHDR/IEND 唯一及顺序、PLTE 必要性、IDAT 连续性、未知关键块；
  按每个 pass 的行长度精确限制解压总量，拒绝尾随扫描流
- **预览**：统一 RGBA8（棋盘格衬底显示透明），点击图像查看**不降位**的原始通道值
- **Pass 分析**：每个 pass 的尺寸、逐行过滤类型（彩色条带，悬停查看行号）、压缩占比
  （各 pass 过滤流分别 deflate 的估算值）
- **重编码**：指定过滤器（0–4）或自动择优（逐行最小 |int8| 和，平局取小编号），
  输出**非隔行** PNG，保留原始位深、调色板、像素与 tRNS 透明度
- **导出**：重编码 PNG 文件 + 逐行过滤记录 JSON（也可导出原图的逐行记录）
- **损坏文件**：指出具体块（编号/类型/偏移）或 pass/行位置并停止，绝不用部分图冒充成功

## 文件结构

```
index.html        页面
css/style.css     样式
js/png-core.js    核心库（浏览器 window.PNGCore / Node module.exports 通用）
js/app.js         页面逻辑
test/run-tests.js     Node 真值校验（对照 samples 的 manifest.json）
test/browser-test.js  Playwright 端到端冒烟测试（需全局 playwright）
samples/          样例（含 manifest.json 真值与 约定.json 规范）
```

## 测试

```bash
# 解出样例（manifest.json 含每个有效样例的解码真值）
mkdir -p /tmp/png-samples && unzip -o samples/png-scanline-lab-cases.zip -d /tmp/png-samples

# 核心库：9 个有效样例逐像素/逐行过滤比对 + 3 个损坏样例报错位置 + 重编码往返
node test/run-tests.js /tmp/png-samples

# 浏览器端到端（可选，需 npm i -g playwright 及 chromium）
NODE_PATH=$(npm root -g) node test/browser-test.js /tmp/png-samples
```
