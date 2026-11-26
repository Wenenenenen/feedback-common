# 横段掩码裁区拓扑检查台

超大二值扫描图的**横段（run-length）裁区检查网页**。质检只提供每行前景段，需要反复裁掉若干行、观察某个孔是否已与外部连通；整图展开成逐像素数组会爆内存。本站点只以横段 + 并查集做拓扑核算，**不调用任何现成连通域接口、不分配 `width × height` 的像素整图**。

零运行时依赖、零构建。

## 打开方式

```bash
python3 -m http.server 8123
# 浏览器访问 http://127.0.0.1:8123/index.html
```

也可以直接双击 `index.html` 用 `file://` 打开：算法与界面都是经典脚本，可直接运行；此时浏览器会拦截 `fetch` 读取 `samples/run-mask.json`，页面会自动改用与该文件完全一致的内置示例副本。

页面打开后会自动载入 `samples/run-mask.json`。也可以：

- **导入 JSON…**：选择自己的横段文件；
- **生成满额压测数据**：在浏览器内生成 `1,000,000 × 1,000,000`、恰好 200,000 条原始横段（含约 1 万个真实小环孔）并立即核算；
- 命令行生成满额文件供文件选择器导入：
  ```bash
  node test/make-large-sample.mjs /tmp/large-run-mask.json
  ```

## 数据格式

与 `samples/run-mask.json` 一致：

```json
{
  "width": 20,
  "height": 12,
  "runs": [[4, 3, 8], [2, 5, 8]]
}
```

- 每项为 `[行号 y, 起始列 x0, 结束列 x1]`，左上角 `(0,0)`，`x` 向右、`y` 向下；
- **左闭右开**：覆盖第 `x0 … x1-1` 格；
- 宽高支持到 `1,000,000`，横段最多 `200,000`；
- 横段允许**乱序、重复、交叠、相邻**，导入时按并集合并为有序、互不交叠且不相邻的规范段；
- 也兼容对象段（`{y,x0,x1}` / `{row,start,end}` 等常见键名）与 `w/h` 别名；越界坐标会宽容地裁回边界并在控制台给出警告。

## 操作

- **拖选裁区**：在上方「整图导航」按住鼠标拖矩形；
- **整数裁区**：顶部输入 `x0 y0 x1 y1`（半开、原图坐标）后「应用裁区」，或回车；「整图」复位；
- **裁掉顶部 N 行**：专用按钮，配合孔跟踪检查“裁掉几行后孔是否通外部”；
- **点选**：在裁区视图单击格，或在右侧列表选择组件 / 孔；列表虚拟滚动，支持编号跳转；
- 选中后显示**面积、包围框（半开边界与宽高）、周长、最上最左锚点**，列表项点击会自动缩放定位到包围框；
- 裁区视图支持拖拽平移、滚轮以光标为锚缩放、双击 / 按钮适应；
- **跟踪孔**：选中孔 →「跟踪此孔」，会在该孔最长横段中点放一个探针。之后任意改裁区，面板直接报告：
  - `仍是孔 #n`（并给新编号 / 面积）；
  - **`该孔已与裁区外部背景八连通，不再计为孔`**；
  - `探针已落到裁区之外（可能已被裁掉）`。
- **查看 / 导出裁区结果**：弹窗展示 JSON，可复制或下载 `run-mask-crop_x0-y0_x1-y1.json`。

## 拓扑与统计约定

所有统计都在**裁后**数据上重新计算，裁区是原图坐标中的半开整数矩形 `[x0,y0)–[x1,y1)`。

- **前景 4 连通**：仅上下左右相邻。每条前景横段是一个节点，相邻行中半开区间严格相交的横段合并，用路径压缩并查集求组件。
- **背景 8 连通**：由前景段反推每行背景段；相邻行两段列集合距离 ≤ 1（半开区间下等价于 `a0 <= b1 && b0 <= a1`，端点相等即对角相邻）时合并，单独的背景并查集。
- **孔**：背景 8 连通组件中，**没有任何背景格碰到裁区四条边**的才计为孔；贴边组件视为外部背景。
- **前景周长**：数所有未与裁区内另一前景格共享的单位边。每条极大横段贡献左右 2 条竖边；上下边长按未被相邻行前景覆盖的长度计算。裁区外不参与覆盖，因此**裁切线照常计入周长**（例如把满前景矩形裁成 `w×h`，周长为 `2(w+h)`）。孔内壁边自然包含在内。
- **编号**：前景组件与孔都按“最靠上的格 `y` 最小；同一最上行取最靠左的格 `x` 最小”排序，从 1 编号。裁区改变后编号按新结果重排。
- **确定性**：算法是输入与裁区的纯函数，横段与编号固定排序，导出 JSON 不含时间戳；同一裁区反复计算、裁走再裁回，结果逐字符相同。

