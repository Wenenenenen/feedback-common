# Stroke Mesh Studio

矢量描边网格编辑器:把 SVG 风格路径(绝对坐标 `M/L/Q/C/Z`)在**局部坐标系**中自研描边、切虚线并三角化,再应用仿射矩阵渲染为三角形网格。用于排查自研渲染器相对浏览器原生描边的尖角、虚线接缝等差异。

## 运行

静态站点,无构建步骤。因为用了 ES 模块,需要通过 HTTP 访问:

```bash
python3 -m http.server 8471
# 打开 http://127.0.0.1:8471/index.html
```

页面内置了 `samples/stroke-geometry-cases.zip` 中的 6 条示例路径;也可以通过「导入 JSON」加载同格式文档。

## 功能

- **描边管线全部自实现**(不调用任何现成描边/三角化接口):
  - 曲线自适应细分(导出坐标偏差 ≤ 0.25px,容差按矩阵最大缩放折算回局部坐标);
  - 弧长用 Gauss-Legendre 积分(误差 ≤ 0.1 局部单位,实测对样例三次曲线 ~1e-9);
  - 虚线:正数数组、奇数长度自动重复两遍、任意正负相位(正相位 = 沿重复图案向前)、每个子路径重置相位、跨命令连续;闭合路径首尾同属一段时跨接缝合并为一段(接缝处渲染为连接而非两个端帽);
  - 连接:miter(含 miterLimit 超限退化 bevel)/ bevel / round;端帽:butt / square / round;
  - 重复点/零长段在弧长表构建时剔除,不产生坏网格;
  - 先局部描边再应用矩阵(含非均匀缩放与镜像)。
- **半透明一致性**:同一路径的所有三角形统一环绕方向,并在**一次 `fill()`** 中按并集栅格化,内部三角形重叠不会变深(不同路径重叠仍会正常叠加)。
- **编辑**:左侧可编辑命令 JSON、样式(线宽/连接/端帽/miterLimit/虚线/相位/颜色)与仿射矩阵,非法输入(如虚线含 0)会被拒绝并提示。
- **调试视图**:三角线框、中心线、原生描边对照(仅用于肉眼对比)叠加开关;点击虚线可查看所在弧长区间并高亮该段。
- **导出**:三角网格 JSON(导出坐标,positions + triangles)与透明背景 PNG。

## 测试

```bash
# 核心算法对照样例 oracle(弧长、虚线区间、接缝合并、网格健康度等 43 项)
node test/oracle.test.mjs /path/to/paths.json /path/to/oracle.json /path/to/invalid.json

# 浏览器冒烟测试(需 playwright;先启动静态服务)
node test/browser.smoke.mjs http://127.0.0.1:8471/index.html
```

## 文件结构

```
index.html          页面骨架
css/style.css       样式
js/geometry.js      向量/矩阵、贝塞尔自适应细分、弧长参数化(纯几何,Node 可测)
js/stroker.js       虚线切割 + 描边 -> 三角网格
js/pipeline.js      文档校验 + 管线编排
js/renderer.js      画布渲染、原生对照、PNG/网格导出、点选命中
js/app.js           UI 装配
test/               oracle 对照测试与浏览器冒烟测试
```
