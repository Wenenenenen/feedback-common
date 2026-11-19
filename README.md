# 组件树面积过滤台

纯前端灰度图连通区域面积过滤工具。自己构建最大树（max-tree）与最小树（min-tree），
按面积阈值把小亮斑 / 小暗坑降到最近保留祖先，**不做模糊、不依赖阈值合并顺序**。

## 解决的问题

模糊会改变平台区域的灰度，而阈值分割在阈值变化时，平台区域的合并顺序不同会产生不一致结果。
组件树把所有上水平集（max-tree，`{p: I[p] >= level}`）或下水平集（min-tree，`{p: I[p] <= level}`）
的连通分量组织成一棵包含关系树：

- 同灰度平台规范合并为一个节点，节点平区是该灰度下新进入的像素；
- 节点面积 = 平台自身像素 + **全部后代像素**；
- max-tree 父节点灰度严格更小，min-tree 父节点灰度严格更高；
- 每个掩膜连通分量形成一个根，根无条件保留。

面积过滤只在这棵固定的树上做判定：`area >= A` 的节点保留，不足的节点取最近保留祖先的原图灰度。
阈值 A 变化只改变保留/滤除判定，树结构不变，因此结果确定、可复现。

## 核心算法（`src/component-tree.mjs`）

自研 Salembier 式分层并查集漫洪，不调用任何现成组件树 / 面积开闭 / 逐灰度完整重建实现：

1. 像素按灰度分 256 桶；max-tree 从高灰度向低灰度漫洪，min-tree 反向；
2. 每层先激活像素，层内合并同灰度平台，再并入已激活的异灰度分量；
3. 每个 DSU 分量携带当前树节点，被吸收的旧分量节点成为新节点的孩子；
4. 每条像素邻边在整个构建中只扫描一次（非逐灰度全图重建），路径压缩近线性；
5. DFS 后序累加子树面积，DFS 前序编号 `tin/tout` 支持 O(1) 子树归属查询。

掩膜外像素不激活、不建树，`pixel_node` 记 `-1`，过滤时照抄原灰度。

## 页面功能（`index.html`）

- 导入单边 ≤ 1024 的 8 位灰度 PNG，可选同尺寸二值区域掩膜（灰度非零即有效，也支持 1 位 PNG / alpha 通道）；
- 树类型（最大 / 最小）、邻接（四 / 八）、面积阈值 A 实时切换；
- 在原图或过滤图上**点选像素**，查看所属节点到根的完整路径（灰度、面积、平台面积、本阈值下保留状态）；
- 在节点列表点行，画布高亮该节点的**完整连通区域**（淡填充 + 边界描边）；
- 阈值快照对比：叠加显示相对快照阈值的灰度升高 / 降低像素并计数；
- 导出过滤后 8 位灰度 PNG，以及含节点父子关系、代表像素、面积、逐像素节点索引的 JSON。

## 导出 JSON schema

```json
{
  "width": 6, "height": 6,
  "tree": "max", "connectivity": 4, "area_threshold": 8,
  "masked": true,
  "nodes": [
    { "id": 0, "parent": null, "level": 15, "area": 14,
      "plateau_area": 8, "representative": [0, 3] }
  ],
  "pixel_nodes": [2, 2, -1, 9]
}
```

`pixel_nodes` 行优先，每个像素指向其原灰度对应的规范节点 id，掩膜外为 `-1`。
仅靠 `nodes` 的 `parent` 与 `pixel_nodes` 即可独立重建整棵层级并重算面积，供复核。

## 文件结构

| 路径 | 说明 |
| --- | --- |
| `src/component-tree.mjs` | 组件树构建、面积过滤、导出 JSON（无 DOM 依赖，Node/浏览器共用） |
| `src/image-io.mjs` | 自研 PNG 解码/编码（过滤与 chunk 自写，压缩走平台 zlib） |
| `src/canvas-view.mjs` | 画布渲染、节点区域高亮、差异叠加 |
| `src/app-state.mjs` | 页面状态与交互逻辑 |
| `index.html` | 单页界面 |
| `test/component-tree.test.mjs` | 样例 expected.json 比对 + 220 张随机图暴力水平集模糊测试 |
| `test/e2e-browser.mjs` | Playwright 端到端：导入、点选、切参、对比、导出、超限拒绝 |
| `test/verify-export.mjs` | 导出 PNG/JSON 的独立解码与层级重算复核 |
| `tools/read-png.mjs`、`tools/serve.mjs` | 离线检查脚本与本地静态服务器 |

## 运行

无构建步骤、无第三方运行时依赖（浏览器用内置 `CompressionStream`，Node 用内置 zlib）。

```bash
npm run serve          # 打开 http://localhost:8750/
npm test               # 核心算法单元 + 模糊测试
npm run test:e2e       # 浏览器端到端（需 Playwright）
npm run test:export    # 导出复核
```

## 性能（参考）

| 图像 | 配置 | 节点数 | 建树 | 过滤 |
| --- | --- | --- | --- | --- |
| 128×128 medium.png | max / 4 邻接 | 6,919 | ~26 ms | ~0.2 ms |
| 1024×1024 最坏随机图 | max / 4 邻接 | ~57 万 | ~1.4 s | ~87 ms |

随机噪声是节点数最多的最坏情况；真实图像灰度平滑，节点数远少于像素数。
