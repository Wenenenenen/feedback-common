# 光学声轨拼接台（optical-soundtrack-stitcher）

从扫描胶片条 JSON 恢复双声道声音的**纯静态网页**：无需构建、无联网依赖，
直接用浏览器打开 `index.html` 即可（`file://` 下自动使用内嵌样例
`sample-data.js`），也可以 `python3 -m http.server` 后访问。

输出 **48 kHz / 双声道 / 16 位 PCM**，最长 60 秒（2,880,000 帧）。
支持最多 64 条条带、累计 30 万行；满额数据在四核 8GB 上渲染约 0.4–0.6 s
（Node 与 Chromium 实测，见下文性能）。

---

## 1. 运行

```bash
# 方式 A：直接双击 / 浏览器打开 index.html（file:// 也可，样例已内嵌）

# 方式 B：静态服务器（此时会 fetch samples/optical-strips.json）
python3 -m http.server 8080     # 然后打开 http://localhost:8080/
# 或 npm start
```

页面打开后会自动载入样例；也可以点 **「选择 optical-strips.json」**、
拖入 JSON，或点 **「载入内置样例」**。

---

## 2. 数据格式（与 `samples/optical-strips.json` 一致）

```jsonc
{
  "frames": 84,                 // 输出帧数；缺省时按最大条带末端 / 960 推导
  "strips": [
    {
      "id": 1,                  // 编号：重叠时编号最小者优先
      "start": 0,               // 整数起点（刻，允许为负）
      "step": 720,              // 正整数行宽（刻/行）；别名 width/rowWidth
      "rows": [
        [ [18, 214, [50,55,59,64]], [22, 227, [60,61,63,68]] ],
        // 每行 = [左声道, 右声道]
      ]
    }
  ]
}
```

一个声道为 `[darkRef, brightRef, [亮度值 ×1..32]]`，也接受
`{dark, bright, values}` 对象形态。整体或声道可以写 `null`。

### 行样本解码（逐声道、逐行）

1. 任一部分缺失（声道为 `null`、参考值为 `null`、亮度数组缺失/为空、
   **任一亮度值为 `null`/非有限数**），或 `bright ≤ dark`，该声道此行无效。
2. 每个像素自行归一并夹取：
   `x = clamp((p − dark) / (bright − dark), 0, 1)`。
3. 对夹取后的像素求算术平均 `mean`。
4. `v = mean * 65536 − 32768`。
5. **就近取整，正好半档取偶数**（round half to even）。
6. 夹到 16 位范围 `[−32768, 32767]`（所以全亮行最终是 `32767` 而不是 `32768`）。

### 时间与拼接模型

- 每个输出音频帧占 **960 刻**；帧 `f` 对应半开区间 `[960f, 960(f+1))`。
- 条带 `s` 的第 `i` 行（从 0 起）对应半开刻区间
  `[s.start + i·s.step, s.start + (i+1)·s.step)`。
- 重叠刻上**逐声道**选择 `id` 最小、且该行该声道**有效**的条带；
  小编号条带在某刻该声道无效时，继续让位给更大编号的有效条带。
- 帧混合按**实际相交刻数**加权：
  `frame = round_half_even( Σ rowSample · overlapTicks / 960 )`。
  没有有效覆盖的刻按 0 计入，但**分母仍然是 960**（不是实际覆盖刻数）。
  帧级除法用精确整数运算判半档（余数 ×2 == 960），不存在浮点歧义。

---

## 3. 网页功能

1. **载入**：文件选择 / 拖拽 / 内置样例；显示条带数、行数、帧数、时长、渲染耗时与告警。
2. **试听与裁区**：
   - 整轨播放 / 暂停 / 停止，双泳道波形 + 播放头。
   - 在波形上拖动选择半开帧区间 `[起, 止)`，或在输入框填帧号
     （输入即同步，可直接点「裁区试听」）。
   - **裁区试听与整轨严格一致**：全页只有一份 `result.pcm`（交错 `Int16Array`）；
     试听 `AudioBuffer` 的样本恒为
     `pcm.subarray(2a, 2b)` 各声道 `/32768` 的逐位副本，不经过重采样或二次量化。
