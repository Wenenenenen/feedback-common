# Quad Derivative Reel

片元四格组（fragment quad，2×2 片元）导数 / 纹理 LOD 校验台。用于排查材质在图形边缘、
挖孔处突然跳到粗纹理层的问题：定位是哪条纹理指令、在哪个片元四格上拿到了错误导数。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 自包含校验网页（引擎已内联），浏览器直接打开即可 |
| `index.src.html` | 页面模板，`<!--__ENGINE__-->` 处由构建脚本注入引擎 |
| `engine.js` | 纯计算引擎（UMD，浏览器 / Node 通用），无 DOM 依赖 |
| `samples/quad-program.json` | 输入包格式样例（包内 `rules` 字段为权威语义说明） |
| `tools/reference.py` | 独立 Python 参考实现（语义基线） |
| `tools/gen_cases.py` | 对拍用例生成器（功能用例 + 25 万组压力包） |
| `tools/gen_mid.py` | 与压力包同分布的 1 万组中等用例 |
| `tools/compare.js` | JS 引擎 vs Python 参考逐分量对拍（容差 1e−6） |
| `tools/bench.js` | 压力计时与 f32 导出校验 |
| `tools/e2e.js` | Playwright 浏览器端到端测试 |
| `tools/build.js` | 引擎内联构建，生成 `index.html` |

## 语义实现要点

- 每个四格组四个车道 LT/RT/LB/RB（左上对应 mask 最低位）；未覆盖（mask 未置位）和
  已舍弃的辅助格**继续执行全部指令**，并按包内细/粗规则参与导数。
- 细横取所在行右减左，细纵取所在列下减上；粗横全用顶行，粗纵全用左列。
- `舍弃` 在甲 < 乙 时置舍弃标记，不写寄存器。
- 纹理指令用坐标寄存器**当时**的细导数换算为基底纹素：
  `ρ = max(|(du/dx·W, dv/dx·H)|, |(du/dy·W, dv/dy·H)|)`，
  `LOD = clamp(log2(ρ), 0, 层数-1)`，零导数取第 0 层；双线性按
  `u·w−0.5`、`v·h−0.5` 取周期邻点，分数 LOD 在相邻两层间线性混合。
- 只有已覆盖且未舍弃的片元参与深度选择：深度小者胜，同深度取小 id
  （再同则按输入顺序、车道编号兜底）。
- 输出取胜者车道的 `out` 三寄存器为 RGB，入屏片元 A=1，空像素 RGBA 全零。

## 网页功能

- 载入 JSON 包、内置样例、一键生成 25 万组 / 48 指令压力包；512×512 画布点像素检视：
  各四格值、uv、舍弃标记、每条纹理指令的 LOD 与采样层、层间混合系数、最终胜者。
- 坏指令标出程序行号，校验失败时画布保留上一次可导出的画面。
- 导出线性浮点 RGBA：IEEE binary32 小端、行优先、左上原点（`.rgba.f32.bin` + meta.json），
  另附 RGB PFM。引擎内部全程 f64，导出分量误差仅 f32 舍入（实测 ≤ 6e−8）。

## 测试

```bash
python3 -I tools/gen_cases.py tools/cases --stress   # 生成用例
node tools/compare.js tools/cases                    # 功能对拍（vs Python 参考）
node tools/bench.js tools/cases/stress.json          # 压力计时（10 秒预算）
NODE_PATH=<global node_modules> node tools/e2e.js    # 浏览器端到端
node tools/build.js                                  # 重新生成 index.html
```

实测（参考机）：25 万组 × 48 指令（含一条采样），浏览器内引擎约 1.2 s、端到端约 3 s
出现可检查画面，远低于 10 s 预算；功能对拍 f64 帧误差 ~1e−16。
