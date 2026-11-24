# 拉丝金属反射采样校验（microfacet-sampler-proof）

校验**各向异性 GGX**在双轴粗糙度不同时，可见微表面法线（VNDF）采样的概率正确性。
高光方向转对了不等于采样概率对——本页同时给出采样统计与确定性积分，逐格对账。

全部数学（VNDF 采样、各向异性 GGX 的 D / Λ / G2 / F / BRDF、密度换算、自适应积分）
均手写实现，**不依赖任何现成材质着色或采样库**。

## 运行

直接用静态服务器打开 `web/index.html`（ES module 需要 http 源，不要用 `file://`）：

```bash
cd web && python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/
```

## 文件

| 文件 | 职责 |
|---|---|
| `web/microfacet-core.js` | 数学核心：xorshift32、拉丝坐标架、各向异性 GGX（D/Λ/G2/F/BRDF）、VNDF 采样、pH/pL、分格 |
| `web/integrator.js` | 确定性积分：8×16 等立体角分格上的中点法则两级稳定自适应细化；单点方向查询 |
| `web/sampler.js` | 分块采样运行器：可取消、runId 代际保护、拒收不重抽且保留在分母、逐次样本留存 |
| `web/app.js` | 页面控制：参数、热力图、格统计表、点格查样本、方向查询、校验诊断、CSV/JSON 导出 |
| `web/index.html` | 页面结构与样式（浅色/深色双主题，窄屏自适应） |
| `samples/microfacet-proof.json` | 工况样例与数值约定（所有公式与容限的权威来源） |
| `test/selftest.mjs` | Node 数学自测（24 项，无浏览器依赖） |
| `test/e2e.mjs` / `test/e2e-extra.mjs` | Playwright 端到端：完整交互、取消代际、窄屏、导出 |

## 数值约定（严格遵循 samples/microfacet-proof.json）

- 世界：单位法向 +Z；观察 `v` 与出射 `l` 均指离表面；归一后 `vz ≥ 0.01`。
- 拉丝局部轴 = 世界 XY 绕 z **反转 angle 度**；`ax, ay ∈ [0.02,1]`，`F0 ∈ [0,1]`，种子为非零 u32。
- 每次尝试两次 **xorshift32**（xor<<13、xor>>>17、xor<<5），`u=(s+0.5)/2^32`。
- VNDF 采样按样例文字逐步实现（拉伸空间 `Vh`、`T1/T2`、半球投影混合 `s=(1+Vhz)/2`）。
- `lz ≤ 0` 记**拒收，不重抽**；采样能量估计把拒收记 0 后除以**总尝试次数**（不剔除分母）。
- 密度：`pH = D·max(0,v·h)/(vz(1+Λ(v)))`；有效 `h=normalize(v+l)`，`pL = pH/(4|v·h|)`。
- 分格：世界空间 z 均分 8 带、方位 `[0,2π)` 均分 16 格，左闭右开，`z=1` 归最后带、极点方位 0。
- 容限：数值总能量误差 ≤ 0.0005，逐格概率积分误差 ≤ 0.001。

## 两种半球反射能量

1. **采样估计**：`(1/N) Σ_i BRDF·lz / pL(l_i)`，拒收项为 0，`N` 为总尝试数。
2. **确定性积分**：`∫_{上半球} BRDF·lz dΩ`，逐格自适应细化，误差与细化诊断随结果导出。

## 测试

```bash
node test/selftest.mjs          # 数学正确性（NDF 归一、拒收率、能量、旋转、取消、校验）
# 端到端需全局 Playwright 与 Chromium：
node test/e2e.mjs
node test/e2e-extra.mjs
```
