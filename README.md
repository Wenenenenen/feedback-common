# 多帧亚像素重建台（Burst Sub-pixel Reconstructor）

把 2–8 张带已知亚像素位移与模糊核的低分辨率 PNG，重建为固定 2× 尺寸的高分辨率图。
全部投影、严格配对的转置算子与共轭梯度求解均为手写矩阵无关实现，不依赖任何现成
超分辨率/复原接口或第三方运行时库。

## 运行

```bash
npm start          # 等价于 node tools/serve.mjs，默认 http://localhost:8123/
# 或任意静态服务器：
python3 -m http.server 8123
```

建议经 HTTP 访问以启用 ES 模块 Worker；Worker 被拦截时页面自动回退到主线程求解。

## 测试

```bash
npm test                       # 算子/伴随/端到端数值验证（纯 Node）
node tools/browser-smoke.mjs   # Playwright 真实浏览器 UI 全流程（含取消、导出字节校验）
```

## 观测模型（与样例包 `说明.md` 一致）

低分辨率 W×H，高分辨率 2W×2H，节点坐标均为整数，像素值取 `字节/255` 的线性值，不做 sRGB 转换。

1. **真卷积** `B[y,x] = Σ_{j,i} k[j,i]·X[y-(j-c), x-(i-c)]`，图外 X 视为 0；
   核为边长 1/3/5 的非负方阵、和为 1、原点在中心。
2. **双线性取样**：观测 `(u,v)` 在 B 坐标 `(2u+dx, 2v+dy)` 取样，位移以高分辨率像素为单位、
   分量范围 [-4, 4]；越界的四邻项一律视 0，**不做任何重归一化**。
3. **掩膜**：同尺寸 8 位灰度 PNG，`weight = mask/255`；无掩膜权重恒为 1。

目标函数

```
J = ½ Σ_f Σ_q w_q (A_f X − Y_f)²  +  λ/2 Σ_图内水平/垂直边 (相邻差)²  +  η/2 Σ X²
```

- η 固定 1e-6，λ ∈ [0,1] 页面可调；L 只含图内边，每条向右/向下的边只计一次。
- 正规方程 `(Σ AᵀWA + λL + ηI) X = AᵀWY`，从零初始化用普通（非预条件）CG 求解，
  停止条件 `‖r‖/max(‖b‖,1e-12) ≤ tol`（tol ∈ [1e-10,1e-2]）或达到 max_iter（≤300）。
- b=0 直接输出全 0；**迭代全程不截断**，仅展示与 PNG 导出截到 [0,1]。

### 严格转置的构造保证

`js/model.js` 在构建时一次性确定每个观测像素的双线性四邻系数，前向取样 `S` 与伴随
散射 `Sᵀ` 复用同一份 `nbIndex/nbWeight`；卷积 `B` 与其转置 `Bᵀ` 复用同一组 tap 系数和
同一套越界判定。`Aᵀ = Bᵀ∘Sᵀ` 因此与 `A = S∘B` 逐系数配对，不存在两套独立实现漂移的可能。
`tools/test.mjs` 用样例包的 `operator-probe.json`（给定 Ax、Aᵀz、内积答案）做逐位比对，
并对多核/多位移/含越界随机用例验证 `<Ax,z> = <x,Aᵀz>`。

## 页面功能

- 导入：拖入或选择 PNG 与可选 JSON（JSON 可带 kernel、逐帧 shift/mask、求解参数）；
  无 JSON 时在帧表与核编辑器中手工配置，核和不为 1 时拒绝运行（只提供显式归一化按钮）。
- 调节：λ 滑块、tol、max_iter；运行中可**取消**（Worker 直接 terminate，丢弃半成品）。
- 展示：重建图、CG 收敛曲线（对数纵轴、容差参考线、十字线 tooltip）、
  逐帧回投影残差热力图（零掩膜像素以斜纹标出）、越界/缺测与截断统计。
- 像素探查：点任一残差/观测像素，查看该观测对高分辨率网格的完整贡献行
  （双线性 × 卷积扩散后的系数、覆盖率、最大贡献网格点）。
- 导出：
  - **PNG**：截到 [0,1] 后量化的 8 位灰度/RGB；
  - **浮点图**：未截断的小端 float64 裸 `.bin`，RGB 逐像素交错，形状写入参数 JSON；
  - **参数 JSON**：观测模型约定、核、逐帧位移/掩膜、求解设置与收敛摘要。

## 目录

```
js/model.js         观测模型：卷积/取样及严格转置、Laplacian、AᵀWA 复合算子、贡献探查
js/solver.js        普通共轭梯度（零初始化、相对残差停止、目标分量历史）
js/png-codec.js     纯 JS PNG 编解码（8 位灰度/RGB，CompressionStream，无第三方依赖）
js/reconstruct.js   Worker 与主线程回退共用的求解流水线
js/solver-worker.js Worker 薄封装（取消=terminate）
js/heatmap.js       残差发散色阶 / 贡献顺序色阶热力图
js/chart.js         SVG 收敛曲线（对数轴、tooltip、图例）
js/export.js        PNG / float64-LE / 参数 JSON 导出
js/app.js           导入校验、调度、UI 联动
tools/test.mjs      数值验证（probe 硬答案、伴随、对称正定、端到端 vs truth）
tools/browser-smoke.mjs  浏览器全流程冒烟
tools/serve.mjs     零依赖静态服务器
```
