# 平面展板照片投影拼接

把现场分多张拍摄的平面展板照片，依据手工对应点拼接成一张透明背景 PNG 的纯静态网页。
所有配准、单应估计、RANSAC、透视重采样与融合均为自实现，不调用任何现成的配准 / 拼接 /
透视重采样接口；仅矩阵特征分解（Jacobi）与运行时内置的 zlib 流压缩作为通用基础能力。

## 运行

无需安装依赖（Node ≥ 18，浏览器需支持 `CompressionStream`，当前主流浏览器均支持）。

```bash
node tests/serve.mjs        # 然后打开 http://127.0.0.1:8123/
```

或直接用任意静态服务器托管 `app/` 目录（ES Module 不能用 `file://` 打开）。

## 使用流程

1. 加载 2–4 张 8 位 RGB/RGBA PNG（单边 ≤ 1024），再加载 `matches.json`。
2. 选择参考图、设置 RANSAC 误差阈值（像素，默认 3）。
3. 在两个源图面板上增删 / 拖动对应点：先在一张图空白处点击放置挂起点，再在另一张图
   点击对应位置补全；点击已有点可选中并拖动，删除键移除选中点对。也可新建 / 删除边。
4. 点击「运行拼接」，在五种预览间切换：拼接结果、内/外点、拼接边界、各层覆盖、重叠区差异。
5. 导出透明背景 `mosaic.png` 与 `mosaic.json`（画布坐标、各图矩阵、内点索引）。

## 输入 / 输出约定

坐标一律按**像素中心**计：`x=0..w-1`、`y=0..h-1`，四角为
`(0,0)、(w-1,0)、(w-1,h-1)、(0,h-1)`。

`matches.json`：

```json
{
  "images": ["0.png", "1.png"],
  "reference": 0,
  "edges": [{ "a": 0, "b": 1, "pairs": [[[xa, ya], [xb, yb]], "..."] }]
}
```

边模型 `H_ab` 把 a 坐标映到 b；所有矩阵比较时除以 `H[2,2]` 归一化。

导出 `mosaic.json` 含：`canvas`（宽高、原点、`offset=-min`）、`reference`、
`image_to_reference`、`image_to_canvas`（已统一平移）、每条边的 `inliers/outliers`、
生成树边与闭环残差。

## 算法实现要点

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 线性代数 / Jacobi 特征分解 | `app/js/linalg.js` | 3×3 与通用 n×n 对称矩阵特征分解，单应求逆、归一化 |
| 归一化 DLT + RANSAC | `app/js/homography.js` | Hartley 各向同性归一化；固定种子 mulberry32 采样，结果可复现；误差为 a→b 欧氏重投影距离；自适应迭代上限；内点归一化 DLT 重估计 |
| 连通树与变换组合 | `app/js/graph.js` | 以内点数为权的最大生成树（Kruskal），BFS 组合各图到参考图；非树边报告参考平面对应残差，超阈值提示不一致 |
| 几何 / 退化检查 | `app/js/geometry.js` | 四角与四边细分采样检查齐次分母，跨零或接近零判定投影地平线穿图并拒绝；画布 `floor(min)`/`ceil(max)` 两端包含 |
| 重采样与融合 | `app/js/resample.js` | 逆映射双线性；sRGB 分段（阈值 0.04045）转直线光；先预乘 alpha 再插值；Felzenszwalb 距离变换，权重=到最近无效像素中心距离+1（画布外环无效）；`C=Σ(w·α·C)/Σ(w·α)`、`α=Σ(w·α)/Σ(w)`，全无效 RGBA 全 0 |
| PNG 编解码 | `app/js/png.js` | 手写签名 / 分块 / CRC32 / 反滤波，deflate 用内置流；仅 8 位 RGB/RGBA、非隔行 |
| 主管线 | `app/js/mosaic.js` | 输入校验、逐边 RANSAC、连通 / 退化 / 4096 限制、重采样融合、导出 JSON |

### 关键正确性处理

- **透明边缘不变暗**：先做 sRGB→直线光，再预乘 alpha 后双线性，透明像素的 RGB
  （可能是垃圾值）因 α=0 不参与任何贡献；输出 alpha 不做伽马变换。
- **退化可解释**：对应点重合 / 共线（DLT 秩亏）、`h33≈0`、图间不连通、投影地平线穿图、
  输出超过 4096×4096 都以明确错误码和中文原因拒绝，而不是产出错误结果。
- **闭环一致性**：未参与生成树的边，把内点从两端分别映到参考平面计算欧氏残差
  （max/mean/rms），超过用户阈值即提示对应关系不一致。

## 测试

```bash
# Node 算法验收：对照样例 expected.json / expected_inliers + 单元探针 + 失败分支
node tests/run-tests.mjs samples/extracted/translation samples/extracted/projective
# 合成场景：闭环残差、参考图切换、误点剔除、超 4096
node tests/synthetic.mjs
# 端到端导出 PNG/JSON
node tests/e2e.mjs samples/extracted/translation samples/extracted/projective
# 浏览器（Playwright + 本地 Chromium）：UI 全流程与错误对话框
node tests/browser-smoke.mjs samples/extracted/projective
node tests/browser-errors.mjs
```

## 目录

```
app/                 静态网页（零运行时依赖）
  index.html css/style.css
  js/                算法核心（可在 Node 直接 import）
  js/ui/             状态、预览渲染、DOM 控制器
tests/               Node 验收与 Playwright 浏览器测试
samples/             原始压缩包与解压样例（验收数据，不参与运行）
```
