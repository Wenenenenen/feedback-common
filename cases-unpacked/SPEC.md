# Mirror Beam Clipper 格式与判定约定 (SPEC)

## 1. 输入场景 JSON 结构
```json
{
  "sceneId": "string",
  "camera": {
    "eye": [0.0, 1.5, 6.0],
    "target": [0.0, 1.5, 0.0],
    "up": [0.0, 1.0, 0.0],
    "fovYDeg": 60.0,
    "near": 0.2,
    "far": 80.0,
    "width": 160,
    "height": 120
  },
  "maxBounceDepth": 3,
  "beamBudgetK": 8,
  "mirrors": [
    {
      "id": "M1",
      "enabled": true,
      "reflectance": [0.9, 0.92, 0.95],
      "vertices": [[-2.0, 0.0, 0.0], [2.0, 0.0, 0.0], [2.0, 3.0, 0.0], [-2.0, 3.0, 0.0]]
    }
  ],
  "vertices": [[0.0, 0.0, 0.0]],
  "triangles": [
    {
      "id": 0,
      "indices": [0, 1, 2],
      "color": [0.85, 0.3, 0.25],
      "singleSided": true
    }
  ]
}
```

## 2. 合法性校验规则
导入或编辑时必须首先执行以下校验；若任一项不合法，必须拒绝加载并指出具体 `mirror.id` 或 `triangle.id` 及原因，同时保留当前已加载的有效场景状态：
1. **画布与参数范围**：`width` in [16, 320]，`height` in [16, 240]，`0 < near < far`，`fovYDeg` in (5, 170)，`maxBounceDepth` in [0, 4]，`beamBudgetK` in [1, 32]，`mirrors.length <= 16`，`triangles.length <= 4000`。
2. **镜面校验**：
   - 顶点数在 `[3, 8]` 之间，所有坐标为有限浮点数；
   - `reflectance` 为长度为 3 的数组，每个分量在 `[0.0, 1.0]` 内；
   - 设 $\mathbf{v}_0, \mathbf{v}_1, \dots, \mathbf{v}_{m-1}$ 为镜面顶点，法向量 $\mathbf{N} = \sum_{i=0}^{m-1} (\mathbf{v}_i - \mathbf{v}_0) \times (\mathbf{v}_{(i+1)\bmod m} - \mathbf{v}_0)$，面积 $A = \frac{1}{2}\|\mathbf{N}\| > 10^{-7}$（否则报零面积退化镜面），单位正面法线 $\mathbf{n}_m = \mathbf{N} / \|\mathbf{N}\|$；
   - **共面性**：所有顶点到平面 $(\mathbf{v}_0, \mathbf{n}_m)$ 的绝对距离 $|(\mathbf{v}_i - \mathbf{v}_0) \cdot \mathbf{n}_m| \le 10^{-5}$，否则报非共面镜面；
   - **严格凸性**：对于任意连续三顶点 $(\mathbf{v}_{i-1}, \mathbf{v}_i, \mathbf{v}_{i+1})$，边叉积 $((\mathbf{v}_i - \mathbf{v}_{i-1}) \times (\mathbf{v}_{i+1} - \mathbf{v}_i)) \cdot \mathbf{n}_m > 10^{-8}$，且边不自交，否则报非凸镜面。
3. **三角形校验**：
   - `indices` 三个整数均在 `[0, vertices.length - 1]` 内，否则报越界索引；
   - 三角形面积 $\frac{1}{2}\|(\mathbf{b}-\mathbf{a})\times(\mathbf{c}-\mathbf{a})\| > 10^{-9}$，否则报零面积退化三角形；
   - `color` 三个分量均在 `[0.0, 1.0]` 内。

