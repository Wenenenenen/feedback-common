# 分片 MP4 重新分段工具

纯前端（无第三方封装库）的 fragmented MP4 重分段网页。自行解析 fMP4 盒结构与
分片索引，按勾选的视频关键帧重建分段，保证每个样本的字节、标志、DTS/PTS 与
时长不变，仅重建 moof/trun 寻址。

## 运行

页面是纯静态资源，任意 HTTP 服务器均可：

```bash
cd public
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

打开页面后选择单个分片 MP4（`ftyp` + 前置 `moov` + 若干 `moof`/`mdat`）。
支持 H.264 视频轨与可选 AAC 音轨，目标规模 512 MiB、30 万样本。

## 页面能力

- 轨标签切换视频/音轨；解码顺序 / 显示顺序（按 PTS，同刻按解码序号）切换。
- 表格虚拟滚动，仅渲染可见行，30 万行不建全量 DOM。
- 视频关键帧行可勾选为新边界，首帧边界强制保留；提供全选/重置。
- 实时预览分段数与各段音频样本分布。
- 两个导出：
  - **按新边界导出**：重建 moof/mdat，段从所选关键帧 DTS 起切。
  - **按原方案导出**：保留原分片切分（moof/mdat 负载逐字节），仅清理 moov 旧索引。
- 样本越界 / 重叠作为可恢复警告列出（含轨、样本号、偏移），不阻断原方案导出。

## 目录

```
public/
  index.html        页面结构
  app.css           样式
  app.js            交互、虚拟表格、切点状态、导出编排
  mp4/
    io.js           大端 ByteReader/ByteWriter，统一盒头读取（含 64 位 largesize）
    parse.js        顶层扫描、moov/moof/traf/tfhd/tfdt/trun 解析与校验、cleanMoov
    write.js        新分段 moof/mdat 构造、trun 版本分组、原方案导出与基址重定位
tools/
  *.mjs             Node 与 Playwright 测试、合成 fMP4 生成器
  box_dump.py       只读盒树检查工具
  fmp4_inspect.py   字段级检查工具
```

## 关键设计

- **不读媒体负载建索引**：解析只取盒头与 moof/moov 元数据，mdat 负载保留在
  原 `File` 中；导出用 `Blob.slice` 零拷贝拼装。512 MiB 文件索引堆增量约 0.2 MiB。
- **64 位时间**：DTS/tfdt/基址统一用 BigInt；CTS 按 trun 版本以 u32 或 i32 精确
  存入 Float64Array（两类值域都能被精确表示）。
- **寻址**：tfhd 显式 u64 基址与 default-base-is-moof 二选一；trun 无 data_offset
  时续接本 traf 上一 trun 末尾；逐样本 → tfhd 默认 → trex 默认三级回落。
- **trun 版本**：负 CTS 用 v1（i32），非负用 v0（u32，含 >INT32_MAX 的值）；
  一组 trun 无法兼容全部偏移时自动拆成多个 trun。
- **音频归段**：样本 DTS 与边界比较，归属“最后一个边界 ≤ 样本 DTS”的段，
  即跨界包按起点归段、同刻进后段；首段收下早于首视频样本的音频，末段收剩余。
- **空轨省略**：某段无音频样本时不写该轨 traf。

## 测试

```bash
# 样例往返（逐样本字段 + 压缩字节 + 原方案逐字节）
node tools/test_repack.mjs samples/extracted/two-tracks.mp4
# 合成 fMP4 的解析覆盖面（显式基址、tfdt v0/v1、trun v0/v1、默认值链、续接）
node tools/test_synth.mjs
# 畸形输入负向校验
node tools/test_negative.mjs
# 64 位 largesize
node tools/test_largesize.mjs
# 音频边界与空轨省略
node tools/test_boundary.mjs
# CTS 版本分组边界
node tools/test_cts.mjs
# 30 万样本性能（索引 < 8s，实测约 0.3s）
node tools/test_perf.mjs
# 512 MiB 内存与零拷贝
node --max-old-space-size=2048 tools/test_huge.mjs
# 浏览器端到端（依赖全局 Playwright）
node tools/test_e2e.mjs samples/extracted/two-tracks.mp4
```

## 输入约束（与 samples/extracted/约定.txt 一致）

单视频轨 + 可选单音轨，各轨单条本地样本描述；moov 无普通样本、无编辑列表、
无加密；视频首样本为关键帧且关键帧均为闭合 GOP 入口；仅 32 位盒大小与
size=1 扩展大小，size=0 仅限文件末尾顶层盒。
