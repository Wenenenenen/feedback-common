# Separating Voxel Foundry 格式与判定约定 (SPEC)

## 1. 输入 JSON 结构
```json
{
  "meshId": "string",
  "grid": {
    "origin": [0.0, 0.0, 0.0],
    "dims": [24, 24, 24],
    "spacing": [1.0, 1.25, 1.5]
  },
  "separatingMode": "6-separating",
  "floodConnectivity": 6,
  "vertices": [[0.0, 0.0, 0.0]],
  "triangles": [
    {
      "id": 0,
      "indices": [0, 1, 2],
      "material": 1,
      "group": "outer_shell",
      "enabled": true
    }
  ],
  "edits": []
}
```

## 2. 合法性校验规则
导入或修改时必须先检查以下条件；若任一项非法，必须拒绝并指出具体字段或 `triangle.id` 与原因，同时保持当前已有的有效体素化结果可用：
1. **网格参数**：`dims` 三个整数 $[N_x, N_y, N_z]$ 均在 `[1, 96]` 内；`spacing` 三个浮点数 $[\Delta x, \Delta y, \Delta z]$ 均严格大于 `0` 且为有限数；`origin` 为有限浮点数。
2. **模式参数**：`separatingMode` 只能取 `"6-separating"`（薄壳）或 `"26-separating"`（厚壳/超覆盖）；`floodConnectivity` 只能取 `6` 或 `26`。
3. **三角形数据**：`triangles.length <= 10000`；每个三角形 `indices` 三个整数在 `[0, vertices.length - 1]` 内；`material` 为 `[1, 16]` 的整数；物理空间三角形面积 $\frac{1}{2}\|(\mathbf{v}_1-\mathbf{v}_0)\times(\mathbf{v}_2-\mathbf{v}_0)\| > 10^{-10}$（否则报零面积退化面，指出 `triangle.id`）。

## 3. 各向异性物理网格与 6 分离 / 26 分离表面体素化
- 体素索引 $(i, j, k)$ 满足 $0 \le i < N_x, 0 \le j < N_y, 0 \le k < N_z$。
- 该体素在物理空间占据轴对齐盒 $[x_0 + i\Delta x, x_0 + (i+1)\Delta x] \times [y_0 + j\Delta y, y_0 + (j+1)\Delta y] \times [z_0 + k\Delta z, z_0 + (k+1)\Delta z]$，中心为：
  $$\mathbf{c}_{i,j,k} = (x_0 + (i + 0.5)\Delta x, \; y_0 + (j + 0.5)\Delta y, \; z_0 + (k + 0.5)\Delta z)$$
  半边长向量为 $\mathbf{h} = (h_x, h_y, h_z) = \frac{1}{2}(\Delta x, \Delta y, \Delta z)$。
- 对任意 `enabled == true` 的三角形 $\triangle(\mathbf{v}_0, \mathbf{v}_1, \mathbf{v}_2)$，记相对体素中心的顶点 $\mathbf{p}_a = \mathbf{v}_a - \mathbf{c}_{i,j,k}$（$a \in \{0,1,2\}$），有向边 $\mathbf{e}_0 = \mathbf{p}_1 - \mathbf{p}_0, \mathbf{e}_1 = \mathbf{p}_2 - \mathbf{p}_1, \mathbf{e}_2 = \mathbf{p}_0 - \mathbf{p}_2$，单位法向量 $\mathbf{n} = \frac{\mathbf{e}_0 \times \mathbf{e}_1}{\|\mathbf{e}_0 \times \mathbf{e}_1\|}$，数值容差 $\varepsilon = 10^{-9}$。
- **26 分离（厚壳 / Supercover，阻断 26 连通与 6 连通穿越）判定**：
  当且仅当三角形与闭合体素盒通过全部 13 个分离轴测试时命中该体素：
  1. **3 个坐标轴（AABB 包围盒）**：对 $u \in \{x, y, z\}$，$\min_a p_{a,u} \le h_u + \varepsilon$ 且 $\max_a p_{a,u} \ge -h_u - \varepsilon$；
  2. **1 个三角形平面法线轴 $\mathbf{n}$**：$|\mathbf{n} \cdot \mathbf{p}_0| \le r_{\text{plane}}^{(26)} + \varepsilon$，其中
     $$r_{\text{plane}}^{(26)} = |n_x| h_x + |n_y| h_y + |n_z| h_z$$
  3. **9 个边叉积轴 $\mathbf{a}_{u,m} = \hat{\mathbf{u}} \times \mathbf{e}_m$**（$u \in \{x,y,z\}, m \in \{0,1,2\}$）：当 $\|\mathbf{a}_{u,m}\| > 10^{-10}$ 时，记 $q_a = \mathbf{a}_{u,m} \cdot \mathbf{p}_a$，要求 $\min_a q_a \le r_{u,m}^{(26)} + \varepsilon$ 且 $\max_a q_a \ge -r_{u,m}^{(26)} - \varepsilon$，其中
     $$r_{u,m}^{(26)} = |a_{u,m,x}| h_x + |a_{u,m,y}| h_y + |a_{u,m,z}| h_z$$