3. **按帧核查**：输入帧号（或点波形），显示每声道
   - 覆盖刻数 `x / 960`、加权分子、最终 PCM；
   - 每个来源段的条带 `id`、行号、半开刻区间 `[start,end)`、刻数、行样本；
   - 按条带合计的刻数。
4. **导出**：
   - 整轨 WAV：RIFF / PCM16 / 48 kHz / 立体声；
   - 裁区 WAV：其 `data` 与整轨 WAV 的对应半开字节切片逐字节一致；
   - 双声道 / 仅左 / 仅右**半开缺口表 CSV**，以及缺口 JSON。
5. **缺口浏览**：逐声道列出 `[start_tick, end_tick)`、刻数、
   起止帧与帧内刻偏移；点击任意一条跳到对应帧核查。

### 缺口 CSV 列

```
channel, channel_index,
start_tick, end_tick, tick_count,
start_frame, start_tick_in_frame,
end_frame, end_tick_in_frame,
start_seconds, end_seconds
```

区间为半开 `[start_tick, end_tick)`；`end_frame = floor(end_tick/960)`，
故恰好在帧边界结束的缺口会写成例如 `end_frame=84,end_tick_in_frame=0`。
刻与秒的关系是 `秒 = tick / (48000*960)`。

---

## 4. 编程接口（自动化 / Node）

核心是 UMD 文件 **`optical-core.js`**，浏览器挂到 `window.OpticalStitcher`，
Node 可 `require('./optical-core.js')`；ESM 既可
`import { renderStrips } from './optical-core.mjs'`，
也可直接 `import { renderStrips } from './optical-core.js'`
（已加 cjs-module-lexer 具名锚点）。

```js
const O = require('./optical-core.js');

const result = O.renderStrips(json);   // 或传 JSON 文本
result.frameCount;                     // 帧数（已夹到 2,880,000）
result.pcm;                            // Int16Array，交错 L,R,L,R,...
result.coverage.left;                  // Uint16Array(F)，0..960
result.coverage.right;
result.gapTicks.left;                  // 扁平 [s0,e0,s1,e1,...]
result.gapCount;                       // {left:n, right:m}

result.inspectFrame(43);
// { frame, tickStart, tickEnd, sample:{left,right},
//   numerator:{left,right}, coverage:{left,right},
//   left:  { coverageTicks, sources:[{stripId,ticks}], runs:[{startTick,endTick,ticks,stripId,rowIndex,value}] },
//   right: { ... } }

result.getGaps('left');                // [[start,end], ...]
result.pcmSlice(a, b);                 // Int16 半开帧切片（交错）
result.toFloatChannels(a, b);          // {left:Float32,right:Float32,sampleRate}

O.encodeWavPcm(result.pcm, { frames: result.frameCount }); // Uint8Array WAV
O.gapsToCsv(result, 'both');           // 'left' | 'right' | 'both'
O.gapsToJson(result);
O.analyzeChannel([1, 3, [0, 2, 3]]);   // {valid,normalized:[0,.5,1],mean,sample:0,...}
O.roundHalfEven(2.5);                  // 2
O.divRoundHalfEven(15728160, 960);     // 16384（16383.5 取偶）
```

浏览器页面额外暴露 `window.OpticalStitcherApp`：

```js
OpticalStitcherApp.render(json, name);          // 等价于选文件并刷新 UI
OpticalStitcherApp.getResult();
OpticalStitcherApp.inspectFrame(f);
OpticalStitcherApp.audition(a, b);
// 构造并尝试播放裁区；返回
// {startFrame,endFrame,sampleRate,pcm:Int16,left:Float32,right:Float32,buffer}
// 其中 left/right 与整轨 result.pcm 的 /32768 切片逐位相等，buffer 是实际送入 WebAudio 的缓冲。
OpticalStitcherApp.getLastAudition();
OpticalStitcherApp.wavBytes(a, b);              // 不传 a,b 即整轨
OpticalStitcherApp.gapsCsv('both');
OpticalStitcherApp.fixtures.overlapPriority();  // 验收点3构造
OpticalStitcherApp.fixtures.halfCoverageGap();  // 验收点4构造
```

