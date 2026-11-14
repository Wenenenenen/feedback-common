# 剖面工作台 · 树脂打印出厂检查

本地网页剖面检查台：载入 STL，在三维视图里放置切面，联动查看二维截面，
区分实体 / 孔洞 / 分离部件，导出 1:1 毫米 SVG 与含测量值的 JSON。
面向树脂打印的出厂检查：看空腔、断壁、分离部件。

- 纯 CPU 计算，Canvas 2D 绘制；不调用任何现成切片或布尔运算内核。
- 依赖只有 Python 3 标准库（起本地服务）和现代浏览器。没有 npm、没有 Docker。
- 运行期完全离线：页面不引用任何外部脚本、字体或接口。
- ASCII 与二进制 STL 都支持；单位按毫米处理。

## 启动（Ubuntu 24.04 WSL2）

```bash
python3 server.py                 # 默认 http://localhost:8000
python3 server.py --port 8123     # 换端口
```

在 Windows 浏览器打开 `http://localhost:8000`。WSL2 会把 localhost 转发到
WSL 内的服务；服务默认监听 `0.0.0.0`，所以从 Windows 访问不需要额外配置。
不需要 Docker，不安装任何 Python 包。

样例在 `samples/section-cases.zip`。服务启动时若发现 `samples/extracted/`
不存在或为空，会用 Python 标准库自动解压（不覆盖已有文件）；也可以手动解压：

```bash
unzip -o samples/section-cases.zip -d samples/extracted
```

## 使用

1. 左侧「样例」点击任一 STL，或把 STL 拖入页面 / 用「载入 STL」选择文件。
2. 右侧「切面 n · p = d」设置法线 `n` 与常数 `d`；`n` 可以不归一化。
   「比例」字段会同时缩放三个法线分量，方便输入整数方向。
   `d` 用滑块或数字框拖动；三维视图里 Alt+拖动也能前后移动切面。
3. 「视图」页：左为可旋转缩放的三维视图（拖动旋转、Shift/右键平移、滚轮缩放），
   右为截面二维图（悬停高亮、点击选中、滚轮缩放、拖动平移）。
4. 「数据」页：面积、全部边界周长、环数、孔洞数、分离部件数、开口数，
   以及每个环的类型 / 归属部件 / 面积 / 周长，和按部件汇总。
5. 「导出」：SVG（1 用户单位 = 1 毫米）与 JSON 报告。

## 截面约定

- 平面为 `n · p = d`；`n` 不要求单位长度，内部会用单位法线 `n̂` 与 `d̂ = d / |n|`。
- 截面取**沿 +n 方向趋近平面**的极限，等价于把平面推到 `n·p = d + ε` 再令 ε → 0+。
  - 因此贴面 / 过顶点时结果是确定的：贴着顶面从 +n 看是空的；从 −n 看则是整个面。
- 二维坐标使用平面内的正交单位基 `(u, v)`，且 `u × v = n̂`。
- 每个环的走向都让材料在左侧：实体外环逆时针（带符号面积为正），
  孔洞顺时针（面积为负）。面积、周长都用这个取向逐一计算。
- **分离部件**由三维网格的连通分量决定，不靠二维包含关系猜测。
- **孔洞归属**：孔洞环落在哪个部件的外环内，就归属哪个部件。
- 开口 / 非流形：只提示，不补成实体。开放边界单独列出（`kind: "open"`），
  不计入实体面积；找不到闭合外环的孔洞面积记为未知，不会报负数。

## 稳健性

- **坏文件不破坏已加载模型**：解析在 Worker 内完成，只有全部成功后才替换当前模型。
  截断的二进制 STL、空文件、坐标非有限值的文件都会被明确拒绝（状态栏与提示条显示原因）。
- **格式识别**不只看 `solid` 前缀：只有声明的三角面数与文件大小精确匹配时才按二进制解析，
  因此故意以 `solid` 开头的二进制文件也能正确读出。
- **重线 / 尖刺**：重合的切割段按端点身份合并，方向相反的重复段（零宽内部接缝）被抵消；
  零面积的闭合走线被丢弃；贴着顶点 / 棱的切割只保留真实边界。
