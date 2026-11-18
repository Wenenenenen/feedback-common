# 切线空间法线检查器（tangent-frame-auditor）

检查镜像 UV / 负缩放实例导致的凹凸方向反转问题。按 `samples/tangent-frame-auditor-cases.zip`
内《格式说明》的规则自行实现逐角切线与手性计算，不调用任何现成切线生成或法线映射接口
（原生 WebGL + 自写着色器，零依赖）。

## 运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

（ES modules 需要 http 协议，直接双击 index.html 无法加载。）

## 功能

- **导入**：场景 JSON（positions / faces.v / faces.uv / faces.n，≤10000 面）+ RGB 法线 PNG
  （≤512×512，不做 sRGB 解码，2·byte/255−1，零向量回退 [0,0,1]；UV 原点左下、最近邻、钳位）。
- **切线计算**：UV 雅可比原始 T/B → 按（位置索引， UV 值， 法线值， UV 行列式符号）分组、
  三维内角弧度加权累计 → Gram-Schmidt → h = sign(dot(cross(N,T),B))（零取 +1）。
  |UV det| ≤ 1e-10 的面不参与累计；投影后 |T| ≤ 1e-10 时取 N 绝对分量最小的坐标轴
  （同值 X→Y→Z）投影回退，h=+1 并出诊断。镜像 UV 接缝天然分入不同组、分开累计。
- **联动视图**：3D 网格（几何法线 / 切线法线 / 手性 h / UV 手性四种着色，固定方向光）、
  UV 视图（蓝=正向、橙=镜像）、选中角的 TBN 坐标轴与数值表（原始 → 实例后）。
- **实例变换**：平移、旋转（X→Y→Z 欧拉角）、非零非均匀缩放（0 自动钳位）。
  N 按逆转置、T 按线性部分变换后重新正交化、h 乘线性行列式符号、B = h·cross(N,T)，
  负行列式（镜像实例）下方向保持正确。
- **重算预览**：法线贴图原图、当前选中角 TBN 的逐像素重算光照、h 取反对比图。
- **导出/复现**：导出逐角 T、h、实例后基向量与诊断的 JSON（内嵌 PNG 数据）；
  重新导入时自动重算并做复现校验。
- **自检**：一键对照 `cases/reference.json` 跑全部样例（plane / mirror / mirror-instance /
  zero-uv / cancelling 的 T 与 h，cancelling 的回退角，invalid-normal 的拒绝，
  angle-weight / shared-mirror 的健壮性）。

## 文件

- `index.html` / `css/style.css` — 页面
- `js/math.js` — 向量/矩阵（行主序，列向量约定）
- `js/tangent.js` — 逐角切线、手性、实例变换（核心规则）
- `js/normalmap.js` — PNG 解码与采样
- `js/io.js` — 场景校验（≤10000 面 / ≤512² 贴图 / 非零法线）、导出、复现校验
- `js/view3d.js` — WebGL 视图（切线变换与法线映射在自写着色器内完成）
- `js/uvview.js` / `js/preview.js` — UV 视图 / 重算预览
- `cases/` — 样例包解压出的测试用例与 `reference.json`
