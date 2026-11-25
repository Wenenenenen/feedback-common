# Genlock 填充画面 × 透明键 配对核对台

播出前核对 **填充画面（fill, P6 PPM）** 与 **灰度透明键（key, P5 PGM）** 的纯前端网页。
两路录制的帧号会模回绕、偶尔重采同一格；本项目不用“逐帧找最近键”的贪心，而是在
**键不可复用、不可逆序** 的约束下求全局最优配对：

1. **配对数最大**
2. **总绝对校正时差最小**
3. **键位置序列字典序最小**（每个填充排序位置一项键排序位置，空位 `null` 参与比较时比任何整数都大，即排最后）

样例与原始约定见 `samples/genlock-key-cases.zip`，解压副本在 `sample/`。

---

## 1. 快速开始

零运行时依赖、无需 `npm install`，Node ≥ 18 即可起静态服务：

```bash
npm start                 # 默认 http://0.0.0.0:8123/
# 或
node tools/serve.js 9000  # 指定端口
PORT=20100 npm start
```

也可以用任意静态服务器，例如 `python3 -m http.server 8123`，然后浏览器打开 `http://localhost:8123/`。
脚本都是经典 UMD `<script>`（非 ES Module），因此直接双击 `index.html` 也能打开，
只是“载入内置样例”的 `fetch` 在 `file://` 下会被浏览器拦截（改用文件选择框上传 zip 即可）。

**操作路径**：点“载入内置样例”一键加载；或点“选择 project.json / 样例 zip / 图像（可多选）”
后选择 `samples/genlock-key-cases.zip`（也可多选解压后的 `project.json + *.ppm + *.pgm`，或选择整个文件夹）
→ 点“提交并求解” → 用“跳到该填充位置 / 上一帧 / 下一帧 / 滑条”回到任一填充帧核对 →
下载当前帧 PNG、区间 PNG(zip)、JSON/CSV 配对表。

---

## 2. 输入约定（与样例包 `约定.txt` 一致）

`project.json`：

| 字段 | 取值 |
| --- | --- |
| `width`,`height` | 正整数，宽至多 640、高至多 360 |
| `modulus` | 2..65536，帧号模数 |
| `fill_mode` | `"straight"` 或 `"premult"` |
| `offset` | 有符号 32 位整数 |
| `tolerance` | 非负 u32（0..4294967295），**含端点** |
| `fill` / `key` | 记录数组，每路最多 **180000** 条 |

每条记录：`{ "t": 0..10^12 整数, "id": u32, "image": "相对路径" }`。
每路最多 32 个不同图像文件，同一图可反复引用。填充图为 8 位 `P6` RGB，键为 8 位 `P5` 灰度，尺寸与 `width×height` 一致，码值按线性处理。

**排序**：每路按 `(t 升序, 原始输入位置升序)` 排序；同时刻记录因此按文件/数组中的原始顺序排列。
“键排序位置”是排序后从 **0** 开始的下标；“原始输入位置”是输入 JSON 数组的 **0** 基下标
（界面与错误信息同时给出 1 基的“第 N 条记录”）。

**可配边条件**：

- 模帧号相同：`fill.id mod modulus === key.id mod modulus`
- 校正时差 `dt = key.t - fill.t - offset` 满足 `|dt| <= tolerance`（端点可配）

**顺序约束**：配对 `(fillSorted_i, keySorted_j)` 沿填充排序位置进行时，键排序位置严格递增
（一键最多一次、不可逆序）。

**规模上限**：可配候选对最多 **1,000,000**；枚举到第 1,000,001 对会立即中止并报错
（错误信息同时包含 `100 万 / 1000000 / 1,000,000` 与结构化 `details[0].limit`），该次结果不覆盖上一次成功结果。

### 算法与复杂度

候选按“余数分组 + 时间窗二分”生成，边按填充位置连续存放、同一填充内键位置升序。
在 `(i 严格增, j 严格增)` 的候选 DAG 上做后缀 DP，用反坐标 Fenwick 树维护
`(最大后继对数, 最小后继代价)`，再从左到右贪心选出能接出最优后缀的最小键位置，
正好实现第三级字典序（空位最大）。随机 3000 组小实例与全枚举结果完全一致。