## 3. 相机坐标系与主视锥
- 设主相机位置 $\mathbf{e}_0 = \text{eye}$，前向单位向量 $\mathbf{f}_0 = \frac{\text{target} - \text{eye}}{\|\text{target} - \text{eye}\|}$，右向 $\mathbf{r}_0 = \frac{\mathbf{f}_0 \times \text{up}}{\|\mathbf{f}_0 \times \text{up}\|}$，上向 $\mathbf{u}_0 = \mathbf{r}_0 \times \mathbf{f}_0$。
- 任意世界点 $\mathbf{x}$ 在主相机空间坐标为 $(x_c, y_c, z_{\text{view}})$，其中：
  $$x_c = (\mathbf{x} - \mathbf{e}_0)\cdot \mathbf{r}_0, \quad y_c = (\mathbf{x} - \mathbf{e}_0)\cdot \mathbf{u}_0, \quad z_{\text{view}} = (\mathbf{x} - \mathbf{e}_0)\cdot \mathbf{f}_0$$
  这里 $z_{\text{view}} > 0$ 为主相机前向线性深度。
- 设 $t = \tan(\text{fovYDeg} \cdot \pi / 360)$，$a = \text{width} / \text{height}$。主视锥的 6 个裁剪半空间为：
  - 近裁面：$z_{\\text{view}} \ge \text{near}$；远裁面：$z_{\text{view}} \le \text{far}$；
  - 左/右/下/上裁面：$x_c \ge -a t z_{\text{view}}$，$x_c \le a t z_{\text{view}}$，$y_c \ge -t z_{\text{view}}$，$y_c \le t z_{\text{view}}$。
- 屏幕像素坐标映射：对 $z_{\text{view}} > 0$ 的点，归一化坐标 $x_{\text{ndc}} = \frac{x_c}{a t z_{\text{view}}}$，$y_{\text{ndc}} = \frac{y_c}{t z_{\text{view}}}$；画布坐标为：
  $$u = \frac{x_{\text{ndc}} + 1}{2} \cdot \text{width}, \quad v = \frac{1 - y_{\text{ndc}}}{2} \cdot \text{height}$$
  像素 $(i, j)$（$0 \le i < \text{width}, 0 \le j < \text{height}$）的采样中心为 $(i + 0.5, j + 0.5)$。

