# Matrix Room Convolver · 立体声房间响应试配

把**四条单声道脉冲响应**（LL、LR、RL、RR）当作一个 2×2 矩阵，对双声道干声做
立体声卷积。首字母是**输出**通道，次字母是**输入**通道：

```
wetL = LL * inL + LR * inR      ← LR 是右串到左
wetR = RL * inL + RR * inR      ← RL 是左串到右
```

左右串音因此作为一条完整卷积参与运算，而不是两条互不相干的混响。四条 IR 可以
长度不同，输出长度仍按统一规则固定。

## 混音与长度

```
yL[t] = (1 − w)·dryL[t] + w·wetL[t − P]
yR[t] = (1 − w)·dryR[t] + w·wetR[t − P]
```

- `w` ∈ [0, 1]：湿声比例。`w = 0` 为仅干声，`w = 1` 为仅矩阵卷积；**不自动归一化**。
- `P`：预延迟，0–200 ms，界面按**整数采样帧**输入（48 kHz 下 0–9,600 帧），
  直接进入索引，不做小数插值或重采样。**只作用于湿声**。
- 固定长度：`N = 干声帧数 + 最长 IR 帧数 − 1 + 预延迟帧数`。
  - 缺失的干声按零补齐；
  - 即使 `w = 0` 也按 `N` 输出，尾段（最长 IR − 1 + 预延迟）不会截掉；
  - `N` 与 `w` 无关，改变 `w` 不会改变输出长度。

## 输入格式

| 文件 | 要求 |
|---|---|
| 干声 | 双声道（可缺失，按零处理） |
| LL / LR / RL / RR | 各一个单声道 WAV，文件名即路由名 |

- PCM 16-bit 或 24-bit，采样率 44.1 kHz 或 48 kHz。
- **所有文件采样率必须一致**；不一致时页面逐一点名文件与其采样率，并拒绝计算。
- 限制：干声 ≤ 60 秒，每条 IR ≤ 4 秒。
- 位深/声道/时长超限也逐文件报错。
- 拖入多个文件时按文件名归类：`LL.wav`、`take_LR.wav`、`foo-RR.wav` 均可识别，
  其余视为干声。

## 功能

- **路由矩阵**：四格显示 `LL/LR/RL/RR`、输出←输入方向、串音标记、每格长度/峰值。
- **波形**：干声、四条 IR、处理后输出（L 向上 / R 向下镜像）；输出波形标出干声结束
  与尾段起点，悬停显示时间/帧号/包络值。
- **长度明细**：干声、最长 IR、预延迟、尾长、输出总长（帧与毫秒）。
- **试听**：处理前（干声）、处理后（完整输出含尾段，按段流式取回）；切换参数会停止播放。
- **导出**：24-bit PCM WAV，报告量化前峰值、双声道超限样本数（|x| > 1）和导出时限幅
  样本数。**限幅只发生在写 WAV 时**，处理与试听路径不归一化、不限幅。
- **进度与取消**：计算在 Worker 中分块进行，页面全程可操作；可随时取消。
- **竞态保护**：任何参数/文件变化都会使旧任务失效，旧结果不可能覆盖新结果。

## 启动（WSL / Linux）

```bash
./scripts/start.sh            # 默认 8000，可传端口
# 或
python3 -I src/py/server.py --port 8000
```

打开 <http://localhost:8000/>。纯标准库，无 CDN、无外部依赖、离线可用。
首次启动会把 `samples/matrix-room.zip` 解压到 `samples/extracted/`（不可信数据，
只读使用，不执行）。

## 自检

```bash
./scripts/selfcheck.sh          # Python 交叉核对 + Node 单元测试
./scripts/selfcheck.sh --e2e    # 另加 Playwright 端到端
```

- `tests/crosscheck.py`：独立的 Python 朴素卷积参考实现，逐点核对 `cases.json`。
- `tests/node_check.mjs`：WAV 解析/拒绝路径/导出、校验、固定长度、FFT 与朴素卷积
  一致性、分块渲染一致性、超限统计、路由方向等 62 项。
- `tests/e2e_check.mjs`：浏览器端到端（样例、导出字节、超限、长任务进度/取消/竞态、
  采样率不一致点名、缺干声、w=0 长度、200 ms 预延迟）。

样例参考值（`samples/matrix-room.zip` 的 `cases.json`）：

| 样例 | 核对点 |
|---|---|
| sparse | 5,160 帧；峰值 0.24375；L/R 逐点（16/12 个非零点） |
| clip | 4,099 帧；峰值 3.375；超限 8,198 样本（双声道合计） |
| long | 3,071,999 帧（60 s 干声 + 4 s IR） |
| rate441 | 全部 44.1 kHz |
| zero | 零 IR + 静音干声；输出全零但长度保持 |

## 目录结构

```
src/py/server.py            本地静态服务 + 样例 API（路径白名单，防目录穿越）
src/web/index.html          页面与样式（暗色，无外部资源）
src/web/js/app.js           主线程：导入、校验、参数、波形、试听、导出、竞态
src/web/js/conv-worker.js   Worker：分块卷积、峰值/超限统计、分段渲染、WAV 编码
src/web/js/job-runner.js    Worker 任务调度与取消
src/web/js/wav.js           WAV 解析（16/24-bit PCM）与 24-bit 编码
src/web/js/validate.js      导入校验、固定长度、格式化
src/web/js/waves.js         Canvas 波形绘制
src/web/js/player.js        Web Audio 播放（处理前 / 处理后流式）
src/web/js/dsp/fft.js       迭代 radix-2 FFT
src/web/js/dsp/convolver.js overlap-save 矩阵卷积核心
src/web/js/dsp/render-range.js  按帧范围渲染（试听分段）
tests/                      Python 参考、Node 单元、浏览器端到端
scripts/start.sh            启动
scripts/selfcheck.sh        一键自检
```

## 实现说明

- 卷积采用 overlap-save 分块 FFT：块长取 ≥ 最长 IR 的 2 的幂，FFT 尺寸为 2 倍块长。
  四条 IR 的频谱只算一次；每个块用 4 次频域乘加得到两路湿声，再做 2 次逆变换。
  60 s 干声 + 4 s IR 的最坏情况在 4 核 CPU 上约 2–3 s。
- 干声与湿声在时域按 `(1−w)`/`w` 相加，湿声整体延后 `P` 帧；不做任何归一化。
- 超限统计与波形包络在整段卷积完成后统一扫描（湿声被预延迟平移，不能按块范围扫描）。
- 试听按 4 秒片段从 Worker 取回并排队播放，避免一次把约 64 秒双声道压到主线程。
- 导出时的限幅只作用于写出的 24-bit 量化值；处理数组本身保持不变。

## 安全

- 样例 ZIP 视为不可信数据：解压到独立目录，仅作为静态文件提供，不执行其中任何内容。
- Python 以 `-I` 隔离模式运行；样例路径经白名单校验，拒绝 `..` 与隐藏路径。
- 页面零外部请求，所有计算在本地浏览器完成。
