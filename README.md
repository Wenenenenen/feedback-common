# 踏板 / 偷声声部复现器

游戏音符引擎的声部复现网页：导入 JSON 事件与速度表，按 `samples/pedal-voice-cases/约定.json`
的规则做限复音分配与 48kHz 单声道离线合成，把逻辑记录（声部状态机）和实际声音放在一起核对。

## 运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

页面为纯静态文件（`index.html` + `engine.js` + `app.js`），无构建步骤。
`file://` 直接打开时样例下拉无法 fetch，请用「导入」选择本地 JSON。

## 功能

- 导入项目 JSON（ppqn / duration_ticks / tempo / events），校验并逐条报告非法输入
  （tick 越界、tempo 重复、channel 超界、事件数 >5000、项目 >30s 等）
- 可调参数：attack/decay/sustain/release（ms）与复音上限（1..32），修改即整体重算，不沿用旧缓存
- 钢琴卷帘：按键（蓝）/ 踏板保持（黄）/ release（绿）/ 被偷声（红框 + ✕），底部细条为各通道踏板区间
- 时间游标：点击/拖动定位，右侧面板显示该帧每个声部的状态与包络值，可从游标处播放试听
- 导出：48kHz 单声道 24 位 WAV（不归一化，超界饱和）与逐声部 JSON 报告
  （帧级 on/key_up/release/end、原因 stolen|release|project_end、未配对 off、削波采样数）

## 测试

```bash
node test/engine.test.mjs
```

对照 `samples/pedal-voice-cases/reference/` 的期望输出校验引擎（76 项断言）。
