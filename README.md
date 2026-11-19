# 分包音频播放缓冲校验台

离线分析通话网关分包音频的网页工具：导入含到达时间、16 位序号、32 位时间戳和 PCM 载荷的
JSON，按固定缓冲延迟逐包判定接收 / 重复 / 迟到 / 无效，标出每个播放槽实际使用的包，
对丢包做补零或衰减重复补偿，并联动展示时间线、波形与试听，导出精确长度的 PCM WAV 和
逐包、逐槽判定 JSON。全部缓冲决策与补偿逻辑在本仓库内实现，无第三方运行时依赖。

## 直接使用

用任意静态服务器打开（ES Module 不能用 `file://` 直接加载）：

```bash
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/
```

页面首屏自带一份内置演示数据（含乱序、重复、迟到、两类坏包和序号/时间戳回绕），
也可以拖入符合约定的真实抓包 JSON。

## 判定规则（与 samples 内约定.txt 一致）

- 槽位 `k = (seq - anchor_seq) mod 65536`，必须 `< total_packets`，否则坏包。
- `timestamp` 必须等于 `(anchor_ts + 480*k) mod 2^32`；PCM 必须恰为
  `480 × channels × 2` 字节的 int16 小端；任一项不符记 `invalid`，坏包不占槽。
- 包先按 `(arrival_us, 输入索引)` 稳定排序。合法包若槽已被占记 `duplicate`；
  否则先占槽，再按
  `arrival_us <= origin_us + delay_ms*1000 + 10000*k` 判 `accepted` / `late`。
  **恰好等于截止时间也接收**（含等号）。
- 播放只使用 `accepted` 包。未被接收的槽位补偿：
  - `zero`：补零；开头尚无正常包时也补零。
  - `repeat_decay`：以最后一个正常播放包为基准，连续缺失第 r 个槽乘 `0.8^r`，
    逐样本对绝对值四舍五入、保留符号（JS 用 `Math.round`，即半值向上取整）。
    正常包会把 r 重置为 0。
- 迟到包只占序号槽、不进播放，**不会改写已经播放的内容**；开头和结尾的缺失槽保留不移除。

## 文件结构

| 路径 | 作用 |
|---|---|
| `index.html` | 页面结构、设计 token（明暗双主题）、响应式布局 |
| `js/engine.js` | 核心：校验、排序、逐包判定、逐槽补偿（无 DOM 依赖，可独立 import） |
| `js/charts.js` | Canvas 图表：抖动散点（含截止阶梯线）、播放槽条带、波形（补偿段着色、播放头） |
| `js/wav.js` | int16 PCM → 精确长度 RIFF/WAVE 封装 |
| `js/demo.js` | 内置演示数据生成器 |
| `js/app.js` | 页面主逻辑：导入、参数联动重算、试听、分页表格、导出、拖拽 |
| `tools/reference.py` | 同一规则的 Python 参考实现 |
| `tools/selfcheck.py` | Python 实现对样例 `*-expected.json` 的 sha256/状态/槽位自检 |
| `tools/node-test.mjs` | JS 引擎对样例期望的全量比对（8 个延迟×策略场景） |
| `tools/browser-smoke.mjs` | Playwright 冒烟：渲染、联动、浏览器内 sha、WAV/JSON 导出结构 |
| `tools/interaction-test.mjs` | Playwright 交互：试听播放头、手机宽度无横向溢出 |

## 测试

```bash
python3 -I tools/selfcheck.py     # Python 参考实现 vs 样例期望（8 场景全 OK）
node tools/node-test.mjs          # 网页引擎 vs 同一份期望（sha256 逐字节一致）
node tools/browser-smoke.mjs      # 需要本机已装 Playwright（全局 npm 包路径写在脚本内）
node tools/interaction-test.mjs
```

## 导出格式

- WAV：PCM s16le，48kHz，声道数与输入一致；data 段长度
  `total_packets × 480 × channels × 2`，文件总长固定再加 44 字节头。
- 判定 JSON：`delay_ms`、`policy`、`packets`（id → 状态，与样例 expected 同构）、
  `packet_details`（每包含输入索引、到达时间、seq、槽位、截止时间、状态、中文原因）、
  `slots`（每槽 `slot` / `deadline_us` / `source` / `status` / `conceal`）。
