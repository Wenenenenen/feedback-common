# 移动声源耳机校音（HRIR 延时场）

纯静态网页：导入 48 kHz 单声道 PCM16 录音与方位轨迹，按耳响应库（HRIR）做时变插值渲染，
解决移动声源换向时的声像跳变问题，并保留剪辑点之前的完整混响尾声。

## 运行

无需构建。从仓库根目录启动任意静态服务后打开 `index.html`：

```bash
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

打开后点「载入示例工程」即可渲染 `samples/hrir-delay-cases.zip` 中的样例。

## 功能

- 最多 4 条声源（每条 ≤30 s、轨迹 ≤20000 点），耳响应库 ≤16 方位、每耳 ≤512 抽头。
- 轨迹角度保留圈数（int32，可负），段内线性插值后取模，循环相邻方向求线性权重，精确命中权重为 1。
- 每个发声帧按当时方位对两耳滤波器逐抽头、每耳延时（1/256 采样单位）分别插值；
  非整数延时把贡献线性分摊到相邻两个输出帧，整数延时只写一帧。
- 全部声源与响应尾声在 float64 域混完后才做「最接近偶数」舍入并限幅到 PCM16；
  工程总长 = 最长源帧数 + L + 255，独听同长。
- 每条声源独立渲染缓冲：编辑轨迹只重算该声源，其他声源结果逐字节不变。
- 发声帧查看器：任一发声帧的循环邻点、权重、两耳延时（整数 + 小数部分）。
- 独听 / 合听 / 选区试听；按帧选区（左闭右开）导出双声道 WAV，
  选区与整轨对应区间逐码一致（同一渲染结果切片，不单独重算）。
- 满额工程（4×30 s、16 方位、512 抽头、2 万轨迹点）渲染到可播放约 5 秒（12 核），
  远低于 20 秒预算；计算中可取消，取消后保留上次结果。

## 文件

| 文件 | 说明 |
| --- | --- |
| `render-core.js` | 核心：方向查找、时变渲染、量化、WAV 编解码、工程校验（页面 / Worker / Node 三端通用） |
| `worker.js` | 渲染 Worker（每条「声源 × 耳」一个任务，Transferable 回传） |
| `app.js` / `index.html` / `style.css` | 页面与交互 |
| `test/reference.py` | 严格按 `约定.txt` 独立编写的 Python 参考实现（对拍用） |
| `test/render-project.js` | 用 JS 核心渲染工程目录输出 WAV |
| `test/gen-random.js` | 随机工程生成器（多圈角度、负角度、分数延时） |
| `test/e2e.js` | Playwright 端到端测试 |
| `test/perf.js` | 满额工程浏览器渲染计时 |

## 测试

```bash
# 对拍：JS 核心 vs Python 参考（须逐码一致）
node test/gen-random.js /tmp/hrir-test/rand1 4 2 16 512 2000 777
python3 -I test/reference.py /tmp/hrir-test/rand1 /tmp/hrir-test/ref.wav
node test/render-project.js /tmp/hrir-test/rand1 /tmp/hrir-test/js.wav
cmp /tmp/hrir-test/ref.wav /tmp/hrir-test/js.wav

# 端到端（需全局 playwright 与 chromium）
NODE_PATH=$(npm root -g) node test/e2e.js

# 满额性能
node test/gen-random.js /tmp/hrir-test/full 4 30 16 512 20000 42
NODE_PATH=$(npm root -g) node test/perf.js
```

## 工程文件格式

```json
{
  "bank": {
    "angles": [0, 9000, 18000, 27000],
    "left": [[12000, 6000, 0], "…每方位 L 个 Q15 抽头…"],
    "right": ["…同左…"],
    "left_delay": [0, 480, 256, 32],
    "right_delay": [0, 32, 256, 480]
  },
  "sources": [
    { "wav": "dry.wav", "track": [[0, 30000], [2400, 36000], [4799, 45000]] }
  ]
}
```

角度单位百分之一度（0..35999 为库方位；轨迹角为有符号 int32，可含圈数）；
延时单位 1/256 采样（0..65536）；抽头为有符号 Q15；录音可在多个声源间重复引用。
