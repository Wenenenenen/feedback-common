# Separating Voxel Foundry

三角网格**保守体素化**与**空腔壳层核对**网页。严格按 `samples/extracted/SPEC.md` 的判定约定实现，
不使用任何现成体素化或三维引擎库（SAT、点-三角形距离、绕数、投影渲染全部手写）。

## 运行

```bash
cd app
python3 -m http.server 8123
# 浏览器打开 http://localhost:8123/index.html
```

纯静态页面，零外部依赖、零构建。也可直接用浏览器打开 `app/index.html`。

## 目录结构

```
app/
├── index.html            # 页面骨架
├── css/style.css
├── data/samples.js       # 4 个内置样例（由 samples/*.json 生成）
├── js/
│   ├── math3d.js         # 点-闭合三角形距离²（Ericson 5.1.5）、Van Oosterom 立体角/绕数
│   ├── validate.js       # SPEC §2 合法性校验（逐条报错、保留原结果）
│   ├── engine.js         # 13 轴 SAT 体素化、漫水、漏孔定位、绕数分类、8³ 分块增量、撤销栈
│   ├── sliceview.js      # 三轴切片 Canvas 渲染与框选交互
│   ├── view3d.js         # 手写正交投影 + 画家算法三维预览（自动 LOD）
│   └── app.js            # 页面控制器
└── tests/
    ├── node-test.js      # 无头引擎测试（Node，46 项）
    └── browser-smoke.js  # Playwright 浏览器端冒烟测试
```

## 核心算法与 SPEC 对应

| SPEC 条目 | 实现 |
|---|---|
| §3 各向异性 13 轴 SAT | 轴向量与 Σ\|a\|h / max\|a\|h 半径按三角形物理边预计算，体素内只做点积投影 |
| §3 6 分离薄壳 | 主法线轴 `u*=argmax|n_u|h_u`（并列取 x,y,z）；平面半径取 max，仅 `u=u*` 的 9 个边叉轴用薄半径 |
| §4 多材质归属 | 精确三维物理欧氏距离²（含三角形内部/边/顶点），1e-11 并列 → 材质号小 → 面 id 小，与输入顺序无关 |
| §5 外部漫水 | 外边界非表面体素为种子，6 或 26 邻域 BFS |
| §5 对角漏孔 | 6 分离 + 26 漫水时对照 6 连通 E6/I6，枚举 26 对角邻居，并在最小子盒内做 6 连通 BFS 验证桥接格被 SURFACE 堵死，字典序输出 |
| §5 封闭分量分类 | 非表面剩余体素按 **6 连通**分块，字典序首体素中心算广义绕数 W，\|W\|≥0.5 为 SOLID_INTERIOR 否则 EMPTY_CAVITY |
| §6 8³ 分块增量 | 编辑只标脏相交 Brick，脏块内重新表面化后重放框选层，再全网格重算漫水/分类；`VF.verifyIncremental` 与全量重算逐体素比对 |
| §7 导出 | 统计计数、材质直方图、漏孔数组、带绕数的封闭分量数组 |

## 交互功能

- **三轴切片**：X/Y/Z 切片滑块，表面按材质着色，漏孔红点，悬停查看体素类别/材质/来源面/d²
- **三维预览**：左键旋转、Shift 拖拽平移、滚轮缩放、双击复位；类别过滤、三角形线框、漏孔独立标记；面数超预算自动降级精灵 LOD
- **分组启停**：侧栏勾选，按组 AABB 相交的 8³ 分块增量重算
- **框选挖空/填充**：切片上左键拖拽矩形，CARVE 强制空气或 FILL 指定 1..16 材质表面
- **撤销/重做**：每次编辑保存脏块掩码 + 启停状态 + 框选层快照
- **一致性自检**：按钮触发增量结果 vs 全量重算逐体素比对
- **导入/导出**：非法 JSON 拒绝并列出具体字段或 `triangle.id` 与原因，当前有效结果保留；导出 SPEC §7 统计 JSON

## 校验与性能

```bash
node app/tests/node-test.js          # 46 项：样例、归属顺序无关、漏孔、嵌套绕数、编辑一致性、非法输入
node app/tests/browser-smoke.js      # 需先启动 http server 与全局 playwright
```

实测（浏览器 Chromium / Node，96³ 网格 + 10000 三角形碎片、非等距 spacing）：

| 场景 | 耗时 |
|---|---|
| 6 分离薄壳 + 26 漫水 全量 | ~0.4–0.5 s |
| 26 分离厚壳 + 6 漫水 全量 | ~0.55–0.65 s |
| 预算上限 | 2 s |

## 样例说明

- `case1_anisotropic_prism`：非等距网格双棱柱，26 分离厚壳，两种材质归属
- `case2_hollow_double_shell`：双层方壳，内空腔 W=0 判 EMPTY_CAVITY、壳间 W=1 判 SOLID_INTERIOR
- `case3_slanted_thin_wall`：45° 斜墙棱柱，6 分离薄壳 + 26 漫水（该几何下 SPEC 公式 r6=r26，墙厚 2 体素，无对角漏孔，用于对照）
- `case4_steep_anisotropic_leak`：30° 陡峭斜壳 + 非等距间距，6 分离 + 26 漫水产生 288 对对角漏孔，厚壳模式漏孔归零