- **6 分离（薄壳 / 6-Minimal，仅保证阻断 6 连通正交穿越）判定**：
  设主法线轴 $u^* = \arg\max_{u \in \{x,y,z\}} |n_u| h_u$（并列依 $x, y, z$ 顺序取先）。当且仅当满足以下三项时命中该体素：
  1. **3 个坐标轴（AABB 包围盒）**：同 26 分离第 1 项；
  2. **薄壳平面法线轴 $\mathbf{n}$**：$|\mathbf{n} \cdot \mathbf{p}_0| \le r_{\text{plane}}^{(6)} + \varepsilon$，其中
     $$r_{\text{plane}}^{(6)} = \max(|n_x| h_x, \; |n_y| h_y, \; |n_z| h_z)$$
  3. **9 个边叉积轴**：对每个 $\|\mathbf{a}_{u,m}\| > 10^{-10}$ 的轴 $\mathbf{a}_{u,m} = \hat{\mathbf{u}} \times \mathbf{e}_m$，当 $u = u^*$（主法线轴投影）时采用薄边半径 $r_{u,m}^{(6)} = \max(|a_{u,m,x}| h_x, |a_{u,m,y}| h_y, |a_{u,m,z}| h_z)$，其余轴采用 $r_{u,m}^{(26)}$，要求 $\min_a q_a \le r_{u,m} + \varepsilon$ 且 $\max_a q_a \ge -r_{u,m} - \varepsilon$。

## 4. 表面体素的多材质与来源面归属规则
- 若至少一个 `enabled == true` 的三角形命中体素 $(i, j, k)$，该体素标记为 `SURFACE`。
- 多个三角形同时命中同一表面体素 $(i, j, k)$ 时，结果**严禁依赖三角形输入顺序**，必须计算体素物理中心 $\mathbf{c}_{i,j,k}$ 到每个命中闭合三角形 $\triangle_t$（含三角形内部、三条边线段和三个顶点）的**精确三维物理欧氏距离平方** $d^2(\mathbf{c}_{i,j,k}, \triangle_t) = \min_{\mathbf{x} \in \triangle_t} \|\mathbf{x} - \mathbf{c}_{i,j,k}\|_2^2$：
  - 取 $d^2(\mathbf{c}_{i,j,k}, \triangle_t)$ 最小者作为该体素的归属三角形；
  - 若 $|d_1^2 - d_2^2| \le 10^{-11}$，优先取 `material` 编号较小者；若仍相同，取 `triangle.id` 较小者。

## 5. 外部漫水、对角漏孔定位与封闭连通块广义绕数分类
- **外边界漫水（`EXTERIOR`）**：
  - 将网格外围视为一圈虚拟空气边界（即任一坐标 $i \in \{0, N_x-1\}$ 或 $j \in \{0, N_y-1\}$ 或 $k \in \{0, N_z-1\}$ 的非 `SURFACE` 体素均与网格外空气直接相邻）。
  - 从所有位于该外边界上的非 `SURFACE` 体素出发，按当前选定的 `floodConnectivity`（`6` 连通：仅共面的 $\pm 1$ 步；或 `26` 连通：满足 $\max(|\Delta i|, |\Delta j|, |\Delta k|) = 1$ 的 26 邻域步）在非 `SURFACE` 体素上执行广度优先漫水，所有可达体素标记为 `EXTERIOR`。
- **对角漏孔体素对定位（`diagonalLeaks`）**：
  - 在 6 分离薄壳模式且切换为 26 连通漫水时，首先对照同一表面网格下的 6 连通漫水结果（记 6 连通下可达的外部集为 $E_6$，6 连通下不可达外部的非表面封闭集为 $I_6$）。
  - 若一对非表面体素 $(\mathbf{u}, \mathbf{v})$ 满足：
    1. $\mathbf{u} \in E_6$ 且 $\mathbf{v} \in I_6$；
    2. $\mathbf{u}$ 与 $\mathbf{v}$ 是 26 邻域对角邻居（即 $\max(|u_x-v_x|, |u_y-v_y|, |u_z-v_z|) = 1$ 且 $2 \le |u_x-v_x| + |u_y-v_y| + |u_z-v_z| \le 3$）；
    3. 在以 $\mathbf{u}, \mathbf{v}$ 为对角顶点的最小轴对齐子盒 $[\min(u_x,v_x), \max(u_x,v_x)] \times [\min(u_y,v_y), \max(u_y,v_y)] \times [\min(u_z,v_z), \max(u_z,v_z)]$ 内，不存在任何非 `SURFACE` 的 6 连通路径连接 $\mathbf{u}$ 与 $\mathbf{v}$（即中间桥接格被 `SURFACE` 阻挡）；
    则 $(\mathbf{u}, \mathbf{v})$ 记为一对对角漏孔 `{ "fromExterior": [ux, uy, uz], "toEnclosed": [vx, vy, vz] }`，按 `fromExterior` 再按 `toEnclosed` 的坐标字典序排列输出。
