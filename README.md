# 切缝展开参数化器 · Cut-Chart Parameterizer

在浏览器中导入索引三角网格与切缝边，按切缝拆开顶点、找到每个图表的边界环，
把边界按三维弧长放到单位圆上，再用余切权重求解内部 UV；同时定位非圆盘、
非流形、退化面等问题，并导出逐角 UV、拆分顶点对应关系与诊断 JSON。

## 运行

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 类型检查 + 生产构建
npm test           # 43 项单元测试
```

## 使用

- **样例**：下拉选择 `public/samples/` 中的内置案例，包括已切缝圆柱、未切缝圆柱（应失败）、
  钝角圆盘、蝴蝶顶点、非流形边、退化面。
- **导入 JSON**：`{ "vertices": [[x,y,z],...], "faces": [[a,b,c],...], "seams": [[i,j],...] }`，
  最多 5000 个三角形。
- **增删切缝**：在三维视图中左键点击任意边即可添加/移除切缝，结果立即重算；
  侧栏可逐条删除，或点「自动切缝」让工具沿最短边界路径建议一组切缝。
- **检查器**：点击面（三维中 Shift+点击，或直接点击 UV 视图）查看所属图表、
  cut 顶点、UV 双面积（翻转/近零）与三个角上的方程残差。
- **视图开关**：线框、分图表着色、图表边界、拆分点、残差着色；UV 视图可分栏或叠加。
- **导出诊断 JSON**：包含逐角 UV、拆分顶点对应关系、图表拓扑（含 V−E+F 校验）、
  每个内部点的方程残差、求解器信息与带元素定位的诊断。
  另有「复制逐角 UV」给出 `[u0,v0,u1,v1,...]`（顺序为 `3*face+corner`）。

## 算法

1. **校验**：顶点/面/索引合法性、面积 < 1e-12 的退化面、每边至多两面、
   有向边一致、每顶点邻面按共享边只有一个扇（禁止蝴蝶顶点）；切缝必须是真实边。
2. **拆分**（`src/core/split.ts`）：以原面角为节点，仅跨非切缝共享边把边两端
   对应的原顶点面角相连；连通分量成为 cut 顶点，按 `(face, corner)` 最小值稳定编号。
3. **图表**：跨非切缝边做面连通分量；每图表取有向边中「反向未出现」的边串成
   边界环，起点为 cut 编号最小点；要求每图表连通、恰一个边界环且 V−E+F=1。
4. **边界**：`s_i` 为沿边界累计三维边长，`P` 为周长，
   映射到 `(cos 2π s_i/P, sin 2π s_i/P)`。
5. **权重**：每个三角形对每条边贡献对角余切的一半 `0.5·dot(a,b)/‖a×b‖`，
   负值保留；内部方程 `Σ_j w_ij (uv_i − uv_j) = 0`，边界固定。
6. **求解**（`src/core/solver.ts`）：自写通用稀疏迭代求解器（对称系统用 CG、
   非对称用 BiCGSTAB，均带 Jacobi 预条件），不依赖任何现成展开工具。
7. **诊断**：UV 有向双面积 < −1e-10 为翻转，|·| ≤ 1e-10 为近零；
   归一化残差为 `‖Σ_j w_ij(uv_i−uv_j)‖ / max(1, Σ_j |w_ij|)`。

## 目录

```
src/core/       纯计算：validate / split / parameterize / solver / suggest / export
src/ui/         three.js 三维预览、Canvas UV 视图、侧栏面板、配色
src/main.ts     应用装配与事件
test/           单元测试（样例、边界情况、求解器、切缝建议）
public/samples/ 内置样例（CC0-1.0）
```

核心计算不依赖 DOM 或 three.js，可直接在 Node 中调用：

```ts
import { parameterize } from './src/core/parameterize.js';
const result = parameterize({ vertices, faces, seams });
result.charts[0].topology;   // { cutVertices, edges, faces, euler, boundaryLoops }
result.stats.maxResidual;    // 归一化残差最大值
result.errors;               // 带 elements 定位的诊断
```
