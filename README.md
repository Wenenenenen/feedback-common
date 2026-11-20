# ARAP 控制点变形台

带硬位置约束的局部刚性（As-Rigid-As-Possible）网格变形网页。美术用控制点调整造型时，普通拉点会把细节拉扁、连续修改会累积误差；本工具每次求解都从导入的原网格重新开始，无约束分量保持原样，局部矩阵只允许正旋转。

## 运行

Worker 与 ES Module 需要 http 协议，不能用 `file://` 直接打开：

```bash
node test/server.mjs        # 然后访问 http://localhost:8753/
```

## 测试

```bash
npm test                    # 12 个 Node 数值测试（对照 samples/extracted/expected.json）
node test/e2e.test.mjs      # 23 个 Playwright 端到端 UI 测试（需全局 playwright）
```

## 架构

全部为原生 ES Module，无运行时第三方依赖，未使用任何现成网格变形接口。

| 文件 | 职责 |
| --- | --- |
| `src/mat3.js` | 3×3 矩阵、对称 Jacobi 特征分解、由 H 求最优 **SO(3)** 正旋转（极分解 + 反射修正）、Gram-Schmidt 正交化 |
| `src/sparse.js` | 自研稀疏 LDLᵀ：消去树符号分解 + 左向数值分解 + 按列三角代入 |
| `src/mesh.js` | 输入校验（指出具体对象与索引）、无向边提取、邻接表、连通分量 |
| `src/solver.js` | ARAP 核心：局部步（逐点正旋转）、全局步（消元硬约束，无罚项）、能量与停止判定 |
| `src/view.js` | 自研 WebGL 三维线框：轨道旋转/缩放、解析射线拾取、原网格叠加 |
| `src/worker.js` | 求解 Worker，每轮让出事件循环，全量计算期间视角仍可操作 |
| `src/exporters.js` | 保持原拓扑的 OBJ、含逐点旋转/约束/迭代记录的诊断 JSON |
| `index.html` | 界面：选点/定位、增删约束、目标坐标编辑、能量曲线、单轮/全量求解、重置、导出 |

## 关键约定（与 samples/extracted/conventions.md 一致）

- 输入上限 2000 顶点、4000 三角形；边权恒为 1，无向边从三角形提取去重。
- 能量 `E = Σ_i Σ_{j∈N(i)} ‖(x_i−x_j) − R_i(p_i−p_j)‖²`，`R_i ∈ SO(3)`，禁止反射。
- 局部步 `H_i = Σ (p_i−p_j)(x_i−x_j)ᵀ`，经极分解投影到 SO(3)；秩不足（共面邻域）时任选最优正旋转，镜像约束下正确得到能量 64 而非 0。
- 全局步自由点方程 `degree(i)·x_i − Σ_j x_j = 0.5·Σ_j (R_i+R_j)(p_i−p_j)`，硬约束用消元精确施加，不用大权重罚项。
- 每次求解从原网格 `p` 初始化，硬约束点直接赋 target；无约束连通分量冻结在 `p`，孤立约束点直接到 target。
- 初始化后先做局部步记录第 0 项能量；默认最多 30 轮，相邻记录相对下降不超过 `1e-7` 时收敛，分母 `max(1, 前一能量)`；界面可调 1–100 轮、`1e-10`–`1e-3` 阈值。达到轮数上限标记为 `max_iterations`，不称作收敛。
- 诊断 JSON 含 `rest、vertices、triangles、constraints、rotations（逐点行主序 3×3）、energies（含第 0 项）、iterations、stop_reason`。

## 非法数据处理

校验在导入时执行，错误逐条列出文件内对象与索引，例如：

- `triangles[0]：索引 [0, 1, 9] 存在非整数或越界（合法范围 0..3）`
- `triangles[0]：退化三角形 [0, 1, 2]，叉积模长 0.000e+00 不大于 1e-12`
- `constraints[1]：顶点 0 的约束重复（该顶点已有约束）`
- `rest[0]：必须是 3 个有限数组成的坐标 [x,y,z]`

允许孤立顶点、不连通分量与局部共面邻域。
