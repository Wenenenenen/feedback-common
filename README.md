# 着色器缓冲重排台 Shader Block Rebinder

材质热更新后，结构数组步幅、矩阵行列主序、端序发生变化时，用于**自行计算 std140 / std430 子集布局**、
**按字段路径或绝对字节偏移双向定位**、**按同名字段与共同数组索引做按位迁移**、**查填充/改 HEX/撤销重做/导出整份转储**的纯静态网页。

不使用任何着色器反射库，零运行时第三方依赖。

## 运行

页面用的是经典脚本（非 ES Module），甚至可以直接双击 `web/index.html` 用 `file://` 打开
（仅“自动拉取内置样例”需要 HTTP；手动选择 ZIP 不受影响）。推荐静态服务：

```bash
cd web
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/
```

在仓库根目录起服务也可以，`/index.html` 会跳转到 `web/index.html`。

## 导入

- **导入归档 / layout.json + dump.bin**（`#file-import`，多选）：一次选择 ZIP，或同时选择 `layout.json`、`dump.bin`。
- `#file-archive`：只选 ZIP（ZIP 内允许 layout.json/dump.bin 位于根或单层目录，支持 stored/deflate）。
- `#file-layout` / `#file-dump`：分别导入；只导 layout 时按视图区间补零转储，只导 bin 时复用当前 layout。
- **载入内置样例** `#btn-sample`：读取 `web/samples/shader-block-cases.zip`。
- 导入是**原子**的：布局非法或视图越界时保留上一可用项目，错误条 `#status.error` 与 `window.__lastError` 给出含视图/路径/偏移的中文原因。

约束：dump ≤ 64 MiB；views 1–64；迁移对 ≤ 64；每批目标标量写入 ≤ 5,000,000（重复配对重复计数）；
类型深度 ≤ 16；每视图未展开成员声明 ≤ 4096。

## 功能与 DOM 锚点

| 需求 | 位置 / 选择器 |
| --- | --- |
| 视图列表（std、行列主序、端序、off/len、动态项数） | `#view-list .view-item[data-view]` |
| 路径 → 偏移（宽容 `name.a[0].v[1]`、`m[r][c]`、简写 `pose[1][1][2]`、向量 `x/y/z/w`） | `#path-view` `#path-input` `#btn-path-locate`，结果 `#path-result` |
| 结构树（小数组展开，大数组按下标查看；叶子带 `data-path`/`data-abs`） | `#tree`，叶子 `.t-row.leaf[data-path]` |
| 绝对偏移 → 所有覆盖视图（分量路径+分量内偏移，或“填充”） | `#offset-input` `#btn-offset-query` `#query-results` |
| 分页 Hex（4096 B/页，标量底纹/填充斜纹/选中） | `#hex`，字节 `.hx-byte[data-off]` |
| 选中标量的 32 位 HEX 原位值（按视图端序解释/写回） | `#hex-word` `#btn-edit-hex` |
| 同标量的地址序原始 4 字节编辑 | `#raw-bytes` `#btn-edit-raw` |
| 迁移对构建 / JSON 批量 `[["s","d"],…]` | `#pair-src` `#pair-dst` `#btn-add-pair` `#pair-list` `#pairs-json` `#btn-apply-json` |
| 执行整批（原子） | `#btn-run-batch`，耗时 `#timing`，明细 `#batch-summary` |
| 撤销 / 重做（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z） | `#btn-undo` `#btn-redo` `#history-list` |
| 导出整个原始转储 dump.bin | `#btn-export`（Playwright 可监听 download） |

## 自动化 / 脚本接口 `window.Rebinder`

Playwright/控制台可直接调用，所有写操作都会同步重渲染：

