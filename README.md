# 相似图块协同去噪工作台

材料照片里常有重复细纹（织纹、纹理、感光噪声）。普通平滑会把纹理一起抹掉；把相似图块
分组后做协同变换去噪（BM3D 式的“匹配 → 变换域收缩 → 聚合”），能在保纹的同时压噪——
但朴素实现常因**边界补齐**和**重叠权重**在图像边缘留下亮缝。

本工具按样例包的流程逐条实现：

1. **图块匹配**：参考中心按步长铺开，在 ±r 搜索方框内枚举全部整数候选中心，按均方距离、
   y、x 排序，取不超过 K 与候选数的最大 2 次幂个组员；
2. **正交 DCT-II + 组间 Walsh-Hadamard**：每个图块做二维 DCT，同频系数沿组序做归一化
   WHT，把相似的图块“叠”成稀疏的组域表示；
3. **硬阈值初估**：`|组系数| < 2.7σ` 置零（保留组索引 0 的全局 DC），组权重
   `1/max(1, 保留系数数)`；
4. **维纳二次重建**：同时变换原图与初估组，`gain = pilot²/(pilot²+σ²)`，输出
   `gain·noisy`，组权重 `1/max(1e-12, Σgain²)`；
5. **聚合**：每个图块按其组权重累加回图，再逐像素除以权重和。镜像取样只用于**取数**，
   越界的镜像像素不会折叠写回图内——这正是边缘亮缝的常见来源；
6. **σ = 0** 直接返回原图，两阶段都逐像素相同。

界面可调**噪声标准差 σ、图块大小 p、搜索范围 r、步长 s、组容量 K与硬阈值倍数**，同时
显示**原图 / 初估 / 最终 / 聚合权重**；在任意视图点选图块即可查看匹配位置、距离、DCT
与组域系数、维纳增益。处理在 Worker 中运行，可取消；旧任务的迟到结果不会覆盖新参数。

## 运行

无需构建、无第三方运行时依赖（原生 ES 模块 + 原生 `CompressionStream`）。

```bash
npm run samples    # 解压样例包（幂等；测试也会回退读取内嵌样例）
npm start          # 零依赖静态服务器 → http://localhost:8123/app/
npm run build      # 生成 dist/：经典脚本打包版，file:// 直接双击可用
npm test           # 引擎 + PNG/导出单元测试（node:test）
npm run e2e        # 浏览器端到端测试（需本机 Playwright + Chromium）

# 命令行批处理（与网页导出同格式）
node tools/cli.js samples/extracted/noisy.png \
  --reference samples/extracted/clean.png --out out/
node tools/cli.js photo.png --patch 8 --radius 6 --stride 4 --capacity 8 --sigma 22
```

- **方式一（推荐）**：`npm start` 后访问 `http://localhost:8123/app/`。
- **方式二（离线）**：`npm run build` 后直接打开 `dist/index.html`。打包版把 Worker
  源码内联并以 Blob 构造 Worker，因此在 `file://` 下也能完整计算。
- 直接以 `file://` 打开 `app/index.html` 不工作：浏览器会因 CORS 拦截 ES 模块。

`npm run e2e` 默认使用机器上缓存的 headless Chromium；如路径不同，可设置
`PLAYWRIGHT_CHROMIUM` 或修改 `tools/e2e.js` 顶部的 `EXEC`。

## 数据格式

- 输入：**8 位灰度 PNG**，宽高各 **1–256** 像素；支持 PNG 全部 5 种行滤波与 CRC 校验。
  编码器同样输出 8 位灰度、自适应行滤波。
- 非灰度 / 非 8 位 / 隔行 PNG 会被明确拒绝并提示原因，不会静默转换。
- 样例位于 `samples/group-transform-denoiser-cases.zip`（`samples/extracted/` 为解压副本，
  已在 `.gitignore` 中忽略）。样例同样内嵌在 `app/js/samples.js`，离线打开即可使用。

导出内容（“导出结果”菜单）：