复杂度约 `O((N + M) log … + E log M)`，`E` 为候选对数。
满额验收用例（两路各 180000、恰好 1,000,000 候选、180000 对全配）Node 核心求解约 **0.3–0.5 秒**，
无头浏览器内 `loadCase` 全流程约 **0.4–1 秒**，远低于 12 秒预算。

---

## 3. 完整配对表 schema

“下载完整配对表 JSON”导出的是**顶层数组**，每个**填充排序位置一行**（共 `fill.length` 行，顺序即填充排序位置）。
未配行的所有键字段与 `dt/abs_dt` 均为 JSON `null`。CSV 同名字段、UTF-8 BOM、`null` 导出为空字段。

| JSON 字段 | 含义 |
| --- | --- |
| `fill_sorted_position` | 填充排序位置（0 基，等于行下标） |
| `fill_original_position` | 填充侧原始输入位置（JSON 数组 0 基下标） |
| `fill_record_number` | 填充记录 1 基序号（= 原始位置+1） |
| `fill_t`,`fill_id`,`fill_image` | 该填充记录的字段 |
| `key_sorted_position` | 键排序位置（0 基）；未配为 `null` |
| `key_original_position` | 键侧原始输入位置（0 基）；未配为 `null` |
| `key_record_number` | 键记录 1 基序号；未配为 `null` |
| `key_t`,`key_id`,`key_image` | 键记录字段；未配为 `null` |
| `dt` | 带符号校正时差 `key.t - fill.t - offset`；未配 `null` |
| `abs_dt` | `|dt|`；未配 `null` |
| `paired` | 布尔，是否已配 |

界面帧详情、表格与下载文件全部来自同一个结果对象，因此跳到任一填充帧看到的
“两侧原始位置 / 键排序位置 / 带符号 dt”与下载表完全一致。

---

## 4. 合成与导出

设填充通道码值 `c`、灰度键码值（即 alpha）`a`：

- **straight 直通**：`RGBA = (c_R, c_G, c_B, a)`，任何 `a`（含 0）都保留源 RGB。
- **premult 预乘**：
  - `a > 0`：每色 `clamp(round_half_to_even(255*c/a), 0, 255)`。用精确整数有理比较实现“正中取偶”，避免浮点误差：
    `255/6 = 42.5 → 42`，`255/2 = 127.5 → 128`。
  - `a = 0`：RGB 清空为 0，`A = 0`。
- **缺键/未配填充帧**：整张 `RGBA` 全为 `0`（透明黑）。

导出：

- **当前帧 PNG**：真实 `image/png`，文件名 `<fill_sorted_position>.png`（如 `0.png`），RGBA 8-bit。
- **区间 PNG**：起点含、终点不含（左闭右开 `[start, end)`），帧数 `end-start` 必须 `1..120`；
  导出一个 `png-sequence.zip`，内含 `<fill_sorted_position>.png`（即 `start.png … end-1.png`）。超过 120 帧会被拒绝并提示。
- **配对表**：`pairing-table.json`（顶层数组）/ `pairing-table.csv`。
- PNG 由 `src/codec.js` 自行编码（IHDR/IDAT/IEND + CRC32，deflate 用浏览器 `CompressionStream('deflate')`），
  ZIP 由 `src/zip.js` 以 STORE 打包；样例 zip 读取支持 STORE/DEFLATE（`DecompressionStream('deflate-raw')`）。

---

## 5. 错误定位与“失败保留上次结果”

- 图像引用找不到 / 无法解码 / 尺寸不符：错误面板与 `window.genlock.getState().error.details`
  给出每条问题的 `{ channel: 'fill'|'key', inputPosition(0基), recordNumber(1基), image, reason }`，
  错误首句同时写出“第 N 条记录（原始输入位置 P）”与路径。
