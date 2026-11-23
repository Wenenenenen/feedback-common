# 阵列逆滤波台

展厅扬声器阵列的逆滤波设计与核查台。导入测量包，按测点与节目通道求解每只扬声器的限幅 FIR，
逐样本核对目标 / 预测 / 残差，并导出经过独立复算的滤波器 JSON。

```
index.html                 页面（可直接用 file:// 打开，也可由本地 HTTP 服务托管）
src/core.js                数值核心：FFT、算子、主动集求解、校验、导出核定
src/report.js              求解 + 报告管线（Worker 与主线程共用）
src/inflate.js             ZIP 读写（含 deflate 解压与路径穿越防护）
src/chart.js               Canvas 折线图 / 多联小图 / 悬停读数
src/app.js                 界面逻辑
src/styles.css             视觉系统（浅色 / 深色）
src/worker-source.js       由 core.js + report.js 生成的 Worker 源码（自动生成）
tools/build-worker.mjs     生成 worker-source.js
tools/make-case.mjs        生成满规模 / 秩亏测试包
tests/                     单元、参考实现对拍与浏览器端到端测试
samples/array-inverse-cases.zip  示例测量包
```

## 运行

```bash
python3 -m http.server 8123     # 然后打开 http://localhost:8123/
```

直接双击 `index.html`（`file://`）也能用：求解跑在 Blob Worker 里。
此时"载入示例"按钮无法 fetch 本地文件，请用"导入"选择 ZIP。

```bash
npm test        # 全部测试（含 Chromium 端到端；无 Playwright 时自动跳过）
npm run serve   # 本地 HTTP 服务
```

## 问题形式

对每路节目通道 `q` 求实数滤波器 `F[p,q,k]`，使

```
E = Σ_m w_m · Σ_n | (Σ_p H[m,p] * F[p,q])[n] − T[m,q][n − delay] |²
    + λ · Σ_{p,k} F[p,q,k]²
```

其中卷积取完整线性卷积，`n` 取 `0 … N−1`，
`N = max(max(h_lengths) + taps − 1, delay + max(t_lengths))`，缺样填 0；
延迟后目标超出卷积末端的部分照常计入，因此它同样会拉低代价。
每个抽头被约束在 `[−G[p], G[p]]` 内。

实现上把它写成 `½ f'Bf − c'f`：`B = Σ_m w_m H_mᴴ H_m + λI` 是分块 Toeplitz
（每个频点一个 `P×P` Hermitian 矩阵），在 FFT 域里逐频点相乘；`c` 由互相关一次算得。
用 Cholesky 分解的循环预条件子加速 CG，外层是带回代检验的原始主动集（剪切 → 释放
梯度指向可行域内部的边界抽头）。FFT 长度取 `nextPow2(N)`，由环绕余量推出：逆变换的
非零支撑跨 `[−(maxH−1), N−1]`，而只读取 `0…taps−1`，所以 `L ≥ N` 即无混叠。

**合格性**由投影梯度定义：记 `g = Bf − c`（即 `∂E/∂f / 2`），要求

```
max_i | f_i − clip(f_i − g_i, −G_i, G_i) | ≤ 1e-7
```

求解器在最终打磨阶段按 `2e-9` 的目标收紧该残差；导出后被重新解码、重建算子并
逐抽头复算一次（`certifyExport`），复算值超过 `1e-7` 或任一抽头越界即拒绝发布。

## 交互

- **导入**：ZIP 根目录下的 `project.json` + `signals.f32`（另可含说明文件）。
  字段或样本非法时给出精确路径，例如 `project.json: weights[1]`、
  `signals.f32 → h[m=2][p=1][n=1]`（以扁平样本序号定位）。
- **参数**：测点权重、扬声器限值、λ、delay、taps 均可编辑；取值实时校验，
  加权能量 `Σ_m w_m Σ_p (Σ_n|h|)²` 超过 16 时禁止求解并指出是 `weights` 超限。
- **过期提示**：改动参数后显示"结果已过期"，可一键"恢复上次有效"参数。
- **取消 / 取代**：取消或被新求解取代的任务不会发布结果；最近一次有效解保持不变。
  求解在 Worker 中运行，界面不阻塞。
- **曲线核查**：按测点 × 节目查看目标 / 预测 / 残差，鼠标或方向键逐样本读数，
  也可用滑杆 / 输入框定位；下方表格给出该样本全部测点的数值。
- **滤波器**：按扬声器列出抽头包络（含 ±G 盒）、触界计数与分页明细。
- **报告与导出**：目标 E、加权残差、抽头正则、投影梯度、迭代统计、逐测点误差、
  各测点曲线小图；下载 `filters.json`（`sample_rate`、`taps`、`delay`、`lambda`、
  `objective`、`projected_residual`、`filters[扬声器][节目][抽头]`），或打印报告。

## 性能

满规模（8 测点 × 8 扬声器 × 2 节目，各 4096 点，N = 8191、FFT 长度 8192）在
4 核 CPU 上：求解 + 报告通常 2–3 秒，最难的窄带 / 高度相关算例约 4–10 秒，
远低于 25 秒预算。`tests/desk.test.mjs` 里有一条满规模用例守住这个预算。

## 数值验证

- `tests/core.test.mjs`：FFT 往返、算子 / 右端项 / 预测与稠密参考实现逐元素对拍、
  盒约束 QP 与稠密主动集解对比、投影梯度合格性。
- `tests/desk.test.mjs`：字段与样本校验、ZIP 防护、秩亏与退化算例、取消语义、
  报告载荷、满规模预算。
- `tests/ui.test.mjs`：真实浏览器中导入示例、下载并独立复算导出 JSON、坏包定位、
  参数过期 / 恢复、取消与取代、逐样本读数一致性。
