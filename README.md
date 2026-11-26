# PDM 多麦原始录音抽取校验台 · PDQ1 Reel

一个**纯前端、零运行时依赖**的多麦克风原始录音抽取 / 校验网页。读入 `PDQ1`（见 `samples/pdm-decimation-cases.zip` 与其中的 `约定.txt`），自行完成分包解析、u32 时标回绕、逐声道位流去交织、CRC32 校验、“坏包不覆盖好包 / 同时刻同声道最后一条好记录胜出”的重建、绝对相位奇偶补位、三级长度 D 滑动和抽取（48 kHz PCM16），并按滤波器**真实依赖区间**标记受缺位影响的输出帧。提供多轨波形时间线、单帧输入位与来源展开、整轨 / 选区试听、多声道 WAV 与受影响半开区间 JSON 导出、末尾截断记录偏移定位。

> 所有解析与计算都在本机浏览器完成，不上传任何文件。

## 打开方式

纯静态页面，无需构建、无需 `npm install`：

```bash
# 方式一：直接用浏览器打开（全部为经典脚本，file:// 也可，示例已内嵌）
open index.html

# 方式二：静态服务器（推荐，个别浏览器策略更宽松）
python3 -m http.server 8137
# 访问 http://127.0.0.1:8137/index.html
```

右上角可「选择 PDQ1 文件」、拖放文件，或点「载入内置示例」（内嵌的 `samples/demo.pdq`，演示时标回绕）。

## 支持规模与性能

设计目标：64 MiB 文件、120 000 条记录、4 声道、30 s、D=64 → 1 440 000 个 48 kHz 输出帧 / 声道。

满额最坏负载（约 63.97 MiB、120 000 条、4 路、D=64、92 160 000 tick，含约 30% 重传重叠）实测：

| 环节 | Chromium（Playwright headless，本机 WSL2） | Node 22 |
|---|---|---|
| CRC + 分包解析 | ~0.17 s | ~0.28 s |
| 4 路重建 + 三阶抽取 + 区间 | ~7.5 s | ~10.6 s |
| **选择文件 → PCM/区间可查看（含读文件/渲染）** | **约 8–10 s（≤ 20 s 预算）** | — |

复现：

```bash
node test/perf.js            # 生成 tmp/full-d64.pdq 并跑 Node 基准
node test/perf.js --assert   # 若 Node 解码 >20s 则退出码 1
NODE_PATH="$(npm root -g)" node test/browser-e2e.js   # 含真实浏览器 ≤20s 计时
```

内存策略：文件只保留一份 `ArrayBuffer`；声道网格为每声道一个 `Int8Array(totalTicks)`（`0=缺位`、`±1=真位`），逐声道构建 / 滤波后立即释放，峰值约数百 MB。

## 格式与处理规则（与 `约定.txt` 逐条对应）

- 小端。文件头 14 字节：`PDQ1`、u32 首时标 anchor、u32 总 tick、u8 声道数、u8 D（32 或 64）；总 tick 为 D 的正整数倍。
- 记录：u32 起始时标、u16 正 tick 数、u8 非零声道掩膜、`ceil(tick数 × popcount(mask) / 8)` 字节载荷、u32 IEEE CRC32。CRC 覆盖 7 字节记录头 + 载荷。
- 载荷按 **tick 优先、掩膜置位声道从低到高** 交织；每字节 **低位先行**，高位补零。
- 相对 tick `rel = (起始时标 − 首时标) mod 2³²`，正确处理 u32 回绕（demo：anchor=`0xfffffff0`，第二条 ts=169 → rel=185）。
- **CRC 坏 / 结构非法的记录整条不采用**，因此不会覆盖已有好数据；合法记录按文件顺序写入，同一 tick + 声道后写覆盖先写，等价于“最后一条好记录胜出”。
- 未被任何好记录覆盖的 tick 为缺位：按 `(首时标 + 相对tick)` 的奇偶补位，偶→位 0，奇→位 1（跨回绕保持绝对相位）。
- 真位 / 补位：0→−1，1→+1；相对 tick < 0（起点前）取数值 0，**不算缺位**。

### 三阶抽取与取整

三个长度 D、系数全 1 的移动和串联，用递推 `O(totalTicks)` 计算，绝不在记录 / 包界处重置：

