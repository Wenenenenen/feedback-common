# 玻璃套件光路校验 · Nested Glass Ray Reel

零依赖的纯前端解析光路校验工具，用于检查透明展品中的嵌套玻璃与气泡边界。
不使用 Three.js、路径追踪器或任何现成光追库；球面求交、介质嵌套、Fresnel
分裂、斯涅尔折射、RGB 吸收和导出均在 `tracer.js` 中手写实现。

## 运行

```bash
python3 -m http.server 8123
# 打开 http://127.0.0.1:8123/
```

也可以直接打开 `index.html`；此时浏览器若禁止 `fetch` 本地样例，会自动使用
与 `samples/nested-glass.json` 相同的内置样例，仍可通过“导入 JSON”选择仓库中的文件。

## 功能

- 导入 `samples/nested-glass.json` 同构 JSON：
  - 最多 32 个球；
  - 最多 `96×64 = 6144` 条逐行 `[o, d]` 射线；
  - `size: [width, height]` 按行主序映射到像素。
- 校验球对是否严格嵌套或分离；相交、外切、内切都会报告两个球的编号、
  距离和间隙，并且不会用坏场景替换当前画布。
- 最内包含球决定起点介质；反射保留原介质，折射才按边界切换。
- 解析二次方程求交：
  - 相切 / 判别式处于数值相切带时不产生事件；
  - 只忽略刚经过的 `t≈0` 同交点根，保留同球另一根；
  - 不沿方向挪动起点，因此 `1e-6` 的薄嵌套层不会被跳过。
- 每段按 `exp(-sigmaRGB * t)` 衰减。
- 界面法线朝向入射侧，严格按题给公式计算 `cosI`、`eta`、`sinT2`、`cosT`
  和非偏振 Fresnel F；全反射只保留权重 1 的 R 支。
- 深度滑杆为 0–10 次界面事件：
  - 无下一击：即使达到深度上限也作为逃逸，权重乘 `background` 累加；
  - 有下一击但预算耗尽：原分支权重单列为 `residual`，不混入背景；
  - JSON 另给 `residualArrived`，即假设传播过候选段并衰减后的诊断值。
- 画面使用线性 RGB，clamp 后 `Math.round(255*x)`，无 gamma。
- 点像素查看完整 R/T 树；R 支始终排在 T 支前。
- 事件中的球号可定位：球面卡片高亮、滚动，并在 XY/XZ/YZ 投影图中圈出。
- 导出当前 PNG，以及全部射线或当前像素的光路 JSON。

## 导出 JSON

顶层结构由 `NestedGlass.buildExport(scene, { depth })` 生成：

```jsonc
{
  "schema": "nested-glass-light-paths/v1",
  "size": [96, 64],
  "depth": 10,
  "background": [1, 1, 1],
  "spheres": [/* id,c,r,n,sigma,parent */],
  "rays": [
    {
      "rayIndex": 0,
      "pixel": [0, 0],
      "rgb": [/* 未量化逃逸颜色 */],
      "residual": [/* 深度余量：原权重口径 */],
      "residualArrived": [/* 候选段衰减后的诊断口径 */],
      "rgb255": [209, 172, 255],
      "branches": [
        {
          "id": "0.T.R",
          "kind": "R",
          "start": [/* ... */],
          "end": [/* ... */],
          "sphereId": 1,
          "inId": 1,
          "outId": null,
          "weight": [/* 分支起始 RGB 权重 */],
          "endWeight": [/* 吸收后权重 */],
          "event": { /* Fresnel、法线、入/出介质等完整事件 */ }
        }
      ],
      "tree": { /* 同样信息的递归 R/T 树，children[0] 恒为 R */ }
    }
  ]
}
```

浏览器自动化或控制台可使用：

```js
window.__glassApp.state
window.traceNestedGlass(rawJson, depth)
```

## 核心测试

```bash
npm test
```

测试覆盖样例 Fresnel 数值、深度 0 余量/逃逸区别、相切、`1e-6` 薄层、
空腔介质方向、TIR、相交/接触编号和导出字段。

可选浏览器冒烟：

```bash
NODE_PATH=/path/to/playwright/node_modules node tools/smoke.cjs
```

它会验证样例像素、点击分支、定位球、深度切换、三类下载、坏输入保留旧图，
以及 32 球 / 6144 射线容量场景。
