# 事件快门校片台 · Event Exposure Reel（EVL1 → LUM1）

展品转动时同一像素在一次曝光内被事件反复改变：直接堆事件会让静止区没有亮度，
而补过的锚图又常在切点冒出亮线。本页严格按 `samples/extracted/format.txt` 的 EVL1 约定，
用**锚点绝对对数亮度 + 事件阶跃 + 端点差额均摊**重建每条像素轨迹，
并对任意半开曝光窗 `[start,end)` 做**连续时间解析积分**（非固定时刻采样近似）。

原生 HTML/CSS/JS，零第三方运行时依赖；核心 `js/evl-core.js` 不依赖 DOM，
浏览器经典脚本与 Node（CJS/ESM-default）均可加载。

## 运行

```bash
npm start                 # 零依赖静态服务器 http://127.0.0.1:8151/
# 或任意静态服务器：python3 -m http.server 8151
```

也可以直接双击 `index.html`（`file://`）：核心与文件选择/拖放均可用；
仅自动 `fetch` 样例在 `file://` 下会被浏览器拦截，用「打开 EVL1 文件」选择
`examples/turntable.evl` 即可。

## 功能

- EVL1 严格顺序解析与校验；坏文件给出**首个坏字段的零基字节偏移**、字段名与原因，并保留上一次结果。
- 上限：512×384、12 锚、4,000,000 事件、24 曝光窗；事件按像素稳定计数排序。
- 逐像素重建：同刻极性先求和；锚同刻事件丢弃（锚图覆盖）；只计严格 `a<t<b` 的事件。
- 轨迹先夹 `[-24,8]` 再取 `2^L`；对夹断边界分段，指数线性段用 `expm1` 稳定积分。
- 缺锚：相邻锚两端齐全才有效；缺锚两侧段均无效、不跨越重连，只扣覆盖率。
- 预览：当前窗平均线性亮度 `clamp(v,0,1)→灰度`，可切覆盖率视图；点选/输入像素。
- 像素检查：夹紧后对数轨迹、锚、`+/-` 事件 rug、有效连续段/无效段 chips、当前窗底纹、悬停读数。
- 锚值编辑（合法码 `-6144..2048`，或 `-32768` 缺测）+ 撤销/重做（Ctrl/⌘+Z、Ctrl/⌘+Shift+Z）。
- 导出跟随当前版本：每窗一个 LUM1，或一键 ZIP；另有平面布局编码器备用。
- 计算分块让出主线程并显示进度；窗口重算有代数令牌，在途改锚按脏像素对账，旧结果不会覆盖新版本。

## 重建公式（与 format.txt 一致）

对像素 `p` 的每对相邻且两端有效的锚 `(a,b)`：

```
N    = Σ 区间(a,b) 内同刻合并后的极性
n(t) = Σ a<t_k≤t 的合并极性
L(t) = L_a + n(t)/8 + (L_b − L_a − N/8) · (t−a)/(b−a)   # 未夹紧
B(t) = 2^clamp(L(t), −24, 8)                            # 线性亮度
```

窗 `[s,e)` 与各有效连续段 `[T0,T1]` 求交 `[lo,hi]`：

```
coverage = Σ(hi−lo) / (e−s)
luminance = Σ ∫_lo^hi B(t)dt / Σ(hi−lo)
无有效时长：luminance = coverage = 0（写入 LUM1 的是精确 +0.0）
```

连续有效锚会拼成一个 run，段间接续点处轨迹连续（仅斜率变化）。
`∫2^(z+βx)dx = 2^z·expm1(β·ln2·d)/(β·ln2)`，对极小斜率/超短区间也无数值相消误差。

## LUM1 二进制布局（默认，交错）

```
偏移 0  "LUM1"                 4 ASCII
偏移 4  u16 LE width
偏移 6  u16 LE height
偏移 8  逐行逐像素，每像素两个 float32 LE：[线性亮度, 覆盖率]   # 交错
总长 = 8 + 8·w·h
```

勾选「备用平面布局」或调用 `EVLCore.encodeLUM1Planar` 可得到
`w·h` 个亮度 float32 后接 `w·h` 个覆盖率 float32 的平面版本。

## 编程接口

页面加载后暴露：

- `window.EVLCore`：`parseEVL(ArrayBuffer)`（抛 `EVLFormatError{offset,field}`）、
  `computeAll(data, windows)`、`computePixelInto(...)`、`encodeLUM1(result,i)`、
  `zipStore(files)`、`validateWindows(list)` 等。
- `window.EVReel`（应用句柄）：
  `loadBuffer(buf,name)`、`openFile(url)`、`whenIdle()`、
  `setWindows([[s,e],…])`、`getWindows()`、`setActiveWindow(i)`、`setLayer('lum'|'cov')`、
  `selectPixel(xOrIndex,y?)`、`setAnchorCode(a,code|null)`、`undo()/redo()`、
  `getPixelValues(p?)`、`buildLUM1(i)`、`buildAllZip()`、`getResult()`、`getData()`、
  `getLastError()`、`getState()`。

Node 中：`const C = require('./js/evl-core.js')`（或 ESM `import C from './js/evl-core.js'`）。

## 自测与性能

```bash
python3 -I tools/gen_oracle.py     # 独立 Python 参考实现生成 71 随机用例 + 31 坏文件偏移预言
node tools/test.mjs                # JS 核心 vs Python：730 项，亮度最坏 rel ~5e-16
python3 -I tools/dense_check.py     # 4e6 点密集中点采样独立验证解析积分
node tools/perf.mjs uniform        # 满额文件生成 + 计时（Node）
node tools/browser-smoke.mjs        # Playwright 全流程/导出字节/坏偏移/竞态/浏览器性能
node tools/shots.mjs               # 截图到 .smoke-shots/
```

参考机结果：512×384 / 12 锚 / 4,000,000 事件解析+按像素分组约 0.15–0.2 s，
24 窗全像素计算约 1.6–2.4 s（Node 与无头 Chromium 同量级），合计远低于 12 s。

## 目录

```
index.html / styles.css      页面
js/evl-core.js               解析、重建、积分、LUM1/ZIP（UMD，无 DOM 依赖）
js/app.js                    UI、SVG 图表、撤销、导出、window.EVReel
examples/                    随包 turntable.evl + shutters.json
samples/extracted/           题目原始素材与 format.txt
tools/ref_impl.py            独立 Python 参考实现（预言机）
tools/gen_oracle.py          随机用例/坏文件生成
tools/test.mjs               跨语言数值与偏移测试
tools/dense_check.py         密集采样交叉验证
tools/perf.mjs               满额性能/体积
tools/browser-smoke.mjs      Playwright e2e
tools/serve.mjs              零依赖静态服务器
```