## 4. 逐层反射视束展开与三维多边形裁剪
- 根视束 $b_0$（层数 $d=0$，路径 `[]`）：虚相机 $\mathbf{e}_0 = \text{eye}$，累计反射变换矩阵 $\mathbf{M}_0 = \mathbf{I}_4$，累计反射率 $\mathbf{R}_0 = (1, 1, 1)$。
- 设当前视束 $b$ 位于层数 $d$（$0 \le d < \text{maxBounceDepth}$），路径为 $[m_1, \dots, m_d]$，当前世界空间虚相机为 $\mathbf{e}_d$，把当前视束内真实世界点展开到主相机世界坐标的累计反射矩阵为 $\mathbf{M}_d$，当前视束在父镜面 $m_d$ 上的三维裁剪窗口凸多边形为 $\mathcal{P}_d = (\mathbf{q}_0, \dots, \mathbf{q}_{k-1})$。
- 对每个 `enabled == true` 的镜面 $m$（若 $d \ge 1$，要求 $m.\text{id} \ne m_d.\text{id}$，禁止紧邻自反射）：
  1. **虚相机正面判定**：计算有向距离 $h = (\mathbf{e}_d - \mathbf{v}_{m,0}) \cdot \mathbf{n}_m$。仅当 $h > 10^{-6}$ 时当前虚相机位于镜面 $m$ 的正面，否则跳过。
  2. **三维凸多边形裁剪（Sutherland-Hodgman）**：取镜面 $m$ 的原始世界顶点序列：
     - 若 $d = 0$：将顶点变换到主相机空间，依次对主视锥的 6 个半空间裁剪；
     - 若 $d \ge 1$：
       (a) 对父镜面 $p = m_d$ 的正面半空间裁剪：保留满足 $(\mathbf{x} - \mathbf{v}_{p,0}) \cdot \mathbf{n}_p \ge 10^{-6}$ 的部分；
       (b) 对由虚相机 $\mathbf{e}_d$ 与父窗口 $\mathcal{P}_d$ 各有向边 $(\mathbf{q}_i, \mathbf{q}_{(i+1)\bmod k})$ 构成的 $k$ 个视束侧平面裁剪：设侧平面内法线 $\mathbf{s}_i = (\mathbf{q}_i - \mathbf{e}_d) \times (\mathbf{q}_{(i+1)\bmod k} - \mathbf{e}_d)$（方向指向 $\mathcal{P}_d$ 内部，即 $\mathbf{s}_i \cdot (\mathbf{c}_{\mathcal{P}_d} - \mathbf{e}_d) > 0$），保留 $(\mathbf{x} - \mathbf{e}_d) \cdot \mathbf{s}_i \ge 0$；
       (c) 将点经 $\mathbf{M}_d$ 展开到主相机空间后，对主视锥的 6 个半空间裁剪。
  3. 若裁剪后顶点数 $< 3$ 或三维多边形面积 $\le 10^{-7}$，则该子视束为空，予以剪枝。
  4. 否则生成非空候选反射子视束 $b'$（层数 $d+1$，路径 $[m_1, \dots, m_d, m.\text{id}]$）：
     - 新窗口多边形 $\mathcal{P}_{d+1}$ 为裁剪所得凸多边形；
     - 新虚相机位置 $\mathbf{e}_{d+1} = \mathbf{e}_d - 2 h \mathbf{n}_m$；
     - 镜面 $m$ 的反射仿射变换为 $\mathbf{H}_m(\mathbf{x}) = \mathbf{x} - 2((\mathbf{x} - \mathbf{v}_{m,0})\cdot \mathbf{n}_m)\mathbf{n}_m$；
     - 新累计展开矩阵 $\mathbf{M}_{d+1} = \mathbf{M}_d \mathbf{H}_m$；
     - 新累计反射率 $\mathbf{R}_{d+1} = \mathbf{R}_d \odot m.\text{reflectance}$。

## 5. 视束得分与树前缀闭合配额求解
- 对每条非空候选反射视束 $b$（层数 $d \ge 1$）：
  - 将其三维裁剪窗口 $\mathcal{P}_b$ 的各顶点 $\mathbf{q}_i$ 经 $\mathbf{M}_{d-1}$ 变换到主相机空间并投影到画布坐标 $(u_i, v_i)$，计算二维凸多边形屏幕面积 $A_{\text{screen}}(b)$（单位：平方像素）。
  - 亮度权重 $L(b) = 0.2126 R_{b,0} + 0.7152 R_{b,1} + 0.0722 R_{b,2}$。
  - 视束整数得分定义为：
    $$\text{score}(b) = \operatorname{round}(A_{\text{screen}}(b) \cdot L(b) \cdot 1000)$$
- 当所有非空候选反射视束总数超过 `beamBudgetK`（记为 $K$）时，必须从候选反射视束树中选出子集 $\mathcal{S}$：
  1. $|\mathcal{S}| \le K$；
  2. **树前缀闭合约束**：若 $b \in \mathcal{S}$ 且 $b$ 的层数 $d \ge 2$，则 $b$ 的父反射视束 $\text{parent}(b)$ 必须也在 $\mathcal{S}$ 中；
  3. **目标函数**：最大化总得分 $\sum_{b \in \mathcal{S}} \text{score}(b)$；
  4. **并列打破规则**：若两个合法子集总得分相同，优先选包含视束条数 $|\mathcal{S}|$ 较大者；若仍相同，将各子集内的视束路径按字典序排成有序列表后，取字典序较小的子集。

