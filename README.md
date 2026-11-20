# Boxed Hermite 提取器

盒约束单顶点等值面提取工具。输入是前序采样给出的网格节点符号、物理间距和每条异号边的 Hermite 数据（交点参数 t、世界法线），输出是一张等值面三角网格和一份逐单元诊断。

## 快速开始

```bash
node tools/prepare-data.js     # 从 samples/extracted/ 生成 data/ 与内嵌样例
node tools/build.js            # 生成 dist/artifact.html 与 dist/boxed-hermite-extractor.html
node tools/serve.js 4173       # 静态服务 dist/，浏览器打开 http://localhost:4173/
node --test tests/core.test.js # 核心算法回归
node tools/check.js samples/extracted  # 对照 expected.json 的拓扑与解析探针
```

`dist/boxed-hermite-extractor.html` 是可单独打开的完整文档；`dist/artifact.html` 是去掉文档外壳的正文片段，适合由宿主自带骨架的发布方式。两者都是自包含的：较大的四个样例优先按相对路径读取 `data/samples/*.json`，读取不到（例如 `file://` 直接打开或只复制了单个 HTML）时回退到页面内嵌的副本。

## 约定要点

- **输入**：`dims` 每轴 2–33 个节点；`origin` 为节点 `[0,0,0]` 的世界坐标；`spacing` 为逐轴正物理间距；`signs` 按 x 最快、再 y、再 z 展平，只允许 `-1`（实体内）与 `1`；`edges` 每条含 `axis`、`node`（沿轴较小端）、`t ∈ (0,1)`、`normal`。
- **校验**：每条异号边必须恰好有一条记录，同号边不得有记录。缺失、重复、越界、零法线、非有限值都会报出 `edges[i]` 或 `edges[i].field` 形式的字段位置。
- **顶点**：一个混合单元只产生一个顶点，位于闭单元盒内

  ```
  F(x) = Σ_e (n̂_e · (x − h_e))² + λ‖x − c‖²
  ```

  的全局最小点，其中 `h_e` 为交点、`n̂_e` 为单位法线、`c` 为交点均值。求解对 27 种活动集做精确枚举，并对每个约化系统解 3×3 正定方程；不使用逐轴夹取，也不以 `c` 代替。默认 `λ = 1e-3`，可调 `1e-6 … 1`。
- **连接**：每条有完整 4 个相邻单元的异号网格边连成一个四边形，按约定顺序绕行、固定拆成 `ABC` 与 `ACD`。缺邻接时跳过并计入边界穿越，不封口、不焊点。
- **统计**：三角形无向边被 1 个面使用记为边界边，被 3 个及以上使用记为非流形边。该单顶点规则不保证流形，统计如实给出。
- **空输入**：全部同号时正常导出空网格，诊断 JSON 仍含零计数与网格信息。

## 界面

- 三维视图：拖拽旋转、Shift 拖拽平移、滚轮缩放；线框、等值面、单元盒、交点、法线、无约束解、拓扑问题各自可切换。
- 切层视图：按 x/y/z 轴选层，显示该层的符号分布、混合单元、层内交点与已编辑边；「聚焦选中」把视野收拢到选中单元附近；点击单元或交点会联动三维视图与检查器。
- 检查器：最终解、无约束解、交点均值、总目标与数据项/正则项分解、逐轴活动约束（下界/自由/上界）、平面残差表。
- 选中单元详图：正交投影的单元盒、交点、法线、无约束解和最终解。
- 共享边编辑：改动 t 或法线后立即重算所有相关单元；单条或全部恢复导入值。
- 导出：OBJ 与诊断 JSON 都可复制或下载（下载在部分受限查看器中不可用，复制始终可用）。

## 诊断 JSON

```jsonc
{
  "format": "boxed-hermite-diagnostics",
  "version": 1,
  "lambda": 0.001,
  "grid": { "dims": [...], "origin": [...], "spacing": [...] },
  "counts": { "vertices": 0, "triangles": 0, "boundary_crossings": 0, "boundary_edges": 0, "nonmanifold_edges": 0 },
  "vertices": [[x, y, z], ...],
  "triangles": [[a, b, c], ...],
  "cells": [
    {
      "cell": [i, j, k],
      "position": [x, y, z],          // x*
      "unconstrained": [x, y, z],     // 无约束解
      "active_axes": ["lower", "free", "upper"],
      "data_error": 0.0,              // Σ r²
      "objective": 0.0,               // 数据项 + 正则项
      "regularization": 0.0,
      "edge_keys": ["x:0,0,0", ...],
      "max_abs_residual": 0.0,
      "residuals": [
        { "axis": "x", "node": [..], "t": 0.5, "residual": 0.0, "squared": 0.0,
          "normal": [..], "hit": [..] }
      ]
    }
  ],
  "errors": [ { "code": "zero-normal", "field": "edges[0].normal", "message": "...", "edge": {...} } ],
  "edited_edges": [ { "key": "...", "t": ..., "normal": [...], "imported_t": ..., "imported_normal": [...] } ]
}
```

`cells` 与 `vertices` 同序。输入无效时 `cells` 为空，`errors` 给出逐条问题的字段位置。

## 目录

```
src/core.js            校验、盒约束求解、提取、OBJ/诊断序列化（无依赖）
src/viewer.js          三维、切层、单元详图三个 Canvas 视图
src/app.js             界面状态与交互
src/styles.css         视觉与主题
src/samples-inline.js  内嵌的小样例（由 prepare-data 生成）
tools/prepare-data.js  样例打包
tools/build.js         生成 dist/
tools/serve.js         本地静态服务
tools/check.js         与 expected.json 对照
tests/core.test.js     node:test 回归
samples/extracted/     原始样例 JSON 与 expected.json
dist/                  构建产物
```