- **T 型接点**：切点落在另一段内部时会把该段劈开，保证环能闭合。
- **贴面容差**：距平面小于对角的 3×10⁻⁶（约几十纳米量级）的顶点按贴面处理，
  所以恰好相切的极限不会产生亚打印分辨率的碎片。
- **性能**：2 万三角面的模型，一次截面计算约 30–150 ms（浏览器内）；
  快速拖动时只保留最新一次请求，在途计算最多一个，旧结果按序号丢弃。
  三维视图每帧约 30–45 ms（2 万三角面，CPU 排序绘制）。

## 导出

### SVG

- `width`/`height` 带 `mm` 单位，`viewBox` 与图形坐标一致；1 单位 = 1 毫米。
- 路径分三类：`solid`（蓝）、`hole`（橙）、`open`（红虚线）。
- 每条路径带 `data-area-mm2`、`data-perimeter-mm`、`data-body`、`data-owner`。
- 带 1 mm / 10 mm 网格与 10 mm 比例尺，便于 1:1 打印核对。

### JSON

```jsonc
{
  "schema": "mesh-section-report/1",
  "units": "mm",
  "model": { "name", "format", "triangle_count", "bbox_mm", "diagnostics" },
  "plane": {
    "n": [...], "d": ...,            // 原始输入
    "n_unit": [...], "d_normalized": ...,  // 等价单位式
    "origin_mm": [...], "basis_u": [...], "basis_v": [...],
    "convention": "limit approaching along +n; u×v=n"
  },
  "bodies": [ { "id", "loopCount", "holeCount", "area_mm2", "perimeter_mm", "bbox2d" } ],
  "measurements": {
    "area_mm2", "perimeter_mm",
    "closedPerimeter_mm", "openPerimeter_mm",
    "loopCount", "solidLoopCount", "holeCount",
    "openChainCount", "bodyCount", "orphanHoleCount"
  },
  "loops": [
    {
      "id", "kind": "solid" | "hole" | "open", "closed",
      "body_id", "hole_owner_body_id",     // 孔洞归属
      "area_mm2", "perimeter_mm",
      "ring_2d_mm": [[u, v], ...],          // 平面二维环
      "intersections_3d_mm": [[x, y, z], ...]  // 对应三维交点
    }
  ]
}
```

## 测试

```bash
# 引擎与导出的单元测试（23 项，含全部样例参考值）
node --test tests/section.test.mjs

# 浏览器端到端检查（Playwright 可选，未安装则自动跳过）
node tests/e2e.mjs
```

单元测试覆盖：全部 `expected.json` 参考值、格式识别、截断文件拒绝、
沿 +n 极限的贴面 / 过顶点 / 过棱行为、非归一化法线、连通部件与孔洞归属、
空腔与内部岛、共面接触、T 型接点、开口与非流形、随机平面下的有限性、
SVG 毫米单位与 JSON 字段完整性。

## 目录

```
server.py            仅标准库的静态服务 + 样例接口
app/index.html       页面
app/styles.css       样式
app/js/stl.js        ASCII / 二进制 STL 解析与格式识别
app/js/mesh.js       顶点焊接、绕序统一、连通分量、拓扑诊断
app/js/section.js    切面引擎（极限截面、环追踪、归属、测量）
app/js/render3d.js   三维 Canvas 渲染（旋转 / 缩放 / 切面）
app/js/render2d.js   截面 Canvas 渲染（悬停 / 选择 / 缩放）
app/js/camera.js     轨道相机与二维视图变换
app/js/export.js     SVG 与 JSON 导出
app/js/worker.js     解析与切面在 Worker 中执行
app/js/app.js        UI 与交互、请求合并
tests/               单元测试与端到端测试
```

## 已知取舍

- 截面按真实表面计算：开口的模型不会凭空补面，所以其截面面积可能为未知而不是负数，
  界面会明确标注「无外环」。
- 三维视图用 CPU 画家算法，没有深度缓冲；对自相交或高度重叠的面，按三角面深度排序
  偶尔会出现可见的绘制顺序误差。对检查空腔 / 断壁足够，且保持「纯 Canvas 2D」约束。
- 焊接容差取模型对角线的 2×10⁻⁷；远小于任何可打印特征，但极端细长模型仍按比例缩放。
