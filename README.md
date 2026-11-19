# GWSV 沙盒存档检查与升级工具

一个纯浏览器端（无外部依赖、无网络上传）的 GWSV 二进制存档检查、编辑与规范化升级工具。读取两代存档（v1 直存 / v2 局部调色板+位打包），按高度切片查看与修改方块、移动实体并核对跨区块引用，导出统一的规范化 v2 存档。

## 目录

- `app/index.html` — 单页工具（样式、UI、交互；内嵌一份有效样例）
- `app/gwsv-core.js` — 解析、CRC32、位打包、规范化 v2 编码（浏览器 / Node 通用的 ES Module）
- `work/tools/gwsv_ref.py` — Python 参考实现（oracle），用 `python3 -I` 运行
- `work/tools/test-js.mjs` — JS 与 Python 参考实现的逐字节一致性测试
- `work/tools/e2e.mjs` — Playwright 端到端测试（51 项）
- `work/tools/responsive.mjs` — 响应式与主题测试（13 项）
- `work/test-vectors/vectors.json` — 由参考实现生成的测试向量
- `work/samples-extract/` — 解压后的样例（不受信任数据，独立目录存放）

## 二进制格式（依据样例内 `说明.txt`）

所有多字节整数小端。

```
文件头  magic[4]="GWSV" | version:u8 (1|2) | chunkCount:u16 | entityCount:u16   // 共 9 字节
区块 ×N  x:i16 y:i16 z:i16 | payloadLength:u32 | payload[payloadLength] | crc:u32
实体 ×M  length:u32 | utf8Json[length]
```

- 每区块 8×8×8 = 512 格，线性索引 `cell = x + 8*y + 64*z`。
- `crc` 为 payload 的标准 zlib CRC32（无符号）。
- v1 payload：512 个 u16 方块 ID（固定 1024 字节）。
- v2 payload：`paletteCount:u16`、`paletteCount` 个 u16 ID、`bits:u8`、位打包索引。
  `bits = max(1, ceil(log2(paletteCount)))`，打包体恰为 `ceil(512*bits/8)` 字节，
  第 i 个索引位于从低位起第 `i*bits` 位，索引必须 `< paletteCount`。
- 实体 JSON：`id`（正 u32，唯一）、`chunk`（必须存在的区块坐标）、`cell`（0–511）、`links`（实体 ID 数组，不得悬空或重复）。实体允许位于空气方块。
- 限制：区块坐标唯一、最多 128 区块、256 实体、文件 8MB、不允许尾随字节。

## 规范化输出规则

输出恒为 v2：

1. 区块按 `(x,y,z)` 数值字典序，实体按 `id` 升序。
2. 每区块调色板只保留**已使用**的方块 ID 并升序，`bits` 按规范重算。
3. 实体 JSON 键按字母排序、无多余空格（`{"cell":...,"chunk":...,"id":...,"links":...}`）。
4. 每区块重新计算 CRC32。

未编辑内容的语义完整保留；规范化输出再次导入得到完全相同的世界与引用关系，且二次编码字节级幂等。

## 损坏处理（不展示为正常世界）

| 损坏类型 | 呈现 |
| --- | --- |
| CRC 失配 | 区块标记"不可读"，切片显示斜纹占位，给出 CRC 字段字节偏移，禁止编辑/导出 |
| 截断数据 | 致命错误面板，指出需要的字节数与截断偏移，无法成世界 |
| 非法调色板索引 | 指出首个非法 cell、索引值与 packed 段偏移，区块不可读 |
| 悬空/重复链接 | 指出源实体 ID 与缺失目标 ID，链接红色标记，禁止导出 |
| 尾随字节 / 超上限 / 坏 magic / 坏版本 | 致命错误并给偏移 |

含实体的区块删除按钮禁用并提示先迁移实体；把实体移动到不存在区块、加入悬空链接同样被拒绝。

## 测试

```bash
# 1. 生成（或刷新）Python 参考测试向量
python3 -I work/tools/gen_vectors.py        # 见 work/tools 下相关脚本

# 2. JS 核心与参考实现逐字节比对
node work/tools/test-js.mjs

# 3. 端到端（需 Playwright Chromium）
node work/tools/e2e.mjs

# 4. 响应式与主题
node work/tools/responsive.mjs
```

所有解析与编码在本地完成，页面不发起任何网络请求（字体除外）。