```
s1[t] = s1[t-1] + x[t] - x[t-D]
s2[t] = s2[t-1] + s1[t] - s1[t-D]
s3[t] = s3[t-1] + s2[t] - s2[t-D]
输出帧 f（0 基）的抽取时刻 T = (f+1)D - 1，取 exactSum = s3[T]
PCM[f] = clamp16( roundHalfEven( exactSum * 32768 / D³ ) )
```

`roundHalfEven` 用整数运算实现“最近舍入、正中取偶”，避免浮点半值误差；随后限制到 `[-32768, 32767]`。D=32 时缩放恰好约掉（PCM=exactSum），D=64 时等价 `exactSum/8`（`.5` 处为偶舍入，真实存在）。

### 受影响帧与依赖区间

三级 D 矩形卷积的冲激支撑为 `0 … 3(D−1)`，故输出时刻 T 的真实依赖区间为含两端的

```
[T − 3(D−1), T]      // D=32 → 94 位；D=64 → 190 位
```

与“三个长度 D 移动和串联”的暴力三重循环核对一致。该区间与记录边界无关，跨包连续。区间内（实域 `t≥0`）只要有一个缺位，该声道该帧即标记受影响；`t<0` 的起点前零不触发。导出时把连续受影响帧合并为各声道**最大连续半开帧区间 `[startFrame,endFrame)`**。

### 末尾截断

按记录声明长度顺序走包。一旦剩余字节不足：

- 记录头不足 7 字节：`stage:"record-header"`；
- 记录体 / CRC 不足声明长度：`stage:"record-body"`（含 `need/have/payloadLength`）。

两种情况都记录并在页面顶部告警：**记录序号 `recordIndex` 与该记录起始字节偏移 `offset`（十进制 + `0x`）**，同时停止继续走包；此前所有完整且 CRC 合格的记录全部保留，PCM 与区间仍按文件头总 tick 计算（尾部无覆盖处自然落入补位 / 受影响）。精确停在记录边界不算截断。

## 时间线与单帧来源

- 每个声道一条 Canvas 轨：min/max 包络波形 + 顶部红色“受影响密度轨” + 时间轴；支持拖动选区、单击定位帧、滚轮 / 按钮缩放。
- 「单帧抽取核验」列出该帧依赖区间内全部输入位：
  - 芯片区分 **真位 / 缺位补位（琥珀斜纹）/ 起点前零**；
  - 每个 tick 的等效滤波系数 `w`、值 `x`、贡献 `w·x`，并重算三阶和与 PCM 自检；
  - 每个位的全部候选来源记录：字节偏移、候选位、CRC、以及「最终采用 · 末次好记录胜 / 有效但被后一条覆盖 / CRC 坏 · 不覆盖好包」。

## 试听与导出：选区 == 整轨切片

- 「播放整轨」直接消费交织 `Int16Array`；「播放选区」与选区 WAV 使用同一个 `interleaved.subarray(f0*C, f1*C)` 视图，送入 `AudioBuffer` 的采样与 WAV 数据逐样本同源。
- 导出 **48 kHz / 16 bit / `C` 声道** 标准 RIFF WAV（声道按 0..C-1 交织）。
- 自动化测试断言：选区 WAV 的 data 字节，与整轨 WAV data chunk 的 `[44 + f0*C*2, 44 + f1*C*2)` 字节**完全相等**。
- 影响区间 JSON（整轨或选区）。选区版裁剪区间但**保留绝对帧坐标与同一抽取相位**，不会从选区起点重新定相。Schema：

```jsonc
{
  "format": "pdm-decimation-reel/affected-intervals",
  "formatVersion": 1,
  "sampleRate": 48000, "frameRate": 48000,
  "decimation": 64, "channels": 4, "totalFrames": 1440000,
  "anchor": 4294967280,
  "scope": "full" | "selection",
  "selection": { "startFrame": 2, "endFrame": 8 }, // 仅选区
  "intervals": [[[3, 6]], [[3, 7]], ...],           // intervals[ch] = [[s,e), ...]
  "intervalsByChannel": [ /* 同上，显式别名 */ ],
  "channelIntervals": [ { "channel": 0, "count": 1,
      "intervals": [ { "startFrame": 3, "endFrame": 6, "frameCount": 3,
        "startSecond": 0.0000625, "endSecond": 0.000125, "durationMs": 0.0625 } ] } ]
}
```

