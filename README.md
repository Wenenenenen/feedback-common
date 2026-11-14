# Alpha 层检查台（CPU 软件光栅化参考台）

用于展陈软件渲染排错的**可逐片元核对的 CPU 参考实现**。交叉半透明玻璃面在整体排序下
常出现颜色错误，本工具对每个像素保留由近到远的**全部非零 alpha 片元**，逐像素确定遮挡，
不做整面排序、不丢层，在线性空间合成后导出 sRGB PNG。无 WebGL / WebGPU / 第三方渲染器，
光栅化与合成全部自行实现，Canvas 2D 仅用于把算好的像素贴上屏幕。

## 特性与正确性要点

- **透视正确插值**：相机空间六平面 Sutherland–Hodgman 裁剪，正确处理顶点跑到相机后方、
  近/远裁剪面与视口边界；透视除法后做屏幕投影，RGBA 按 1/z 透视校正插值。
- **逐像素遮挡，不整面排序**：每像素收集全部覆盖且 alpha>0 的片元（含不透明面之后、
  对最终颜色无贡献的片元），按 `(相机深度, id)` 排序；严格同深度时 id 小者在前。
- **至少 32 层**：`stack32` 场景 32 层重叠面、64 个三角形可完整保留与核对。
- **双面渲染**，无光照、无抗锯齿，采样位置 `(x+0.5, y+0.5)`。
- **左上规则 + 有向边函数**：三角形统一到正向面积，共享边只归属一个三角形，
  对角线不会被混合两次（共享边不变深）。
- **线性空间合成**：输入为非预乘线性 RGBA，前→后预乘 over 合成，背景作为最后底层；
  最终线性 RGB 以标准 sRGB 传递函数编码为 8-bit PNG（alpha 恒 255）。
- **同深度 tie-break、alpha=0/1、近远裁剪、相机后方顶点**均有专门样例覆盖。
- **相机可移动**：拖拽环绕、滚轮推拉、一键复位；方形输出 64–1024 像素。
- **只提交最新帧**：连续变更相机/尺寸时丢弃过期响应；**错误输入保留上一帧**。
- **离线可用**：零外部依赖、零 CDN、零网络请求；Python 仅用标准库，JS 不引入任何包。

## 目录结构

```
src/py/alpha_render.py   Python 参考光栅器（校验/裁剪/光栅化/合成/sRGB/PNG/CLI）
src/py/server.py         本地 HTTP 服务（静态托管 + 样例 API + Python 多进程交叉渲染）
src/web/index.html       页面（内联 CSS，无外部资源）
src/web/js/renderer.js   JS 光栅化核心（与 Python 同规范，typed array，可在 Node/Worker 运行）
src/web/js/render-worker.js  渲染 Worker（每 Worker 一个水平分带，上限 4）
src/web/js/app.js        主线程：Worker 池调度、帧去重、错误保帧、相机、像素检查、PNG 导出
src/web/js/png.js        纯 JS PNG 编码器（zlib/stored deflate/CRC32/Adler32）
tests/node_check.mjs     JS 对照 expected.json 的 Node 单元测试
tests/cdp_check.mjs      无头 Chrome 端到端测试（零依赖 CDP）
tests/cdp-relay.mjs      WSL 侧 TCP 中继（仅 E2E 用，产品运行不需要）
tests/run_e2e.sh         E2E 编排（WSL NAT/Hyper-V 防火墙环境）
scripts/start.sh         启动服务
scripts/selfcheck.sh     一键自检（Python + JS 全量对照）
```

Python 与 JS 是**两份独立实现、遵循同一规范**，可互相核对；二者均通过 `expected.json`
全部参考像素（深度/RGBA 绝对误差 1e-6，PNG 通道误差 ≤1）。

## 启动（Ubuntu-24.04 WSL，Windows 浏览器访问 localhost）

```bash
./scripts/start.sh          # 默认端口 8000；可传参 ./scripts/start.sh 9000
```

然后在 Windows 浏览器打开 <http://localhost:8000/>。
服务绑定 `0.0.0.0`，WSL2 的 localhost 转发会让 Windows 侧直接可达；全程不访问外网。

手动方式等价于：

```bash
python3 -I src/py/server.py --port 8000
```

`-I` 为隔离模式，忽略 `PYTHONPATH` 与用户站点，避免解压样例目录中被植入同名 Python 模块。

## 使用

- 左上工具栏选择内置样例，或导入自己的场景 JSON（格式见 `samples/extracted/说明.txt`）。
- 选择 64–1024 的方形输出尺寸。
- 图像上**拖动**环绕相机、**滚轮**推拉、**复位相机**恢复场景默认视角。
- **点击任意像素**，右侧面板列出由近到远的全部非零 alpha 片元：`id`、相机深度、
  线性非预乘 RGBA、该层合成后的线性 RGB，以及最终线性 RGB 与 sRGB 8-bit 值。
- **导出 PNG** 下载当前帧的 sRGB 8-bit PNG。

## 场景格式（version=1）

```json
{
  "version": 1,
  "width": 512, "height": 512,
  "camera": { "position": [...], "target": [...], "up": [...],
              "fov_y_degrees": 90, "near": 1, "far": 20 },
  "background_linear_rgb": [0, 0, 0],
  "triangles": [
    { "id": 1,
      "vertices": [
        { "position": [x, y, z], "rgba": [r, g, b, a] }
      ] }
  ]
}
```

- 右手世界坐标；相机由 position/target/up + 竖直 fov + near/far 定义。
- 顶点 `rgba` 为 0–1 的**非预乘线性**颜色；三角形 `id` 必须唯一且为非负整数，
  重复 id 等非法输入会被整体拒绝并保留上一帧。

## 自检

```bash
./scripts/selfcheck.sh                 # Python + JS 全量对照 expected.json
node tests/node_check.mjs samples/extracted   # 仅 JS
python3 -I src/py/alpha_render.py render samples/extracted/crossing.json  # 渲染出 PNG
```

浏览器端到端（需要 Windows 侧 Chrome；仅在 WSL NAT 环境下用到 TCP 中继桥接）：

```bash
bash tests/run_e2e.sh
```

## 性能

- JS 交互路径（4 Worker 分带）：最重的 `stack32` 512×512、677 万片元，浏览器实测约 **<1 s**，
  满足 4 核 CPU 5 秒内完成；计算在 Worker 中进行，期间页面持续可响应。
- Python 为离线交叉核对工具，多进程分带（上限 4 进程）渲染同一帧约十几秒，
  用于独立复核 JS 结果，不承担交互延迟指标。

## 安全说明

- 解压样例视为不可信数据，置于独立的 `samples/extracted/`，只读使用、绝不作为代码执行；
  Python 以 `-I` 运行，脚本与数据目录分离。
- HTTP 服务仅做只读静态托管与本地渲染，含路径越界防护与请求体大小上限。