---

## 5. 与验收点对应的已知数值

- `analyzeChannel([1,3,[0,2,3]])`：归一 `[0, 0.5, 1]`，样本 **`0`**。
- 右声道像素全等于亮参考：样本 **`32767`**（`32768` 被夹回）。
- 验收点 3 构造（`fixtures.overlapPriority()`）：
  - `#2` 覆盖 `[0,960)`，两声道归一 0.25（−16384）；
  - `#1` 覆盖 `[240,720)`，左 0.75（+16384），右参考相等无效；
  - 帧 0：**L=0，R=−16384**；右来源恒为 `#2 960 刻`；
    左来源段顺序 `#2[0,240)`、`#1[240,720)`、`#2[720,960)`，各 240/480/240 刻。
- 验收点 4 构造（`fixtures.halfCoverageGap()`）：
  - 满亮左行覆盖 `[480,960)` → 帧 0 **L=16384、覆盖 480**
    （`32767*480/960 = 16383.5` 半档取偶到 16384）；
  - 右为 `null` → **R=0、覆盖 0**；
  - 缺口：左 `[[0,480)]`，右 `[[0,960)]`。

---

## 6. 测试与命令行渲染

```bash
npm test            # 293 项：验收数值 + 60 组随机数据 vs 逐 tick 暴力模型 + WAV/切片
npm run test:oracle # 40 组随机数据 vs 独立 Python 参考实现（需 python3），280 项对照
npm run perf        # 64 条 / 30 万行 / 288 万帧的满额 Node 渲染与导出计时
npm run test:e2e    # Playwright/Chromium 真实页面验收（用全局 playwright）

# 不打开网页，直接把任意夹具渲染成 WAV + 缺口 CSV：
node cli/render.mjs path/to/case.json out.wav gaps.csv
```

- `test/core-test.mjs`：每条验收点的精确断言；随机用例用独立的逐刻暴力扫描
  对照 PCM、覆盖刻数、缺口、`inspectFrame` 来源。
- `test/reference_oracle.py` + `test/oracle-test.mjs`：完全独立的 Python 参考实现，
  端到端逐样本 / 缺口 / 来源字节级一致；另对 20 万个随机声道做过行样本 fuzz，零差异。
- `test/perf.mjs`：满额数据渲染约 0.5 s（Node 22，普通笔记本）。
- `test/e2e-test.cjs`：file:// 打开、自动载样例、页面内跑验收点、
  裁区 AudioBuffer 逐位核对、下载 WAV/CSV 校验、帧核查、无 console/page 错误。

### 性能做法

不逐刻遍历（满额时约 27.6 亿刻）。收集全部行边界为压缩坐标（约 30 万个），
相邻坐标间每条条带的活动行恒定；每段按 `id` 顺序（≤64 条）选首个有效声道，
再把常量样本按与 960 刻帧的实际相交长度累加。段在时间线上互不重叠，
帧分配总迭代量为 O(帧数 + 行数)。最后 O(帧数) 做精确整数除法取偶。

## 文件

| 文件 | 说明 |
| --- | --- |
| `index.html` / `css/app.css` / `app.js` | 页面、交互、播放、波形、下载 |
| `optical-core.js` | UMD 同构纯算法核心（浏览器全局 / Node require / ESM 具名导入） |
| `optical-core.mjs` | ESM 具名转发入口 |
| `sample-data.js` | 由样例 JSON 生成的内嵌副本，供 file:// 自动载入 |
| `samples/optical-strips.json` | 题目样例（2 条轻度重叠条带，84 帧） |
| `test/` | 正确性、Python oracle、性能、Playwright e2e |
