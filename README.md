# 相位掩膜衍射打样台

全息展品的多波长相位掩膜打样网页：一张驱动图同时驱动 1–2 种波长的相位，按角谱法
分别传播到最多 6 个成像面，把这些面的加权强度误差合起来做带 Armijo 回退的梯度下降，
逐轮给出损失与采用的步长，并提供逐像素点查与 8 位驱动 / 误差 JSON 导出。

零第三方依赖：二维 FFT、传播核、梯度、回退与量化都在 `src/core.js` 里自己实现。

## 运行

```bash
python3 -m http.server 8124      # 打开 http://127.0.0.1:8124/
# 或直接双击 index.html（file:// 下也能跑：求解放在 Blob Worker 里）
npm test                          # 数值核心 + 校验 + 满规模性能
node tools/build-worker.mjs       # 改过 src/core.js 后重新生成 worker 源码
```

`file://` 打开时浏览器禁止 `fetch` 本地样例，请用「导入 JSON」选择
`samples/phase-mask.json`；`http://` 下会尝试自动载入内置样例。

## 目录

```
index.html              页面骨架与样式（浅色 / 深色、窄屏）
src/core.js             数值核心：FFT、传播、解析梯度、回退试步、量化与导出复算
src/worker-runner.js    Worker 侧消息循环（被拼进 worker-source.js）
src/worker-source.js    自动生成：core.js + worker-runner.js 的 Blob Worker 源码
src/app.js              界面：导入、运行、暂停续跑、点查、图表、导出、旧任务隔离
tools/build-worker.mjs  生成 src/worker-source.js
tests/reference.mjs     独立参考：直接 DFT 求和（不经 FFT）与有限差分梯度
tests/core.test.mjs     传播 / 梯度 / 回退 / 量化对拍
tests/validate.test.mjs 字段级校验
tests/perf.test.mjs     256×256、2 波长、6 面、12 轮的预算
samples/phase-mask.json 题目样例（含 spec 说明）
```

## 数据约定（与 `samples/phase-mask.json` 的 spec 一致）

- 驱动 `p ∈ [0,1]`，行优先铺平，`x` 向右、`y` 向下；初始/每轮锁点恒为 `q/255`。
- 每种波长入射复场 `U = amp·exp(i·2π·cycles·p)`。
- 补零网格 `M=2W、N=2H`，原场左上角放在 `(W/2, H/2)`；正向 DFT 指数为负，逆向除以 `M·N`。
- 频率 `fx=m/(M·dx)`，`m<W` 取原值否则 `m−M`；`fy` 同理。
- `s = 1/λ² − fx² − fy²`：`s≥0` 乘 `exp(i·2π·z·√s)`，否则乘 `exp(−2π·z·√(−s))`（倏逝按距离衰减）；`z=0` 时恒为 1。
- 逆变换后裁回放置矩形得 `V`，`I=|V|²`；`E = 0.5·Σ weight·(I−target)²`。
- 真实梯度 `G = ∂E/∂p`（未投影、未清零锁点），由伴随传播：`a = 2w(I−T)V` 补零 → FFT →
  乘共轭 `H_z` → 逆变换 → 裁回，`G += 2π·cycles·Im(conj(U)·f)`。
- 试步 `t = eta/2^j`（`j=0…7`），非锁点 `clip(p − t·G, 0, 1)`，锁点用 `q/255`；接受第一个
  「与 `p` 有差别且 `E(trial) ≤ E(p) + 1e-4·G·(trial−p) + 1e-12·max(1,E(p))`」的试步。
  无可接受步时保留驱动与损失、步长记 0。
- 第 0 轮是套用锁点的初始驱动，只记录损失；之后每轮是一次试步。改 `z` 或 `eta` 回到新设置的第 0 轮。
- 导出驱动 `q = floor(255·p + 0.5)`（半码向上）；误差 JSON 的 `loss` / `planeLoss`
  用 `q/255` 重新传播（含 0.5 系数），不是未量化的损失。

## 页面能力

- **导入**：JSON 文件或内置样例。字段非法时逐条报出路径（如 `planes[0].weight[3]`），
  **上一份有效项目与它的运行结果保持不变**。
- **三视图**：驱动图（8 位灰度）、所选面的预测强度（色阶仅影响显示）、损失梯度（红正蓝负）。
- **点查**：在图上点任意像素（也可用方向键移动），读出该点的驱动、8 位码、未投影梯度、
  所选面的预测强度 / 目标 / 权重、锁点信息与振幅。切换面即时更新。
- **运行**：单步、续跑、暂停（当前轮会完整跑完）；每轮的损失与采用的步长进入曲线与表格。
- **参数**：`eta`、各面 `z`、目标 `steps` 均可编辑；改 `eta`/`z` 会以新设置重建并回到第 0 轮。
- **旧任务隔离**：每次载入 / 改参都递增代际令牌，旧任务返回的任何消息都被丢弃，
  不会覆盖当前结果。
- **导出**：`W*H` 字节的 8 位驱动 `.bin`（行优先），以及 `{W,H,step,loss,planeLoss}` 的
  误差 `.json`；两者都用同一份量化码，JSON 的损失正是从量化码重新传播得到的值。

## 性能

求解在 Worker 中运行。满规模（256×256、2 种波长、6 个面、12 轮）在 4 逻辑核上
实测约 10 秒（`tests/perf.test.mjs` 守 35 秒预算，纯计算约 7 秒）。

## 测试

```bash
npm test
```

- `tests/core.test.mjs`：三面算例的强度、损失、梯度与直接 DFT / 有限差分对拍；零权重
  像素不改变损失与梯度；回退先拒 `t=1` 再收 `0.5`、第二轮收 `1`；全零权重时步长 0；
  8 位字节与量化误差 JSON 的精确值；半码向上。
- `tests/validate.test.mjs`：尺寸、范围、重复锁点、面索引、`eta`/`steps` 等字段级报错。
- `tests/perf.test.mjs`：满规模 12 轮预算。