```js
Rebinder.views()                                  // 视图摘要
Rebinder.summary()                                // dumpLength / pairs / canUndo ...
Rebinder.resolvePath(viewName, 'pose[1].m[1][2]') // {ok,abs,rel,size,scalar,path}
Rebinder.queryOffset(21)                          // 所有覆盖视图的定位/填充结果
Rebinder.setOffsetQuery(21)                       // 同时驱动 Hex 翻页与右侧面板
Rebinder.editHex(view, path, 'deadbeef')          // 按视图端序写 32 位位型
Rebinder.editRawBytes(view, path, [0,0,0x50,0x41])
Rebinder.setPairs([['s0','d0'], ['d0','s0']])
Rebinder.runBatch([['s0','d0'], ...])            // 校验+冲突+写入+历史+刷新，返回 {writes,elapsedMs,...}
Rebinder.planBatch(pairs)                         // 只规划/校验，不改 dump
Rebinder.undo(); Rebinder.redo(); Rebinder.history()
Rebinder.dumpHex(off, len); Rebinder.dumpBytes()
Rebinder.exportDump()                             // 当前整份 Uint8Array
Rebinder.loadObjects(layoutObj, uint8)            // 原子装载
Rebinder.lastError()
```

核心引擎是 UMD 风格经典脚本，Node 中也可直接 `require`：

```js
const L = require('./web/js/layout.js');
const E = require('./web/js/engine.js');
```

## 迁移语义（严格按 samples 内 format.txt）

- 结构：同名成员递归，非共有成员略过；数组：共同索引递归，定长/动态可互迁，无共同索引时仍校验元素形状。
- 拒绝整批：节点类别不同、标量类型（i32/u32/f32）不同、向量宽度/分量类型不同、矩阵逻辑 R×C 不同（2×3 与 3×2 即使分量数相同也拒绝）。
- 矩阵按逻辑 `[r][c]` 匹配，各自按本行主/列主布局计算存储偏移。
- 每个分量先按**源端序**读成 32 位位型，再按**目标端序**写 4 字节；不做 f32 数值转换，跨端序保留位型。
- 所有提案从**批前转储**读位型（支持同一份 dump 内双向互换）；目标绝对字节重叠时逐字节比较，任一字节将被写成不同值即整批无效，错误给出绝对偏移。
- 先完整规划+冲突检测+捕获批前值，通过后才写入；失败不改 dump、不增历史。
- 一次成功编辑或一整批迁移各是一个历史项；撤销/重做按 native 位型还原原始字节；撤销后新的成功编辑/迁移清空重做链。
- 只写匹配到的标量 4 字节，填充与未写字节原样保留。

## 性能

热路径全部使用预分配 `Uint32Array/Uint8Array` 与单个 `DataView`：计数 → 展开提案并读源位型 →
位图+首值数组做逐字节冲突检测并捕获批前值 → 顺序写入。64 MiB dump、64 对、5,000,000 次写入的
Headless Chromium 实测“点击提交 → 可查询”约 **0.3–0.4 s**（含整页刷新），Node 引擎约 0.25 s，
相对独立 Python/Buffer 参考实现整份 64 MiB 导出**逐字节一致**。

## 自测

```bash
node tools/test-layout.cjs    // format.txt 全部给定偏移（32/20、212/184、224/192、28→40 …）
node tools/test-engine.cjs    // 端序互换、重叠冲突、原子失败、撤销重做、上限
node tools/test-matching.cjs  // 动态→定长、重排/独有字段、形状拒绝
node tools/bench-perf.cjs     // 500 万写入引擎基准
node tools/make-perf-files.cjs// 生成 .cache/perf-*（64MiB）与独立参考 perf-expected.bin
node tools/e2e-smoke.cjs      // Playwright：ZIP 样例、路径/反查、迁移导出、HEX、撤销、坏导入
node tools/e2e-perf.cjs       // Playwright：64MiB 文件上传、真实点击计时、导出逐字节核对
```

Playwright 使用本机全局安装的 Chromium（脚本内写死了全局 playwright 路径，可按环境修改 require）。
