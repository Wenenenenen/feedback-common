# Screen Ray Slab Tracer

屏幕空间反射射线核对网页。按样例包 `samples/screen-ray-slab-tracer-cases.zip`
内的半开像素与深度厚度约定，实现透视投影下的逐格解析遍历与最早命中计算，
不使用固定步长采样或任何现成 SSR 接口。

## 约定（与包内 说明.txt 一致）

- 相机朝 +z，投影 `u = fx*x/z + cx`、`v = cy - fy*y/z`
- 像素格 `(x,y)` 覆盖 `u∈[x,x+1)` × `v∈[y,y+1)`，像素中心加 0.5
- `depth` 为前向 z 或 null；有深度格的体积 = 该格投影锥 ∩ z 区间
  `[depth, depth+thickness]`
- 射线 `p(t) = origin + t*normalize(direction)`，`t∈[epsilon,maxDistance]`
  且 `near ≤ z ≤ far`
- 正面命中要求 `normal·direction < 0`；源格（sourcePixel）整格跳过
- 每条边界都是 t 的线性不等式（z>0 由 near 保证），例如
  `u≥x ⇔ fx*x+(cx-x)*z ≥ 0`，严格/非严格端点按半开约定处理
- 交集长度必须大于 1e-9，单点相切记为 graze，不算命中
- 命中取有效区间下确界；同 t 按 `(y,x)` 字典序
- 射线可从画外进入，先裁 near/far 与屏幕范围，不因起点越界直接放弃

## 两种模式

- 主模式（DDA）：只遍历投影直线经过的格子，边界穿越时刻由同一个线性
  不等式精确求解，无步长、无采样
- 参考模式（exhaustive）：对每个像素做解析区间测试，页面可一键比对两种
  模式的命中格、enter/exit 参数与候选数量

未命中原因区分：近裁 near、远裁 far、越界 off-screen、空深度 empty-depth、
背面 backface、单点擦碰 graze、源格 source-only、超距 max-distance；
射线级裁剪与格子状态同时存在时，次因集合 `reasonFactors` 全部保留。

## 页面功能

- 点选像素生成反射射线（源中心反投影，入射 = normalize(origin)，
  反射 = 入射 − 2(入射·法线)法线，自动设置 sourcePixel）
- 载入/编辑/批量粘贴射线 JSON，调 thickness、epsilon、maxDistance
- 叠加走过的格子、命中区间、射线路径、像素网格与原因标签
- 导出反射结果 PNG（4×）与每条射线的完整追踪 JSON（含逐格 enter/exit）

## 本地运行

数据通过相对路径 `fetch("data/*.json")` 加载，需要静态服务器：

```bash
cd app
python3 -m http.server 8000
# 打开 http://127.0.0.1:8000/
```

## 验证工具（tools/）

| 脚本 | 作用 |
| --- | --- |
| `validate.py` / `validate.js` | 与包内 reference.json 逐字段核对 |
| `fuzz.py` / `fuzz.js` | 各 8000 条随机射线，DDA 与穷举差分（含画外进入、贴边界、负 dz、穿角点） |
| `targeted.js` | 五类未命中、反射公式、厚度单调性等定向用例 |
| `smoke.mjs` | 无头 Chromium 端到端：点选、比对、导出、双主题、手机宽度 |

当前结果：包内 7 条射线全部精确匹配；Python/JS 各 8000 条 fuzz 零失配；
端到端冒烟通过。