### 导出 JSON 结构

```json
{
  "format": "run-mask-crop@1",
  "coordinateSystem": "original-image",
  "width": 20,
  "height": 12,
  "crop": { "x0": 0, "y0": 0, "x1": 20, "y1": 12, "width": 20, "height": 12 },
  "runs": [[2, 3, 8], [3, 3, 4]],
  "stats": {
    "foregroundComponents": 2,
    "holes": 1,
    "foregroundPixels": 16,
    "backgroundPixels": 224,
    "holePixels": 3,
    "totalPerimeter": 34
  },
  "components": [{ "number": 1, "area": 12, "perimeter": 24, "bbox": { "x0": 3, "y0": 2, "x1": 8, "y1": 5 } }],
  "holes": [{ "number": 1, "area": 3, "bbox": { "x0": 4, "y0": 3, "x1": 7, "y1": 4 } }]
}
```

`runs` 是**裁区内、用原图坐标表示的规范横段**（被裁区截断的段只保留裁内部分，坐标不加偏移）。

## 性能

复杂度约为 `O(H_crop + R + B α(B))`：逐行扫描（高度上限 100 万，纯整数循环），前景节点 ≤ `R`，背景段节点 ≤ `R + H_crop`，全部使用 `Int32Array / Uint32Array / Float64Array`。不分配 `width*height` 网格。

在本机（Node 22 / 普通开发机浏览器）实测 20 万满额横段：解析约 0.2–0.4 s，整图分析约 **0.5–1.2 s**，80 万见方裁区约 **0.3–0.4 s**，均远低于 8 s 要求；页面统计栏会显示每次实际耗时。

## 测试

```bash
npm test
# 或
node test/validate.mjs
FUZZ_ITERS=4000 node test/validate.mjs   # 加大随机对拍
```

`test/validate.mjs` 包含：

- `samples/run-mask.json` 的手工核算值（2 个组件面积 12/4、周长 24/10，1 个面积 3 的孔，总周长 34）；
- 数千个随机小掩码 × 随机裁区，与**逐像素 BFS 参考实现**逐项对拍组件数、编号锚点、面积、包围框、周长、孔、逐格点选结果；
- 背景段覆盖完整性不变量、导出确定性与幂等；
- 对角八连通、空图、满矩形、裁切边周长、裁掉顶盖使孔通外部、退化 / 越界裁区等边界；
- 100 万 × 100 万 / 20 万段满额性能断言（整图与裁区均 < 8 s）。

## 浏览器自动化钩子

页面暴露 `window.RunMaskApp`，便于无界面验收直接驱动与取数：

```js
RunMaskApp.loadJSONObject(obj, 'case.json');
RunMaskApp.setCrop({ x0, y0, x1, y1 }); // 同步返回摘要
RunMaskApp.getAnalysis();                // 完整结果（含组件/孔明细与类型化索引）
RunMaskApp.locate(x, y);                 // 坐标 -> foreground/hole/external + 编号
RunMaskApp.selectComponent(1, true);
RunMaskApp.startTrackHole(1); RunMaskApp.trackProbe();
RunMaskApp.getExportText();
RunMaskApp.generateBenchmark();
RunMaskApp.getState();
```

`#machine-state` 元素内还有一份与界面同步的轻量 JSON 摘要（统计、裁区、选择、探针、耗时）。

Node 侧 `js/topology.js` 同时兼容 `require`、ESM 默认导入与 ESM 命名导入：

```js
const T = require('./js/topology.js');
// 或 import { analyzeMask } from './js/topology.js'
```

## 文件

- `index.html` / `css/style.css` / `js/app.js` — 页面与交互；
- `js/topology.js` — 零依赖核心算法（浏览器全局 + Node 双用）；
- `test/validate.mjs` — 暴力对拍与性能测试；
- `test/make-large-sample.mjs` — 满额样例文件生成器；
- `samples/run-mask.json` — 题目样例。