## 6. 斜近裁面、奇数次绕序翻转与层次遮挡光栅化
- 在任一激活视束 $b$（根视束 $d=0$ 恒激活；$d \ge 1$ 当且仅当 $b \in \mathcal{S}$ 时激活）内：
  1. **单面三角形朝向与绕序**：
     - 对真实世界顶点为 $(\mathbf{a}, \mathbf{b}, \mathbf{c})$ 的三角形，其真实世界几何法线为 $\mathbf{n}_t = (\mathbf{b} - \mathbf{a}) \times (\mathbf{c} - \mathbf{a})$。
     - 若 `singleSided == true`，该三角形在视束 $b$ 中可见当且仅当当前虚相机 $\mathbf{e}_d$ 位于其正面：$(\mathbf{e}_d - \mathbf{a}) \cdot \mathbf{n}_t > 0$。由于 $\det(\mathbf{M}_d) = (-1)^d$，在奇数次反射（$d=1, 3$）下，将顶点经 $\mathbf{M}_d$ 变换到主相机空间后的屏幕二维有向面积符号会翻转，背面剔除必须相应翻转符号判据。
  2. **镜面斜近裁面与视束棱锥裁剪**：
     - 当 $d \ge 1$ 时，三角形（以及子镜面）在真实世界空间中必须先对当前镜面 $m_d$ 的正面半空间 $(\mathbf{x} - \mathbf{v}_{m_d,0}) \cdot \mathbf{n}_{m_d} \ge 10^{-6}$ 裁剪（严禁将镜面背后的几何画入反射），并对 $\mathbf{e}_d$ 与窗口 $\mathcal{P}_b$ 构成的视束侧平面裁剪；再经 $\mathbf{M}_d$ 展开至主相机空间裁剪并投影光栅化。
  3. **父子镜面层次像素遮挡与光程深度比较**：
     - 对画布每个像素中心 $(i+0.5, j+0.5)$，在激活视束 $b$（层数 $d$）中，该像素处的可见表面由本视束内的不透明场景三角形与本视束的激活子镜面窗口 $\mathcal{P}_{b'}$ 共同竞争本视束内的最近展开前向线性深度 $z_{\text{view}}$：
       - 若在视束 $b$ 中，某激活子镜面 $m_{d+1}$（对应子视束 $b'$）在该像素处的展开深度 $z_{\text{mirror}}$ 被本视束内更近的场景三角形（$z_{\text{tri}} \le z_{\text{mirror}}$）或本视束内更近的另一子镜面挡住，则该像素在子视束 $b'$ 及其所有后代视束中均被遮挡，不得写入；
       - 若未被遮挡且射线穿过激活子镜面窗口 $\mathcal{P}_{b'}$，则递归进入子视束 $b'$ 求取反射表面；若子视束 $b'$ 内无场景三角形或子镜面命中，该像素落在该镜面底色 `0.12 * R_{b'}` 上（展开深度记为 $z_{\text{mirror}}$，`triangleId: null`）。
     - 同一视束内深度并列（$|z_1 - z_2| \le 10^{-6}$）时，依次优先取反射层数 $d$ 较小者、图元 `id` 较小者。
     - 命中三角形 $t$ 在视束 $b$（层数 $d$）的最终线性 RGB 颜色为 $\min(1.0, t.\text{color} \odot \mathbf{R}_d)$，按 $\operatorname{round}(c \cdot 255)$ 转为 8 位整数显示。

## 7. 导出结果 JSON 结构
导出 JSON 包含：
- `sceneId`, `maxBounceDepth`, `beamBudgetK`
- `candidateBeamCount`: 非空候选反射视束总数（不含 $d=0$）
- `selectedBeamCount`: 选中的激活反射视束数
- `totalSelectedScore`: 选中反射视束的总得分
- `selectedBeams`: 按路径字典序排列的数组，每项含 `{ "path": ["M1", ...], "depth": 1, "score": 1234, "virtualEye": [x,y,z], "clippedPolygon": [[x,y,z], ...] }`
