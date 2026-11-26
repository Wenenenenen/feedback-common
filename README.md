# 定点均衡头间规划台

16 位 Q14 定点双二阶（SOS）均衡器的段顺序与前置右移规划、逐样本仿真与削顶审计网页。

## 目录

- `web/index.html` — 单页应用（导入、求解、余量表、仿真、试听、导出）
- `web/headroom.js` — 纯逻辑核心：校验、子集 DP 求解、定点仿真、WAV 读写
- `web/planner-worker.js` — 求解 Worker（不阻塞 UI）
- `web/sim-worker.js` — 仿真 Worker（带进度、Transferable 回传）
- `tools/ref.py` — Python 参考实现（同构算法，独立实现用于对拍）
- `tools/brute_check.py` — 全排列暴力枚举校验（小段随机用例）
- `tools/node_check.js` — JS 与 Python 参考实现逐用例/逐样本对拍
- `tools/e2e_check.js` — Playwright 端到端（真实 Worker、文件导入、下载内容）
- `tools/make_cases.py`、`tools/trace_check.py` — 压力用例生成与手工取整/削顶追踪
- `samples/sos-headroom-cases.zip` — 题面样例（解压到 `_unpacked/`，已 gitignore）

## 运行

任意静态服务器指向仓库根目录后打开 `/web/index.html`，例如：

```bash
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/web/index.html
```

页面全部逻辑本地运行，无外部网络依赖（字体除外）。

## 测试

```bash
python3 -I tools/make_cases.py           # 生成合成用例与 WAV
python3 -I tools/brute_check.py          # DP vs 全排列（100 个随机小用例）
python3 -I tools/trace_check.py          # 就近取偶/削顶/递归历史手工追踪
node tools/node_check.js                 # JS 与 Python 逐样本对拍
NODE_PATH=$(npm root -g) node tools/e2e_check.js   # 浏览器端到端
```

## 关键约定（与 format.txt 一致）

- 每级输入先 `v / 2^shift` 就近取偶（半整数取偶，负数对称），再进双二阶。
- 宽累加器：`b0·x+b1·x1+b2·x2−a1·y1−a2·y2`，整项 `/16384` 就近取偶，
  夹取到 `[−32768, 32767]`；越界计一次削顶，**饱和值进入递归历史**。
- 各声道历史独立、从零开始；输出为末级 y，不做增益补偿。
- 账本：前 k 段账面增益 `Σgain − 256·累计移位 ≤ 第 k 段 limit`（逐测频点）。
- 方案排序：总右移（≤12，每级 0–3）→ 逐级累计移位之和 → `(id, shift)`
  序列字典序最小；无解时页面明确提示。

## 求解算法

子集 DP，状态 `(已选段掩码, 总移位)`：账面向量只由掩码与总移位决定
（`Σgain[mask] − 256·total`），与到达路径无关，故每状态只保留前缀和最小、
字典序最小的一条路径。状态数 `2^14 × 13 ≈ 21 万`，浏览器实测满规格
约 0.5 秒（预算 5 秒）。
