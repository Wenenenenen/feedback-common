# 顶点取数回放台（vertex-stream-reel）

一个纯前端的顶点取数抓帧回放工具。读取解包后的 `capture.json`，在同一组缓冲上
逐条回放 `write` / `copy` / 索引三角形 `draw`，并支持角点探针批量查询。不依赖任何
现成图形捕获库，全部回放、解码与时间线追踪都在本仓库的 `app/engine.js` 中实现。

## 运行

直接用浏览器打开 `app/index.html` 即可（`file://` 可用，数据不离开本机），或：

```bash
cd app && python3 -m http.server 8080
# 打开 http://localhost:8080/
```

- 「载入样例」内置了 `samples/vertex-stream-cases.zip` 中的抓帧与探针。
- 也可点「导入 capture.json」或把文件拖进页面；探针文件在抓帧之后拖入即可。

## 测试

```bash
npm test                 # 引擎语义单测（node:test，23 项）
npm run test:e2e         # Playwright 端到端（需本机 Chromium，32 项）
```

## 实现要点（对应格式约定）

| 约定 | 实现位置与做法 |
| --- | --- |
| 初始缓冲 ≤16 MiB、命令 ≤5 万、累计改写 ≤64 MiB | `parseCapture` 全量预校验，任一非法即拒绝整份抓帧并指出命令号/缓冲编号 |
| 同一缓冲反复更新、逐字节最后改写命令号 | `Replayer` 为每个缓冲维护 `Int32Array writers`，初始 `-1`；`write`/`copy` 按目的区间逐字节覆盖命令号 |
| 重叠拷贝取命令前源字节 | `copy` 先 `slice` 源区间快照再写入目的，源/目的同缓冲也正确 |
| 跳到任意 draw 按当时缓冲取数 | `seek(ci)` 单调前进、回退则重置后重放到 `ci`；探针按 draw 排序后单遍单调回放 |
| 索引 u16/u32、`firstIndex+k`、有符号 `baseVertex` | `evalCorner`；索引越界则 `vertex=null` 且不取属性；负槽号保留原索引字节并报错 |
| 实例属性 `floor((firstInstance+j)/divisor)`、零步长重复同址 | 槽号用整数除法；地址 `at + stride*slot`，`stride=0` 时地址恒为 `at` |
| 非对齐小端读取 | `DataView` + 字节地址，无对齐前提；地址运算用 `BigInt` 防溢出 |
| f32x2 / snorm16x2 / unorm8x4 / rgb10a2unorm | `decodeField`，含 `-32768 → -1`、10/10/10/2 位解包 |
| 越界或非有限值只跳过所属三角形 | 按三角形（每三角）汇总角错误；坏字段 `hex/value/writers=null`，非有限值保留 `hex/writers`、`value=null`，同角其他字段照常报告 |
| 线框 position+offset、缺省 offset 为零、NDC 裁剪 | `cornerPoint` + Canvas 裁剪矩形 |
| 探针 ≤256、同序导出、六字段结构 | `parseProbes` 全量校验；`runProbes` 输出 `{draw,instance,corner,vertex,skipped,fields}` |
| 256 条前后半段交替探针 2 秒内 | 排序后单遍回放；满额压力实测约 45 ms（见性能单测） |
| 非法命令指出编号、保留上一份抓帧 | UI 仅在解析成功后替换状态，失败时保留当前抓帧并展示错误编号 |

## 目录

```
app/
  engine.js     回放引擎（无 DOM 依赖，Node 与浏览器通用）
  index.html    单页应用：时间线、线框、角详情、探针导入导出
  sample.js     内置样例
tests/
  engine.test.js  引擎语义与性能单测
  e2e.js          浏览器端到端测试
cases-extract/    样例压缩包解包内容（只读输入，不作为代码加载）
```
