# 簇光校验台（Cluster Light Inspector）

校验**分簇点光源**（tiled/clustered forward lighting）的单页工具：按包内规则自行划分屏幕瓦片与对数深度层，用球-簇平面保守测试生成**完整、不截断**的每簇光源列表，并与逐灯穷举在线性 RGB 口径下逐项对照。不依赖任何现成分簇光照组件，三维线框为自研软件投影。

## 它解决什么问题

- 固定容量光源列表会**漏掉局部灯光**——本工具的规范列表保留所有通过保守测试的灯，单簇峰值再高也不截断；另设“截断诊断”开关复现固定容量（如 128）导致的漏光与误差。
- **边缘簇、跨近裁面、相机内、屏幕外球形范围**的灯容易被分错——六面朝内平面 + 归一化球测试按《格式说明.md》的规定保守判定，可逐簇核对成员。
- 分簇与穷举的**线性 RGB 必须一致**——两条路径同一套公式，误差图与导出保持线性，显示才做 tonemap。

## 运行

直接用浏览器打开构建产物（无网络/构建依赖，样例已内联）：

```
dist/cluster-light-inspector.html
```

开发方式（改 `js/` 后重新内联）：

```bash
node tools/build.js          # 重新生成 dist 单文件与 js/samples.js
# 也可直接起静态服务器打开 index.html（js/samples.js 提供内联样例）
```

## 测试

```bash
# 1) Python 参考实现（独立 stdlib，用 -I 隔离）生成期望值
python3 -I tools/reference.py samples/extracted/stress.json > tools/expected/stress.expected.json

# 2) JS 核心 vs Python 期望：簇成员/计数/像素簇/线性颜色/求值次数，702 项
node tools/test-core.js

# 3) Playwright 端到端：渲染、选像素、2D/3D 拖灯、截断误差、导出结构、0 控制台错误
node tools/smoke.js
```

JS 核心与 Python 参考的线性颜色差异在 1e-15 量级（浮点舍入），规范路径下分簇与穷举误差恒为 0。

## 规则口径（与《格式说明.md》一致）

- 视空间 X 右、Y 上、Z 前；`fov_y` 角度，`near>0`、`far>near`。
- 对数深度边界 `z_k = near·(far/near)^(k/slices)`，左闭右开，**far 归末层**。
- 像素中心 + 深度重建视空间点；每簇像素边界转射线斜率 `l/r/b/t`，六面朝内平面为
  `[1,0,-l,0] [-1,0,r,0] [0,1,-b,0] [0,-1,t,0] [0,0,1,-z_k] [0,0,-1,z_{k+1}]`，
  法线前三分量归一化时常数项 `d` 同比例缩放。
- 保守球测试：每面 `n·center + d ≥ -radius - 1e-9` 即通过，六面全过才入列表；按 id 排序，**不限单簇容量**。
- 光照（线性 RGB）：`albedo/π · intensity · max(N·L,0) · (1-d/r)²/max(d²,1e-4)`，
  仅 `d<r` 求值，`d≤1e-10` 贡献 0，背景（depth=null）为 0。
- 显示：`L/(1+L)` Reinhard 后转 sRGB；**误差图与导出始终线性**。

## 界面能力

- **屏幕光照**：分簇 / 逐灯穷举 / 误差三视图切换；点击任意像素查看所属簇、候选灯与每灯贡献（含落选原因：未过球测试、d≥r、背向、d≤1e-10）。
- **每簇计数热图**：按深度层切换，数值即完整光源数（不截断），点击热图定位簇。
- **三维簇线框**：orbit 相机（左键旋转、滚轮缩放），视锥虚线框 + 簇八顶点线框 + 光源球；可只看选中簇，可直接拖动灯球。
- **光源可拖动并重算**：2D 图上拖动投影灯标（保持深度）或 3D 视图沿视平面拖动；右侧编辑器可精确改位置/radius/intensity。
- **截断诊断**：选择容量上限观察被截断的簇与线性误差。
- **导出 JSON**：簇列表（成员 id、计数、像素/深度边界）、每像素线性颜色（分簇/穷举/误差）、候选测试与实际求值次数、总计、深度边、截断诊断。

## 边界用例覆盖

| 用例 | 验证点 |
|---|---|
| `odd-size` (63×47) | 奇数画面尺寸，瓦片 4×3 |
| `boundary` (33×31) | 相机内灯（z=0、z=0.5）、far 深度归末层、屏幕外灯（x=7） |
| `overflow` (17×17, 300 灯) | 单簇 300 灯不截断；cap=128 时出现真实线性误差 |
| `stress` (128×96, 512 灯) | 大规模候选裁剪：9.7 万候选测试 vs 629 万穷举 |
| `invalid-radius` | radius≤0 的灯按无效剔除并给出校验警告 |

## 目录

```
index.html                  页面骨架与样式
js/cluster-core.js          核心算法（校验/建簇/球测试/着色/投影），浏览器与 Node 通用
js/app.js                   Canvas 渲染、交互、3D 线框、导出
js/samples.js               构建生成的内联样例
tools/reference.py          Python 参考实现（生成期望值）
tools/test-core.js          JS vs Python 数值回归
tools/smoke.js              Playwright 端到端
tools/build.js              内联打包为 dist 单文件
samples/extracted/          解压后的输入用例（不可信数据，与代码隔离）
```
