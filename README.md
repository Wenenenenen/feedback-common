# BC 块压缩核对台

逐块核对自研 BC1 / BC3 编码器的网页工具。针对渐变块感、透明边缘黑边等问题，
可点击任意 4×4 块查看端点、索引、调色板与所用模式，并导出 DDS 和含逐块误差的 JSON。

## 运行

页面用 Web Worker 在后台编码，Worker 代码通过同源 `fetch` 加载，因此需要经 HTTP 访问
（不能直接 `file://` 打开）：

```bash
cd web
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/
```

## 文件

| 文件 | 职责 |
| --- | --- |
| `web/index.html` | 页面、三画布对比、块详情面板、导出 |
| `web/bc-codec.js` | BC1/BC3 编码与解码（严格按 `格式说明.md` 的插值取整） |
| `web/bc-inflate.js` | 纯 JS RFC1951 inflate，用于解 PNG IDAT（不依赖 DecompressionStream） |
| `web/bc-ioutil.js` | PNG 读取、补边裁剪、DDS 头、误差统计、JSON 导出 |
| `tools/` | Node 与 Playwright 测试，以及 Python 参考解码器 |

## 编码要点

- **端点优化**：主成分分析（PCA）取数据主方向，投影极值 + 包围盒角生成候选 565 端点，
  再做位域坐标下降局部求精，不是只取包围盒两角。
- **BC1 透明模式**：块内含 alpha<128 像素时才允许 c0≤c1 模式，透明像素强制索引 3；
  全不透明块保证不产生透明像素。4 色 / 3+透明两种模式按同口径 SSE 比较并对透明像素加惩罚。
- **BC3**：alpha 子块与颜色子块独立优化；颜色拟合只看不透明像素，alpha 用单调斜坡
  端点窗口枚举 + 局部求精，两种 alpha 表模式（8 插值 / 6 插值+0/255）都支持并择优。
- **解码严格性**：565 展开、三分点 / 二分点插值、alpha 表公式全部按约定 floor 取整。

## 测试

```bash
node tools/test-inflate.js   # inflate 与 Node zlib 交叉验证（三种块类型、多压缩级别）
node tools/test-codec.js     # 解码逐字节比对参考 PNG、PSNR 阈值、模式合法性
node tools/test-ioutil.js    # DDS 头逐字节比对样例、补边裁剪、统计与 JSON
node tools/test-fringe.js    # 镂空边缘黑边量化（448 个边缘像素零错误）
node tools/e2e-browser.js    # Playwright 驱动真实页面的端到端测试（27 项）
```

关键验收结果：

- 三个样例 DDS 的 JS 解码与 `ref-decoded/` 参考图**逐字节一致**
- `gradient.png` BC1 RGB PSNR **41.22 dB**（阈值 39，朴素包围盒约 40.5）
- `cutout.png` 二值 alpha 解码后 255→255、0→0，无黑边
- `soft-alpha.png` BC3 alpha PSNR 约 63 dB、不透明像素 RGB PSNR 约 46 dB
- DDS 文件头按约定 128 字节布局，重生成与样例头逐字节一致

## 输入约束

8 位 RGBA/RGB PNG（也支持灰度、调色板），单边 ≤ 1024。宽高非 4 倍数时复制最右列、
最下行补到 4 的倍数再分块，显示与导出尺寸裁回原图。16 位 PNG 和超尺寸图会被拒绝并提示。