帧号即 48 kHz 采样帧序号（每帧每声道一个 PCM 采样），秒 = 帧 / 48000。

## 测试

```bash
# 1) 纯 Node 内核测试：CRC 标准向量、偶舍入、demo 已知答案、截断偏移、
#    依赖几何、来源/winner、WAV 切片字节一致，以及 400 个随机刁钻用例
#    对独立 Python 参考实现的逐值比对（PCM/affected/intervals 全等）
node test/run.js

# 2) 重新生成夹具与 400 随机交叉验证向量（Python 参考实现）
python3 -I tools/gen_fixtures.py

# 3) 真实 Chromium 端到端：上传/点击/下载并解析 WAV+JSON、截断定位、
#    时间线点击、逐帧自检；若已用 `node test/perf.js` 生成 tmp/full-d64.pdq
#    则额外执行满额 ≤20s 计时，否则自动跳过这 2 项（不影响其余用例）
NODE_PATH="$(npm root -g)" node test/browser-e2e.js
```

当前结果（在本工作区，满额文件已生成）：`node test/run.js` 约 **5875 条断言全过**；`browser-e2e.js` **23 项全过**（含选区 WAV 与整轨切片字节一致、holes D64 的 PCM/区间与参考完全一致、截断 offset=296/record=5、满额 wall≈7.8–10 s）。全新克隆没有 64 MiB 的 `tmp/full-d64.pdq`（已 gitignore），此时 e2e 为 **21 项通过 + 满额 2 项跳过**；先跑 `node test/perf.js` 即补齐。

`tools/pdq_reference.py` 是只依据 `约定.txt` 写的**独立 Python 对照实现**（字面三级 boxcar + 暴力依赖扫描），可单独使用：

```bash
python3 -I tools/pdq_reference.py samples/demo.pdq /tmp/demo.json --pcm /tmp/demo.pcm
```

## 浏览器自动化接口

页面暴露 `window.PDMReel`，便于无 UI 脚本核对（UI 自身也全部走同一内核）：

```js
await PDMReel.loadArrayBuffer(name, arrayBuffer);
PDMReel.getResult();                 // 完整结果（channelData/interleaved/parsed...）
PDMReel.setSelection(2, 8);
PDMReel.inspectFrame(ch, frame);     // 该帧依赖位 + 来源 + 重算一致性
PDMReel.buildReport('full' | 'selection' | {startFrame,endFrame});
PDMReel.getFullWavBytes();           // ArrayBuffer(WAV)
PDMReel.getSelectionWavBytes();
PDMReel.getTimingMs();
```

关键稳定 DOM 钩子：`#file-input`、`#load-demo-btn`、`#workspace`、`#perf-time`、`#trunc-banner[data-offset][data-record-index]` / `#trunc-offset` / `#trunc-index`、`.lane canvas.wave`、`#inspect-channel`、`#inspect-frame`、`#inspect-btn`、`.bit-chip`、`#tick-detail`、`.iv-btn`、`#export-wav-full`、`#export-wav-sel`、`#export-json-full`、`#export-json-sel`。

## 目录

```
index.html            页面结构（稳定 id / 中文可见控件）
css/style.css         深色仪器风样式（声道色通过 CVD/对比度校验）
js/engine.js          纯内核 UMD：CRC、解析、重建、抽取、区间、来源、报告
js/wav.js             PCM16 WAV 编码 + 同源切片
js/audio.js           WebAudio 试听（消费同一 Int16 采样）
js/demo-data.js       demo.pdq 的 base64 内嵌（file:// 一键示例）
js/app.js             导入、分阶段解码、Canvas 时间线、检查器、导出、PDMReel API
tools/pdq_reference.py 独立 Python 参考实现 / CLI
tools/gen_fixtures.py  生成命名夹具 + 400 随机向量
test/run.js           Node 断言 + 跨实现逐值比对
test/browser-e2e.js    Playwright 真实操作 / 下载比对 / 满额计时
test/fixtures/        命名刁钻用例 .pdq + .expected.json
test/vectors/         随机交叉验证 manifest
samples/              题目 zip、解压后的 demo.pdq 与 约定.txt
```
