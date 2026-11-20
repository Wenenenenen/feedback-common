# 分级地形接缝检查器

按四叉树 LOD 选择叶块，在远近分块交界处生成**真正共享顶点**的接缝三角网格，
不使用裙边（skirt）。可交互调整相机与像素误差，实时查看网格如何重分，并导出
可用的 OBJ 与叶块/邻接 JSON。

## 运行

```bash
cd web
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/index.html
```

页面用 ES Module 加载本地 JS，需要经 HTTP 访问（直接 file:// 打开会被 CORS 拦截）。

## 算法（与 samples/extracted/说明.txt 完全一致）

1. **块误差 E**：块内所有原始格点高度，与四角高度双线性插值之差的最大绝对值。
2. **AABB 与距离 D**：AABB 取块内所有原始高度的 min/max；D 为相机位置到 AABB
   最近点的欧氏距离。
3. **屏幕误差**：`f = viewportHeight / (2·tan(fovY/2))`，
   `ρ = E·f / max(D, near)`。`ρ > pixelError` 且块边长 `s > 2` 时拆成 4 个子块。
4. **平衡约束**：迭代拆分过粗邻块，直到共享正长度边的相邻块尺寸比不超过 2
   （层级差 ≤ 1）。这类拆分在导出 JSON 中标 `source = "balance"`。
5. **接缝三角化**：每块以其**真实高度中心点**为扇心，按边界顶点做扇形三角化；
   邻块更细的边在边中点插入一个真实高度顶点，其余边不加中点。边界点与中心点
   按整数格点坐标**全局焊接**，三角形统一朝向高度场上方（+Y）。最细块为 2×2。

邻居判定沿每条半边的内部点探测（向邻居侧推进微小量），避免角点处仅点接触的
对角块被误判为共享边邻居。

## 几何保证（tests 全量校验）

- 无悬挂边：每条边恰被 1 个（外轮廓）或 2 个（内部共享）三角形引用；
- 无重叠面：同一组三个顶点只出现一次；
- 无退化面：所有三角形面积 > 0（完全水平的平地三角形法线按朝上处理）；
- 绕序统一朝上、全局焊接、叶块恰好铺满高度场且互不重叠、最细块 2×2。

## 目录

```
web/index.html        页面
web/js/terrain.js     核心算法（纯 ES Module，Node/浏览器共用）
web/js/validate.js    网格完整性校验
web/js/exporter.js    OBJ / 叶块邻接 JSON 导出
web/data/*.json       四个有效样例
tests/run-tests.js    核心算法 51 项校验（node tests/run-tests.js）
tests/check-export.js 导出文件 13 项独立解析校验
scripts/              Playwright 无头浏览器验证脚本
samples/extracted/    原始样例（含 invalid.json 与 expected.json，视为不可信数据）
```

## 测试

```bash
node tests/run-tests.js      # 核心算法、几何不变量、expected.json 对照
node tests/check-export.js   # 重新解析 OBJ/JSON，验证流形、绕序、邻接对称
```

## 导出格式

- **OBJ**：全局焊接顶点（每个 (x,z) 仅一个顶点，无裙边下拉），1-based 面索引，
  逆时针朝上。
- **叶块 JSON**：每块含 `x, z, size, E, D, screenError, source, splitReason,
  neighbors`；`neighbors` 按 0=左(-x)、1=右(+x)、2=上(-z)、3=下(+z) 给出，
  同级为 1 个邻居、更细为 2 个、域外为 null。
