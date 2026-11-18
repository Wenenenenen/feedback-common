# 隐式实体 CSG 预览台

纯静态网页（原生 JavaScript，零依赖、零构建，无任何现成 CSG / 光线步进库），
对球 / 盒 / 环面叶节点组成的 CSG 树计算保守距离场，并用球步进（sphere tracing）
完成射线求交、320×240 预览与表面拾取。

## 运行

直接用浏览器打开 `app/index.html` 即可（`file://` 可用，模块为普通脚本，不依赖 ESM / 服务器）。
页面内置 5 个与样例包一致的示例，也可导入 `samples/extracted/` 中的场景 JSON。

## 目录

```
app/                 网页应用（全部为无依赖原生 JS）
  index.html         三栏界面
  mat4.js            行主序 4×4 仿射矩阵：Gauss-Jordan 求逆、Jacobi 求最小奇异值
  validate.js        结构与语义校验（引用 / 环 / 深度 / 叶数 / 尺寸 / 奇异矩阵 / 射线）
  sdf.js             叶距离场、σ_min 保守下界、并 min / 交 max / 差 max(a,-b)
  raymarch.js        球步进：hit / miss / iteration_limit 三态
  render.js          320×240 CPU 渲染、轨道相机、按叶着色
  app.js             状态、树视图、节点编辑、拾取、批量导入导出
tests/
  run-tests.js       Node 单元测试（对照 reference.json，26 项）
  e2e.js             Playwright 无头浏览器端到端测试
  export-all.js      导出全部样例射线结果，供 Python 交叉验证
crosscheck/
  crosscheck.py      独立 Python 参考实现（仅标准库，python3 -I 运行）
samples/extracted/   题给样例（不可信数据，保持隔离，应用不内嵌读取）
```

## 公式与实现的对应

严格按样例包《格式说明.md》：

| 规定 | 实现位置 |
| --- | --- |
| 点先乘 matrix 逆，局部场乘线性部分最小奇异值 σ_min 作为世界保守场 | `sdf.js` `evalField/evalDistance`，σ_min 见 `mat4.js` `minSingularValue`（Jacobi 求 AᵀA 最小特征值） |
| 球 `d=|p|-r`；盒 `|max(q,0)|+min(max(q),0)`；绕 Y 环面 `|[ |p.xz|-major, p.y ]|-minor` | `sdf.js` `localDistance` |
| 并 min、交 max、差 max(a,−b)，**相等取左分支** | `sdf.js` 内部节点分支（`<=` / `>=` 保证平手取左） |
| 差集右枝叶编号保留、梯度反向 | 求值结果携带 `negated`；差取右枝时翻转，法线由带符号场中心差分自动反向 |
| 方向归一化，t∈[0,20]，推进 `|d|`，`|d|≤1e-4` 为 hit，越界 miss，耗尽 iteration_limit | `raymarch.js` `trace/traceShade` |
| 法线 = 世界场梯度归一化，步长 1e-5 | `sdf.js` `gradient` |
| max_steps 默认 512，可调 1–4096 | 界面输入框 + `normalizeMaxSteps` 钳制 |
| 树单父、无环、深度 ≤16、叶 ≤64 | `validate.js` 三色 DFS |

### 为什么非均匀缩放 / 剪切不会跨过薄壁厚

任意点 p 的局部距离 `d_local` 是局部系真实距离，沿射线世界步进 `Δt` 对应局部位移
长度至多 `‖A‖·Δt`；反过来，保证不穿越表面的世界步长为 `|d_local|·σ_min(A)`
（σ_min 是线性部分最小奇异值）。嵌套变换时每一层节点各自做一次
“逆变换到局部系 → 子树求值 → 乘本层 σ_min”，链式保持保守。剪切矩阵
`[[1,.8,0],[0,1,0],[0,0,.25]]` 的 σ_min≈0.193，`sheared/thin` 射线因此以小步长
穿过 0.25 厚的 z 向薄壳，命中 t=1.75，与参考一致。

### 内部 / 空腔起点

步进恒用 `|d|` 而非 `max(d,0)`：实体内部 d<0 时向表面推进，差集空腔内
（`max(a,-b)` 为正但四周是内壁）同样能收敛到最近表面，状态仍为 hit，
并通过 `negated` 标记区分内壁（着色降明度、拾取面板与导出 JSON 均标注）。

## 校验错误（均带具体节点 id）

- 引用缺失 / 自引用 / 环 / 多父（单父约束）
- 深度 >16、叶 >64、未知 kind、叶参数非正、half_size 非 3 元组
- matrix 非 16 有限数、末行不是 [0,0,0,1]、求逆失败（奇异）、σ_min <1e-9（近奇异）
- 射线 origin/direction 非法、零方向、id 重复

非法时保留已导入数据用于修改，校验面板逐条列出问题，渲染与批量求交暂停。

## 批量射线与导出

- 导入 `{"rays":[...]}` 或顶层数组，逐条做与场景相同的射线校验；
- 导出 `csg-hits.json`：每条含 `status / t / point / leaf / negated / distance /
  normal / steps / samples[]（每步 t、d、leaf、negated）`，miss 与 iteration_limit
  分别带 `lastDistance`（耗尽另带 `lastLeaf`），并记录 max_steps、tMax、epsilon 等参数。

## 测试

```bash
# 1) Node 单元测试（26 项，含 reference.json 数值对照）
node tests/run-tests.js

# 2) 无头浏览器端到端（渲染/旋转/点击拾取/编辑/导入导出/非法场景）
node tests/e2e.js

# 3) 独立 Python 实现交叉验证（与 JS 无共享代码）
node tests/export-all.js samples/extracted /tmp/csg-js-results.json
python3 -I crosscheck/crosscheck.py \
  "$PWD/samples/extracted" "$PWD/samples/extracted/reference.json" \
  --js-results /tmp/csg-js-results.json
```

Python 交叉验证对参考值与 JS 结果双重比对（JS↔Python 的 t 容差 1e-6），
当前 22 项检查全部通过。
