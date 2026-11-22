# RPA1 录音无损归档与抽查

录音无损归档格式 **RPA1** 的编解码实现，以及一个可直接使用的网页抽查台：导入 WAV 生成归档，或打开已有归档；逐块核对选参、偏移与 CRC32，任意区间试听并导出**完好**片段。

格式与样例见 `samples/rice-pcm-cases.zip`（内含 `格式.txt`、`mono16.wav`、`stereo24.wav`）。

## 打开网页

直接用浏览器打开构建产物 `index.html`（单文件，含样式、编解码与示例，无需服务器、无外部依赖），或：

```bash
node tools/build.js      # 由 src/ + styles.css + samples.js 重新生成 index.html
```

页面支持：

- **载入 WAV**（拖放或选择，或点「载入 mono16 / stereo24」示例）：校验 PCM WAV 子集，显示读数，点击「编码并下载 RPA1」。
- **打开 `.rpa` 归档**：立即解析头与块目录，做 CRC 与块头校验。
- **块状态图**：每块一格，颜色区分完好 / 块损坏 / 索引损坏；点击定位并试听该块。
- **逐块选参表**：模式（原始 / 中侧）、两路的预测阶与 Rice k、偏移、块字节数、状态；可筛选「仅异常 / 块损坏 / 索引损坏」，点击展开偏移与目录/实际 CRC。
- **任意区间试听与导出**：以整数帧左闭右开指定，只解码相交块；区间可用时试听与导出 WAV 均启用。
- **损坏隔离**：块损坏时点名块号并禁止跨坏块区间；索引损坏时点名条目并保持归档打开；头错误时保留上一个已打开的归档。
- **损坏演练**：在内存副本上模拟索引/块损坏，验证定位与隔离，可一键恢复。

## 格式要点（实现在 `src/rpa1.js`，零依赖、浏览器与 Node 共用）

- **WAV 子集**：小端 RIFF、PCM 格式码 1、一个 `fmt ` + 一个 `data`，遍历时按 RIFF 偶数字节补齐。8–48 kHz、16/24 位、单/双声道、≤90 秒。
- **RPA1 头**：`"RPA1"` | u32 采样率 | u8 声道 | u8 位深 | u32 总帧数 | u32 块数；块数 = ⌈总帧 / 1024⌉。
- **块目录**：每块 u32 绝对偏移、u32 块长、u32 CRC32（与 `zlib.crc32` 一致，覆盖整块）。首块紧随目录，末块止于文件尾。
- **块**：u8 模式（0 原始，1 中侧），接每路 `(u8 阶, u8 k)`，随后依次写各路完整位流，块末补最少 0 到字节边界；位流 MSB 先出。
- **预测**：0 阶为 0，1 阶为前值，2 阶为 `2*前值 − 前第二值`；每块每路历史为 0。残差 `r` 映射为 `u = 2r`（r≥0）或 `u = −2r−1`（r<0）。
- **Rice 与转义**：`q = ⌊u/2^k⌋`；`q<31` 写 q 个 0 + 1 + 低 k 位；`q≥31` 写 31 个 0 + 28 位原始 u。
- **选参**：每路在 0–2 阶 × 0–15 Rice 参数中按**未补齐的位流位数**选最短；双声道在原始与中侧两种模式间选总位数最小者。同长依次比较模式号、第一路阶数、第一路 k、第二路阶数、第二路 k。

## 目录

```
index.html            构建产物（浏览器直接打开）
styles.css            样式
samples.js            内嵌示例（base64）
src/rpa1.js           编解码核心（RPA1 命名空间）
src/app.js            页面逻辑
src/index.template.html  页面骨架（构建时内联）
tools/build.js        构建 index.html
tools/reference.py    Python 参考实现（用于交叉校验）
tools/genwav.js       生成 90 秒测试 WAV
tests/                测试（见下）
```

## 测试

```bash
node tests/rpa1.test.js          # 单元：往返、区间、损坏、边界
node tests/random_crosscheck.js  # 48 组随机配置与 Python 参考逐字节比对
node tests/crosscheck.js         # 示例与 Python 参考逐字节比对
node tests/fuzz.js               # 解码器模糊测试（不崩、不卡）
node tests/e2e.js                # 浏览器端到端（需 Playwright + Chromium）
node tests/inpage_correct.js     # 页内解码逐样本核对
node tools/genwav.js             # 生成 /tmp/big90.wav
node tests/perf90.js             # 90 秒 48kHz 立体声 24 位，点击到下载 < 8s
node tests/big90_bytecheck.js    # 浏览器产出 90 秒归档与参考逐字节一致
node tests/run-all.js            # 汇总（不含大文件基线与时限测试）
```

浏览器测试使用 Playwright 的 Chromium（本机已安装于 `~/.cache/ms-playwright`）。

## 性能

90 秒 48 kHz 双声道 24 位（约 4,219 块、2,590 万字节 PCM）：浏览器端点击编码到触发下载约 **2.7 秒**（要求 < 8 秒）；编码采用异步分块，界面保持响应并显示进度。全量解码约 1.4 秒。〔在 WSL2 / Chromium 上测得，随硬件变化。〕
