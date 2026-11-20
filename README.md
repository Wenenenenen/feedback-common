# 贴花体积裁剪器

展厅模型标识贴花的体积裁剪网页工具：把索引三角网格按投射盒（任意仿射，含非均匀缩放与剪切）裁剪生成贴花网格，解决贴花跨三角面露出方形边缘、负缩放实例贴花朝向反转的问题。

## 运行

```bash
python3 -m http.server 8919
# 打开 http://127.0.0.1:8919/index.html
```

（需联网加载 Three.js CDN；也可直接拖入场景 JSON 使用。）

## 功能

- **导入**：场景 JSON（`meshes` 局部顶点+三角形索引、`instances` 行主序 4×4 局部→世界矩阵、`projectors` 最多 4 个，各含 `worldToBox`、`maxAngle`、`worldOffset`、RGBA 贴图）。上限 10000 三角形 / 4 投射盒，超限报错。
- **核心管线**（`decal-core.js`，全部手写，不调用现成贴花生成器）：
  - 盒局部 Sutherland–Hodgman 六面体裁剪，边界等于 ±1 算内部，容差 1e-9；
  - 世界法线角度筛选：`dot(世界外法线, −投射方向) ≥ cos(maxAngle)`，世界外法线取实例线性部分逆转置后归一化，投射方向为盒到世界 +z 轴；
  - 交点同步插值来源三角形重心坐标，UV = `[(boxX+1)/2, (1−boxY)/2]`（v 向下）；
  - 偏移前面积 < 1e-12 的退化三角形丢弃（裁到边界的碎条不留退化面）；
  - 负行列式（镜像）实例自动反转输出绕序，保持外表面朝向；
  - 最后沿世界外法线偏移 `worldOffset`。
- **交互**：每投射盒可调中心/尺寸/旋转（范围与方向）、角度阈值、法线偏移，也可直接编辑 worldToBox 矩阵（保留剪切）；原模型 / 生成网格线框切换；点击贴花查看来源面（高亮）及逐角重心坐标、点击点重心坐标。
- **导出**：OBJ（几何+逐角 vt，可选 v 向上转换并在文件头注明）、逐角 UV JSON、来源 JSON（projectorId / instanceId / meshId / sourceTriangle / 逐角重心坐标 / UV / 法线 / 位置）。

## 测试

```bash
node test/test-core.mjs    # 核心管线：对照 expected.json + 镜像/剪切/容量/退化/上限
node test/test-page.mjs    # 页面端到端（需先起 http 服务，端口见文件内）
```

## 样例

`samples/extracted/`：`basic`（基础）、`affine`（镜像实例 + 剪切投射盒）、`capacity`（9800 面 × 4 盒）、`expected.json`（基准值，页面"自检"按钮对照）。