- 候选对超过 100 万、参数越界、JSON 非法等同理：本次提交/重算失败，**不会覆盖**
  `window.genlock.getTable()` / 页面表格 / 下载按钮所对应的上一次成功结果，顶部出现保留旧参数的提示条。
- 只有“校验记录 → 定位解码图像 → 求解”全部成功后才会替换 `lastSuccess`。

---

## 6. 页面选择器与程序化接口

常用稳定钩子（`id` 与 `data-testid` 同名）：

`#fileInput`（`input[type=file][multiple]`，接受 `.zip,.json,.ppm,.pgm,.png,...`）、
`#folderInput`、`#loadSampleBtn`、`#solveBtn`、`#offsetInput`、`#toleranceInput`、`#modeSelect`、
`#status`、`#errorPanel` / `#errorList`、`#staleBanner`、
`#pairCount`、`#totalAbsDt`、`#sumCandidates`、
`#frameJump`、`#jumpBtn`、`#prevFrame`、`#nextFrame`、`#frameSlider`、`#frameDetail`、`#previewCanvas`、
`#downloadPngBtn`、`#rangeStart`、`#rangeEnd`、`#downloadRangeBtn`、
`#downloadTableJson`、`#downloadTableCsv`、`#filterSelect`、`#pairTableBody`、`#pageInfo`。

页面还暴露：

```js
window.GKEngine   // 纯算法 UMD：validateProject / analyze / tableToCSV / GenlockError / MAX_CANDIDATES ...
window.GKCodec    // parsePNM / compositeFrame / unpremultiplyExact / encodePNG ...
window.GKZip      // unzip / zipSync
window.genlock = {
  version, constants,
  getState(),       // { busy, revision, hasResult, error:{message,details}, params, summary, frame }
  getSummary(),     // 含 pair_count / total_abs_dt / candidate_count / offset / tolerance ...
  getTable(),       // 完整配对表数组（同下载 JSON）；无成功结果时 null
  getResult(),      // { summary, rows }
  showFrame(i),
  compositeRGBA(i, mode?),          // Uint8ClampedArray(w*h*4)
  currentPNGBytes(),                // Promise<Uint8Array>
  async loadCase({ project, images?, files?, offset?, tolerance?, mode? })
  // images: { 'fill.ppm': Uint8Array | ArrayBuffer | number[] | base64 | dataURL }
}
```

`revision` 在每次成功求解后 +1，可供自动化确定性等待新结果，避免读到旧状态。

在 Node 中可直接 `require('./src/engine.js')`（UMD）做算法校验，无需浏览器、无需图像：

```js
const E = require('./src/engine.js');
const result = E.analyze(projectJson, { offset: 2, tolerance: 1 });
result.rows; result.summary;
```

---

## 7. 测试

```bash
npm test
# = node tests/engine.test.js   定点验收场景 + 3000 组对全枚举差分
# + node tests/codec.test.js    半偶舍入/straight/premult/未配/PNG 结构
# + node tests/perf.test.js     满额18万×2、恰好100万候选、超时预算、超限快速失败

npm run test:browser
# Playwright 端到端：zip 上传、两次改参求解、跳帧、JSON/CSV/PNG/ZIP 下载、
# 42/128 像素、坏引用定位且保留旧结果、候选超限保留、浏览器内满额计时。
# 可用 PLAYWRIGHT_PATH / PW_EXE 环境变量指定 playwright 与 chromium 可执行文件。
```

下载的 PNG/ZIP 可用任意 PNG 解码器（如 Python Pillow）核对 RGBA 码值。

## 目录

```
index.html            页面
src/engine.js         校验/排序/候选/Fenwick DP/字典序重建/配对表（UMD，纯逻辑）
src/codec.js          PPM/PGM、合成规则、PNG 编码（UMD）
src/zip.js            zip 读取与 STORE 写入（UMD）
src/app.js            DOM 状态机、分页表、帧检查器、下载、window.genlock
src/styles.css
tools/serve.js        零依赖静态服务器
tests/                Node 单测/性能 + Playwright 冒烟
sample/               样例 zip 的解压副本（供“载入内置样例”fetch）
samples/              原始分发 zip 与约定
```