| 文件 | 内容 |
|---|---|
| `*-pilot.png` | 初估阶段，最终才截到 0–255 并四舍五入 |
| `*-final.png` | 最终阶段，同上 |
| `*-float.npy` | `numpy` 可直接 `np.load`；`shape=(4,H,W)`、`dtype=<f8>`，通道依次为 pilot、final、weight1、weight2（全部保留浮点，不截断） |
| `*-report.json` | 参数、派生量（硬阈值、σ²）、两阶段组统计与组大小直方图、权重分位、耗时、评估指标、格式说明 |
| `*.zip` | 以上四者 + `README.txt`（存储模式 ZIP，浏览器内零依赖生成） |

## 规则细节（与样例说明逐条对应）

- **图块中心**为整数像素，偏移 `-p/2 … p/2-1`。
- **镜像**采用不重复端点的对称反射（`…3,2,1,0,1,2,3…`，周期 `2(L-1)`）；轴长 1 时恒取 0。
- **参考中心**为 `0, s, 2s, …` 中小于边长的位置，补最后一像素 `L-1`，去重后升序；
  行列笛卡尔积即参考图块集合。
- **候选中心**为搜索方框与图像范围交集的全部整数位置；取 `min(K, 候选数)` 向下取到
  2 的幂作为组员数。第一阶段用原图距离，第二阶段用初估距离。
- **距离并列**按 y、x 升序；距离直接累加平方差（8 位整数下精确），避免交叉项展开带来的
  浮点并列噪声。
- **DCT**：`C[k,n] = sqrt((1 if k=0 else 2)/p)·cos(π(n+0.5)k/p)`，二维即 `C·X·Cᵀ`。
- **WHT**：`H1=[1]`，`H2m=[[Hm,Hm],[Hm,-Hm]]/√2`；对称正交，正逆变换相同。
- **聚合**：只写回“中心 + 偏移”落在图内的像素；权重和为零的像素回退到输入值
  （正常参数下不会发生，界面会把零权重像素标红以免漏看）。

内置“规则自检”按钮会用 `primitives.json` 的 DCT / Hadamard 期望值核对实现；
`npm test` 还会与一份**独立的朴素实现**逐像素对照（含边界镜像、两阶段与两组权重）。

## 目录结构

```
lib/
  layout.js     # 镜像、图块偏移、参考中心、采样索引
  transform.js  # 正交 DCT-II、Walsh-Hadamard、组正逆变换
  engine.js     # 匹配、两阶段重建、聚合、统计、检查器
  png.js        # 8 位灰度 PNG 编解码（CompressionStream）
  crc32.js      # PNG/ZIP 共用校验
app/
  index.html
  css/style.css
  js/main.js    # 状态、Worker 调度、视图与检查器、导入导出
  js/worker.js  # 后台计算（取消 / 旧任务丢弃）
  js/render.js  # 灰阶视图、权重单色阶、系数热图、组位置
  js/export.js  # PNG / NPY / 报告 / ZIP
  js/samples.js # 内嵌样例
tools/
  serve.js      # 零依赖静态服务器
  build.js      # 零依赖打包器 → dist/
  extract-samples.js  # 零依赖 ZIP 解压样例
  cli.js        # 命令行批处理（同网页导出格式）
  e2e.js        # 浏览器端到端测试
test/
  engine.test.js
  png.test.js
  fixtures/big-256.png
dist/           # 构建产物（npm run build）
samples/extracted/  # 样例解压目录（不可信数据，仅作数据读取）
```

## 可访问性与交互约定

- 四视图与新叠加层共用同一套拾取；点选后原图/初估/最终三视图同步描出该图块，
  检查器列出组员距离表（表格始终跟随当前阶段，另一阶段缺失的组员以 “—” 标出）。
- 权重与系数热图使用**单色阶**（浅→深，暗色模式翻转锚点），有符号系数用
  蓝正 / 红负 + 灰色中点；硬阈值剔除用斜线标记，不单靠颜色。
- 键鼠均可操作；所有控件有可见焦点环，状态行用 `aria-live` 播报进度与取消。
- 深色模式经单独调色并校验对比度。

## 样例许用

样例数据来自 `samples/group-transform-denoiser-cases.zip`，按 CC0-1.0 提供。