- **封闭连通块分类（`SOLID_INTERIOR` vs `EMPTY_CAVITY`）**：
  - 对漫水后所有既非 `SURFACE` 也非 `EXTERIOR` 的剩余体素，按 6 连通划分为若干封闭连通分量 $C_1, C_2, \dots, C_m$。
  - 每个分量 $C_r$ 取其中坐标字典序 $(i, j, k)$ 最小的体素作为代表体素 $\mathbf{u}^*(C_r)$，在其物理中心 $\mathbf{c} = \mathbf{c}_{\mathbf{u}^*}$ 处对所有 `enabled == true` 的三角形计算**广义立体角绕数**（Van Oosterom & Strackee 公式）：
    $$W(\mathbf{c}) = \frac{1}{4\pi} \sum_{t} \Omega_t(\mathbf{c})$$
    其中对三角形 $(\mathbf{v}_0, \mathbf{v}_1, \mathbf{v}_2)$，令 $\mathbf{a} = \mathbf{v}_0 - \mathbf{c}, \mathbf{b} = \mathbf{v}_1 - \mathbf{c}, \mathbf{d} = \mathbf{v}_2 - \mathbf{c}$，$a = \|\mathbf{a}\|, b = \|\mathbf{b}\|, d = \|\mathbf{d}\|$，有向立体角为：
    $$\Omega_t(\mathbf{c}) = 2 \operatorname{atan2}\!\left(\mathbf{a} \cdot (\mathbf{b} \times \mathbf{d}), \; a b d + (\mathbf{a}\cdot\mathbf{b})d + (\mathbf{b}\cdot\mathbf{d})a + (\mathbf{d}\cdot\mathbf{a})b\right)$$
  - 判定规则：若 $|W(\mathbf{c})| \ge 0.5$，则该封闭分量 $C_r$ 整块标为 `SOLID_INTERIOR`（实体内部）；若 $|W(\mathbf{c})| < 0.5$，则整块标为 `EMPTY_CAVITY`（嵌套空腔）。
  - 所有封闭分量按其代表体素 $\mathbf{u}^*(C_r)$ 的字典序从 `0` 开始编号。

## 6. 8×8×8 分块增量更新与框选编辑
- 网格按坐标划分为 $B_x = \lceil N_x / 8 \rceil, B_y = \lceil N_y / 8 \rceil, B_z = \lceil N_z / 8 \rceil$ 个 $8 \times 8 \times 8$ 分块（Brick），分块 $(b_x, b_y, b_z)$ 覆盖 $i \in [8b_x, \min(N_x, 8b_x+8))$ 等。
- 支持两种交互编辑并记录到操作栈（支持撤销/重做）：
  1. **按组启停三角形（`TOGGLE_GROUP`）**：切换指定 `group` 的 `enabled` 状态。仅允许重算与该组三角形 AABB 相交的 $8 \times 8 \times 8$ 分块内的网格表面体素（其余分块的网格表面体素直接复用缓存），再叠加当前生效的框选编辑层并重算漫水与连通块分类。
  2. **轴对齐体素框选编辑（`BOX_CARVE` / `BOX_FILL`）**：对闭区间 $[i_0, i_1] \times [j_0, j_1] \times [k_0, k_1]$ 内的体素强制设为非表面空气（`BOX_CARVE`）或指定 `material`（`1..16`，`sourceTriangleId: -1`）的表面体素（`BOX_FILL`）。仅标记与该框相交的 $8 \times 8 \times 8$ 分块为脏块，更新后重算漫水与连通分类。

## 7. 导出统计 JSON 结构
导出 JSON 包含：
- `meshId`, `separatingMode`, `floodConnectivity`, `dims`, `spacing`
- `counts`: `{ "SURFACE": int, "EXTERIOR": int, "SOLID_INTERIOR": int, "EMPTY_CAVITY": int }`
- `materialHistogram`: 键为材质号 `"1".."16"`（仅含计数 `> 0` 的材质）的表面体素计数
- `diagonalLeaks`: 对角漏孔数组 `[{ "fromExterior": [i,j,k], "toEnclosed": [i,j,k] }, ...]`
- `enclosedComponents`: 按代表体素字典序排列的数组，每项含 `{ "componentId": 0, "type": "SOLID_INTERIOR" | "EMPTY_CAVITY", "voxelCount": int, "representativeVoxel": [i,j,k], "windingNumber": float }`
