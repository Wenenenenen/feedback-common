# 镜面反射视束核对台（Mirror Beam Clipper）

展厅多面斜镜反射的视束核对网页。纯原生 JavaScript ESM，**无任何三维引擎或第三方运行时依赖**，
自行实现视束裁剪、前缀闭合配额求解与软件光栅化。

## 运行

网页需要通过 HTTP 提供（ES module 不能用 `file://` 直接打开）：

```bash
cd app
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/index.html
```

## 目录

```
app/                 网页应用（可直接静态托管）
  index.html         界面与双主题样式
  app.js             界面逻辑：画布、拾取、编辑、撤销重做、导入导出、错误提示
  state.js           撤销/重做场景快照栈
  samples.js         三个内置样例
  engine.js          管线编排、增量更新、SPEC §7 导出
  beam.js            主视锥、三维 Sutherland-Hodgman 裁剪、视束展开、得分、配额 DP
  rasterize.js       斜近裁面+棱锥裁剪、单面翻转、层次遮挡、前向线性深度光栅化
  validate.js        SPEC §2 合法性校验（编号+原因，拒绝时保留原场景）
  math.js            向量/4x4 反射矩阵/插值
src/                 与 app/ 同源的引擎副本（供 Node 测试直接引用，内容一致）
tests/               Node 测试与 PPM 可视化
cases-unpacked/      解压后的 SPEC.md 与三个样例 JSON
```

## 实现要点与 SPEC 对应

| SPEC | 实现 |
| --- | --- |
| §3 主视锥 | `beam.js createCamera/frustumPlanes`，前向线性深度 z_view |
| §4 视束展开 | `expandChildren`：虚相机正面 h>1e-6、父镜面半空间 1e-6、视束侧平面、主视锥 6 平面三级裁剪，面积>1e-7 剪枝，禁紧邻自反射 |
| §5 配额 | `solveBudget` 树上前缀闭合背包 DP，精确最优；并列依次比总分→条数→路径字典序 |
| §6 光栅化 | 斜近裁面+棱锥裁剪、奇数次反射单面绕序翻转、三角形与子镜面窗口同缓冲深度竞争、递归层次遮挡、镜面底色 0.12·R |
| §7 导出 | `Engine.exportJSON`，按路径字典序 |

### 增量重算

单镜面编辑（几何/反射率/enabled）走 `expandBeamsIncremental`：仅重建路径含该镜面的子树，
未受影响视束对象保留；像素缓冲以「路径 + 子树版本号」为缓存键，整棵子树未变才复用。
其他编辑（相机、三角形、K、反射层数）自动退回全量重算。

## 测试

```bash
node tests/test-budget.mjs          # 300 随机树配额 DP 对拍暴力枚举 + 并列字典序
node tests/test-validate.mjs        # 16 类非法数据拒绝（编号+原因）与原场景保留
node tests/test-incremental.mjs     # 增量结果与全量逐字节一致、对象复用、退回全量
node tests/test-edge.mjs            # bounce=0、停用、镜背剔除、K=1、单面/双面绕序翻转
node tests/test-app-integration.mjs # 三样例载入/导出/拾取/历史/拒绝
node tests/test-ui-shim.mjs         # DOM 垫片下 19 项界面交互断言
node tests/smoke.mjs cases-unpacked/*.json    # 端到端冒烟与时序
node tests/debug.mjs <case.json>    # 视束/像素光路直方图诊断
node tests/test-render.mjs ppm <json...>      # 输出 PPM；stress 为 4000 三角/16 镜/4 层压测
```

## 性能（Node 22，320×240 上限场景）

- 4000 三角形 + 16 镜面 + 4 层反射全量：约 130–150 ms
- 改单镜面子树增量：约 75–90 ms（远低于 1.5 s 预算）
