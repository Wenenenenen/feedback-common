# 回访录音按键音（DTMF）脱敏

纯静态网页，无需构建、无需联网：直接用浏览器打开 `index.html` 即可。

## 功能

- **导入**：8/16/48kHz、16 位 PCM、单/双声道 WAV，最长 60 秒（其他格式会被拒绝并提示）。
- **分析**：逐声道识别全部 16 个 DTMF 按键（0-9、A-D、*、#），给出字符、起止帧（结束帧不含）和毫秒。
  - 边界误差 ≤15ms（对 samples 标注实测 ≤1ms）。
  - 持续 ≥60ms 才计为按键；同键间隔 ≥40ms 分成两个事件，不会合并。
  - 覆盖 ±1% 频偏、双频幅度差 6dB、20dB 信噪比。
  - 20ms 短音、单频、三频同响、左右声道各一条频率，均不会误判为按键。
- **编辑**：事件可试听（前后带 150ms 上下文）、修改边界（毫秒，回车生效）、改键、删除、手工新增；波形图上点击色块选中事件。
- **脱敏**：可选「仅事件声道」或「两声道同时」；每个事件前后各扩 10ms 静音，扩展段外再接 5ms 线性渐变，重叠范围按并集处理。
- **导出**：脱敏 WAV 保留原采样率、声道数与总帧数，未触及采样逐位不变；事件 CSV（`channel,key,start_frame,end_frame,start_ms,end_ms`，声道 0 起）与导出音频基于同一份事件列表，始终一致。

## 文件

| 文件 | 说明 |
| --- | --- |
| `index.html` / `app.js` | 页面与交互逻辑 |
| `dtmf.js` | 纯算法库（浏览器/Node 通用）：WAV 读写、Goertzel 双音检测、边界精修、脱敏渲染 |
| `test/run-samples.mjs` | 用 `samples/dtmf-redaction.zip` 的标注验收检测（±15ms） |
| `test/redact-test.mjs` | 脱敏渲染不变量（格式保持、静音/渐变/原样区、并集、声道选择） |
| `test/e2e-test.mjs` | 端到端一致性（CSV 往返、脱敏后复检无按键、无事件声道逐采样不变） |
| `test/synth-test.mjs` | 合成对抗用例（16 键极限频偏/twist/噪声、相邻同键、负例、60s 全长） |

## 验收

```bash
unzip -o samples/dtmf-redaction.zip -d /tmp/dtmf-samples
node test/run-samples.mjs /tmp/dtmf-samples   # 标注比对
node test/redact-test.mjs /tmp/dtmf-samples   # 脱敏不变量
node test/e2e-test.mjs /tmp/dtmf-samples      # 端到端一致性
node test/synth-test.mjs                      # 合成对抗用例
```

## 检测原理

1. **帧级分类**：30ms 窗、10ms 帧移，对 8 个 DTMF 频率做 Goertzel 变换；要求低/高频组各有一个显著主峰（≥2×组内次峰，排除三频同响）、双频幅度差 ≤10dB（排除单频）、双音功率占帧总功率 ≥30%（排除噪声/语音）。
2. **成段**：同键连续帧成段，粗跨度 ≥35ms。
3. **边界精修**：用已知双频在 8ms 窗、1ms 步长下求包络，以「稳态幅度一半」为阈值线性插值定位起止点；精修后时长 <45ms 的段丢弃（排除 20ms 短音）。
4. **合并**：同键、间隔 <35ms 的段合并；≥40ms 间隔保持分开。
