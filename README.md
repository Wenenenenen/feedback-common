# 解析隐线工作台（Analytic Hidden-Line Desk）

纯前端、零依赖的模型隐线（hidden-line）导出工具。不使用像素深度采样，也不依赖任何
现成隐线库：所有可见/隐藏区间都在齐次裁剪空间与 NDC 中通过**解析几何**求出，
因此导出分辨率只改变坐标尺度，从不改变区间判定。

## 能力对照

| 需求 | 实现位置 |
| --- | --- |
| 导入 ≤5000 面索引网格 + 正交/透视相机 | `src/mesh.js` 校验、`src/app.js` 面数上限 |
| 边界 / 折痕 / 轮廓 / 非流形边识别（按索引建边、不焊接） | `src/mesh.js` |
| 六平面齐次裁剪（边与遮挡三角形都先裁剪） | `src/clipper.js` |
| 投影三角形 + 深度关系解析拆分可见区间 | `src/solver.js` |
| 相切/共面/自身相邻面/多遮挡重叠不产生假缺口 | 深度严格阈值 `1e-6`、关联面排除、区间并集 |
| 非流形边标记并保留 | `src/mesh.js` + SVG 红色组 |
| 相机旋转、折痕角调整、3D/2D 联动、点线看来源边/遮挡面/区间 | `src/app.js` |
| 可见实线 + 隐藏虚线 SVG、区间 JSON 导出 | `src/export.js` |
| 分辨率只改尺度不改判定 | 判定全程在 NDC/参数空间，测试逐位校验 |

## 算法契约（与 `samples/extracted/格式说明.md` 一致）

1. **相机**：`forward=normalize(target-origin)`，`right=normalize(cross(up,forward))`，
   实际 `up=cross(forward,right)`，视空间 Z 为正向距离。
2. **投影**：`0 ≤ z_clip ≤ w`。正交 `ndc_z=(z-near)/(far-near)`；
   透视 `ndc_z=far/(far-near) - far·near/((far-near)·z)`。
3. **正面判定**：正交 `dot(n,-forward)>1e-10`；透视 `dot(n,camera-center)>1e-10`。
4. **边分类**：1 关联面=边界；2 面且法线夹角 ≥ 折痕阈值=折痕；两面正/背状态不同=轮廓；
   >2 面=非流形。一条边可同时属于多类型。
5. **遮挡解析**：排除该边的全部关联面后，三角形双面遮挡；屏幕二维用
   Sutherland–Hodgman 求边-三角重叠的边参数 `u` 区间；NDC 深度对边、对三角形
   （二维重心插值）都是屏幕参数的一次函数，深度差 `D(u)` 解析求根；
   仅当三角形 NDC 深度严格小于边深度减 `1e-6` 时隐藏，等深保留可见。
6. **区间合并**：多遮挡片段取并集，记录遮挡面 ID 集合；零长度重叠不产生隐藏段。

## 目录

```
index.html            页面（可直接双击打开，也可用静态服务器）
src/
  math.js             向量/矩阵/法线
  camera.js           相机基架、视空间、齐次裁剪、NDC、屏幕映射
  clipper.js          六平面 Sutherland–Hodgman 齐次裁剪
  mesh.js             网格校验、拓扑建边、边分类
  solver.js           解析隐线求解（核心）
  export.js           SVG / JSON 导出
  samples.js          内置样例（由 tools/build-samples.js 生成）
  app.js              UI、轨道相机、Canvas/SVG 渲染、拾取、导出
tools/build-samples.js 从 samples/extracted 重新生成 src/samples.js
test/
  run-tests.js        算法单元测试（含 reference.json 标准答案）
  robustness.js       边界/对抗用例 + 5000 面性能 + 分辨率独立性
  browser-smoke.js    Playwright 浏览器端到端冒烟
```

## 运行

无需构建、无需安装依赖：

```bash
# 直接打开 index.html 即可；如浏览器限制本地脚本，用静态服务器：
python3 -m http.server 8000
# 访问 http://localhost:8000/
```

## 测试

```bash
node test/run-tests.js        # 17 项：reference 标准答案、分类、裁剪、分辨率不变性
node test/robustness.js       # 25 项：相切/共面/穿透/非流形/视轴边/5000 面性能
NODE_PATH=$(npm root -g) node test/browser-smoke.js   # 19 项浏览器冒烟（需全局 Playwright）
node tools/build-samples.js samples/extracted src/samples.js
```

`reference.json` 的三组标准答案（single-occluder `[0.375,0.625]`、
overlapping-occluders 并集 `[0.375,0.825]`、coplanar 无隐藏）在单元测试中
以 `1e-6` 容差逐位校验。

## 输入格式

```json
{
  "positions": [[x, y, z]],
  "triangles": [[i0, i1, i2]],
  "camera": {
    "type": "orthographic | perspective",
    "origin": [..], "target": [..], "up": [..],
    "near": 0.1, "far": 10, "aspect": 1.333,
    "height": 4,
    "fov_y": 70
  },
  "crease_degrees": 45
}
```

正交使用 `height`，透视使用 `fov_y`。顶点索引越界、退化三角形、面数超限等
情况会在页面左侧给出明确错误或警告，不静默吞掉。
