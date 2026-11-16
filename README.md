# 实例化射线拾取 × 双层 BVH 校验台

用于校验"同一模型大量实例化（含缩放/镜像）后射线拾取结果与加速结构正确性"的单页工具。
核心（求交、BLAS/TLAS 两层 BVH、等距裁定）全部自实现，未使用任何现成 Raycaster / BVH 库。

## 运行

无需构建，直接用任意静态服务器打开：

```bash
python3 -m http.server 8123
# 浏览器访问 http://127.0.0.1:8123/
```

页面为纯静态（file:// 直接打开 index.html 也可工作，样例数据已内嵌）。

## 功能

- **场景**：内置样例（即 `samples/instance-ray-bvh-cases.zip` 内容，已解压至 `samples/instance-ray-bvh-cases/`）、
  非法仿射矩阵样例，或上传自己的 `scene.json` / `rays.json` / `expected.json`。
  上限 2000 实例、每网格 2 万面，超限报错/截断。
- **拾取**：视口点击发射世界射线，返回命中实例、原面号、世界距离 t、重心坐标（按原 faces 顶点顺序）、
  命中位置、按世界顶点绕叉积单位化的法线（不向射线翻转）。三角形双面可拾取。
  等距裁定：先取最小 t，在 `[tmin, tmin+1e-7]` 内按实例 id 字典序、面号升序取唯一结果。
- **可视化**：射线路径（红）、命中点（黄叉）、世界法线（绿）、本次查询访问的包围盒
  （黄=TLAS，青=BLAS，按实例矩阵变换为 OBB）、选中实例 AABB（绿框）。
  被排除的奇异/非法实例以半透明红色渲染并列出原因。
- **批量比对**：对 rays.json 全部射线同时跑 BVH 查询与逐三角穷举，并与 expected.json 对照
  （含场景级 `singular_excluded` / `unique_blas`）。统计 TLAS/BLAS 包围盒测试次数、
  三角测试次数（BVH vs 穷举）与耗时。分片执行，可取消；取消后部分结果直接丢弃，不生成报告。
- **实例矩阵编辑**：修改实例矩阵只重建 TLAS，共享网格的 BLAS 不重建（面板实时显示两者构建次数可核对）。
  奇异（行列式为 0）或末行非 `[0,0,0,1]` 的实例被列出并排除，不影响场景其余部分。
- **报告导出**：报告绑定生成时的场景版本号（revision）与内容指纹（hash）。
  此后一旦编辑场景或取消批量运行，旧报告即标记"已失效"并禁止导出，不能冒充当前结果。

## 数据格式

- 实例矩阵：16 元素**行主序**仿射矩阵，作用于列向量，末行必须 `[0,0,0,1]`。
- 射线：世界坐标，`direction` 非零，内部归一化后求交，`t>=0` 为世界米制距离。
- 同一 `mesh` 名的实例共享一份三角网格与一份 BLAS（`unique_blas` 可核对）。

## 文件

```
index.html          页面
css/style.css       样式
js/core.js          核心：数学、BVH 构建/遍历、求交、裁定、场景管理（浏览器/Node 通用）
js/app.js           UI、WebGL2 渲染（仅展示，不参与求交）
js/sample-data.js   内嵌样例数据
test/run-tests.cjs  Node 校验：BVH vs 穷举 vs samples 的 expected.json
samples/instance-ray-bvh-cases/  解压后的样例（scene/rays/expected/invalid-affine/说明）
```

## 校验

```bash
node test/run-tests.cjs
```

对照样例包 `expected.json`：260 条射线 BVH 与穷举结果完全一致且符合期望，
实例矩阵更新只重建 TLAS，奇异/非法矩阵实例被排除。
