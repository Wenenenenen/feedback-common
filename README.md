# 绿幕序列抠像工作台

纯前端（无构建、无运行时依赖）的绿幕序列抠像网页：导入 PNG 序列 ZIP，整段共用
键控参数，绘制对全序列生效的保留/剔除多边形，逐帧或按帧率播放，多视图检查边缘，
最后导出含直通 α RGBA、8 位灰度遮罩、背景合成图三套 PNG 序列的 ZIP。

## 运行

```bash
node tools/serve.mjs 8317     # 任意静态服务器均可，然后打开 http://localhost:8317
```

不需要 npm install。浏览器要求支持 `CompressionStream`（Chrome 80+ / 同类现代浏览器），
ZIP 的 DEFLATE 与 PNG 编码全部走浏览器原生 API；Node 端自动回退到 `node:zlib`。

## 功能与需求对照

| 需求 | 实现 |
| --- | --- |
| 导入 ZIP 内 8 位 sRGB RGB PNG，按文件名数字帧号排序 | `src/sequence.js`，取文件名最后一段数字，未补零也正确排序 |
| 最多 120 帧、1280×720，尺寸不一致拒绝 | 导入时逐项校验，中文错误提示（含帧数、通道、尺寸各类拒绝） |
| 取绿幕颜色、内外阈值、边缘软化、去绿强度，整段共用 | 右栏参数对全部帧生效；取色器取 3×3 邻域均值 |
| 保留/剔除多边形对全序列生效，重叠剔除优先，保留区全不透明且原色不去绿 | `src/keyer.js` 像素中心光栅化，剔除后写覆盖保留；保留像素跳过 despill |
| preset.json 应用多边形，定标 MAE ≤ 0.04 | 实测定标帧 MAE **0.00036**，24 帧序列最差 **0.00177** |
| 逐帧及指定帧率播放 | 时间戳驱动的 rAF 循环，1–60 fps 可调，进度条拖拽逐帧 |
| 原图/灰度遮罩/棋盘格/黑白底/自选背景 PNG | 六种视图；背景 PNG 校验尺寸一致 |
| 放大查看边缘 | 滚轮以指针为中心缩放、按钮缩放、拖拽平移、双击复位，像素化渲染 |
| 预览与导出一致 | 预览与导出调用同一个 `processFrame()`（`src/export.js`），同一份数学 |
| 导出 rgba/ matte/ composite/ 三目录 ZIP | 保留原文件名（数字帧号）与尺寸 |
| 直通 α，全透明像素 RGB 归零 | `buildRgba()` 以舍入后的字节 alpha 判定，0 即 RGB 全 0 |
| 8 位灰度遮罩 | PNG color type 0 |
| 线性光背景混合再转回 sRGB，不重复乘 α | `compositeLinear()` 直通 α 线性 over，无预乘，独立复算最大 1 字节舍入差 |

## 键控算法

1. sRGB 字节经 LUT 转线性光；
2. 绿色度 `d = G − max(R, B)`（线性域）。内阈值以下 α=1，外阈值以上 α=0，
   之间线性过渡；外阈值自动钳到取色点自身绿色度，取到非绿色时也不会反转；
3. 可选盒式模糊做边缘软化（只改变过渡带，0/1 语义保持）；
4. 多边形覆盖：保留写 1、剔除写 0，剔除最后应用故重叠处优先；
5. 去绿仅压低超出 `max(R,B)` 的绿色分量，强度可调，边缘权重高于实心核心，
   保留多边形内像素完全跳过；
6. 合成在线性光做 `F·α + B·(1−α)` 再编码回 sRGB。

## 目录结构

```
index.html            页面骨架
src/color.js          sRGB/线性转换与 LUT
src/keyer.js          绿色度键控、多边形光栅化、软化、去绿、合成、RGBA/灰度打包
src/png.js            零依赖 PNG 编解码（color type 0/2/6，五种 filter 解码）
src/zip.js            ZIP 读写（stored/deflate，zip-slip 防护）
src/zip-deflate.js    deflate-raw 适配（CompressionStream / node:zlib）
src/sequence.js       导入校验、帧号解析、背景 PNG 校验
src/export.js         预览与导出共用的 processFrame() 与 ZIP 打包
src/state.js          应用状态与多边形模型
src/renderer.js       六视图画布渲染、多边形叠加、缩放平移、命中测试
src/app.js            UI 控制器
test/                 node:test 单元/定标测试
tools/                静态服务器、Node 端端到端校验、Playwright 浏览器冒烟
```

## 测试

```bash
# 1) 单元 + 定标（11 项），CASES_DIR 指向解压样例目录
CASES_DIR=/path/to/cases node --test test/keyer.test.js

# 2) Node 端端到端：导入→preset→导出→回读 ZIP 逐条核对合同
CASES_DIR=/path/to/cases node tools/e2e-verify.mjs

# 3) 真实浏览器冒烟（需先起静态服务器；Playwright 走全局软链，不下载浏览器）
node tools/serve.mjs 8317
CASES_DIR=/path/to/cases APP_URL=http://localhost:8317 node tools/browser-smoke.mjs
```

样例数据属于不可信输入，应解压在仓库外的独立目录；测试通过 `CASES_DIR` 环境变量
传入路径，不硬编码位置。
