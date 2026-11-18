# 热方法曲面测距台（Heat Surface Ruler）

在三角网格表面用**热方法（Crane, Weischedel, Wardetzky 2013）**计算测地距离场的纯前端网页。
所有离散算子（面质量矩阵、cotan 刚度矩阵、梯度/散度）均按样例包内《格式说明.md》的公式手工组装，
稀疏线性求解使用自带的 simplicial LDLᵀ 分解，**不调用任何现成测地线或网格算子库**，也不使用边图最短路。

## 功能

- **导入**：样例 JSON / Wavefront OBJ / ASCII PLY，最多 10000 面
- **源点**：点击顶点选源，支持多源（勾选多源模式累加）；热时间 τ 在 [0.1, 10] 可调
- **热方法距离场**：
  - 每连通分量独立组装 `M_ii = 相邻面面积和/3` 与正半定刚度矩阵 `L`（内部边 `w=(cotα+cotβ)/2`，
    边界边仅一项 `/2`，**钝角负 cot 原样保留**）
  - 热时间 `t = τ ×（分量唯一有效边平均长度）²`
  - 第一步 `(M+tL)u=b`（源点 b=1），单位梯度场 `X=-∇u/|∇u|`（`|∇u|≤1e-12` 取零）
  - 第二步 `Lφ=g`，分量内全部源点作 Dirichlet 零约束、消元求非源行，最终 `max(φ,0)`
- **矩阵复用**：热分解只依赖网格与 τ，移动源点直接复用；Poisson 约束分解按源集合缓存；
  两套分解分别统计命中/未命中
- **可视化**：Turbo 距离热图、可调间距等值线（每三角形线性提取，完全等值面不出线、
  整条等值边仅由面编号较小者输出）、点选顶点显示距离数值
- **断开分量 / 孤立点**：无源的分量不求解，距离输出 `null` 并以灰色显示；孤立顶点被选为源时距离为 0
- **退化/非法网格**：面积 ≤1e-12（含重复顶点）的面列出并排除；重复面、一边 >2 面的非流形网格拒绝导入
- **同拓扑对比**：载入第二份同拓扑网格，比较两份距离场的最大/平均/RMS 差异与可达性一致性
- **导出**：顶点距离 JSON、等值线段 JSON（含 level/面号/3D 端点）、计算诊断 JSON
  （组件、排除面、钝角面、边界边、两步相对残差、缓存命中、求解耗时）

折弯但不改变三角形边长的网格（等距变形）给出与平面网格**逐值相同**的距离（样例实测最大差 0.00e+0），
因为整个方法只依赖边长/角度/面积，不依赖嵌入坐标。

## 目录结构

```
dist/
  index.html          单文件构建产物（核心算法内联，仅外部依赖 Three.js CDN），可直接分发
src/
  index.html          多文件开发版页面结构
  style.css           样式
  app.js              Three.js 渲染、顶点拾取、交互联动、导出
  lib/
    heat-method.js    核心：网格校验、分量分析、M/L 组装、LDLᵀ 求解、热方法、等值线、场对比
    parsers.js        JSON / OBJ / ASCII PLY 解析
    colormap.js       Turbo 配色
    export.js         三类 JSON 导出
test/
  run-tests.mjs       61 项 Node 单元/集成测试（对照 reference.json 全部口径）
  numpy_reference.py  独立 NumPy 参照实现（手工组装，交叉验证 JS 数值）
  e2e.mjs             25 项 Playwright 浏览器端到端测试（src 多文件版）
  build-artifact.mjs  把 src/lib + 界面打包成 dist/index.html 单文件
  artifact-smoke.mjs  8 项单文件构建冒烟测试
.work/artifact-src/   单文件版界面逻辑（UMD THREE、导出改为复制预览、明暗双主题）
```

## 运行

开发版（多文件，ES Module + importmap）需要通过 HTTP 提供，不能用 file:// 直接打开：

```bash
cd src && python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

单文件版重新构建与本地预览：

```bash
npm run build          # 生成 dist/index.html
cd dist && python3 -m http.server 8081
```

离线环境下除 Three.js CDN 外全部为本地零依赖代码；核心算法 `src/lib/` 不依赖 Three.js，
可在 Node 中直接 import 使用。单文件版在受限沙箱（无法触发浏览器下载）中，导出改为弹窗预览 JSON + 复制。

## 测试

```bash
# 单元测试（纯 Node，零外部依赖）
node test/run-tests.mjs .work/samples-extract

# 与独立 NumPy 参照实现逐值交叉校验（需要先生成参照数据）
python3 -m venv .work/venv && .work/venv/bin/pip install numpy
.work/venv/bin/python -I test/numpy_reference.py .work/samples-extract --dump .work/reference-distances.json

# 浏览器端到端测试（需要 Playwright Chromium）
node test/e2e.mjs
```

关键验证结果：

- 与独立 NumPy 实现逐值一致（8192 面 stress 用例最大差异 5.3e-13）
- 热/Poisson 相对残差均在 1e-14 量级（阈值 1e-8）
- 8192 面浏览器内求解约 0.6–0.9 s
- 折叠 vs 平面距离场最大差异 0（参考阈值 1e-6）
- 热方法距离严格短于边图最短路，确认未退回图距离
