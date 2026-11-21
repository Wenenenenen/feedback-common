# 游戏音频处理图演算台

一个纯静态网页工具，用于调试游戏音频处理图：并行效果链汇合时的**路径延迟对齐**，
以及带正整数采样延迟的**反馈边**。渲染器为自研，按样本顺序精确求值，
**切换每批处理的样本数（block size）结果逐位一致**。

## 打开方式

直接用浏览器打开 `index.html` 即可（无构建、无网络依赖）。

## 图的 JSON 描述

```jsonc
{
  "sample_rate": 48000,        // 必须 48000
  "frames": 192,               // 1..480000（最长 10 秒）
  "output": "mix",             // 输出节点 id
  "nodes": [                   // ≤ 64 个
    { "id": "src",  "type": "impulse", "events": [[0, 0.125], [4, 0.125]] },
    { "id": "fast", "type": "gain",    "points": [[0, 1], [8, 0.5]] },
    { "id": "slow", "type": "latency", "samples": 3 },
    { "id": "mix",  "type": "mix" }
  ],
  "edges": [                   // ≤ 128 条
    { "src": "src", "dst": "fast" },                        // 普通边：无 delay
    { "src": "mix", "dst": "mix", "delay": 2, "gain": 0.5 } // 反馈边：正整数 delay
  ]
}
```

## 语义约定（与 `samples/约定.txt` 一致）

- **普通边**无 delay，必须构成前向有向无环图；成环时页面会指出环上的节点和一条具体环路径。
- **反馈边**带正整数 delay 和有限 gain，读源节点过去的输出，初态为 0，不参与路径延迟对齐。
- **路径延迟对齐**：在普通边上插入补偿延迟，使得到达同一节点的各普通路径总延迟相等
  （取最长路径），并行效果链汇合后不会再听到两次瞬态。页面会列出每条普通边插入的补偿。
- 节点先将各对齐普通输入和各反馈输入相加，再做节点运算：
  - `latency`：实际延迟 `samples` 帧；
  - `gain`：按节点当前样本时刻在线性关键帧间插值，两端保持；
  - `mix`：直接输出输入和；
  - `impulse`：无输入节点，按 `events` 输出脉冲。
- 输出 48kHz 单声道 IEEE float32 WAV。

## 页面功能

- 编辑 JSON、latency 延迟、反馈边 delay/gain、gain 关键帧（页面与 JSON 双向同步）；
- 查看每个节点的输入/输出时刻、每条普通边插入的补偿；
- 节点探针：指定节点和样本，查看其附近每条输入边的贡献、输入合计与输出；
- 切换每批样本数渲染，"一致性自检"用多种批大小逐位比较；
- 试听（WebAudio）与导出 float32 WAV。

## 文件结构

```
index.html          页面
css/style.css       样式
js/graph-engine.js  渲染引擎（浏览器 / Node 通用）
js/app.js           页面逻辑
test/run-tests.js   引擎测试：node test/run-tests.js
samples/            样例图与约定（audio-graph-cases.zip 及解压内容）
```

## 测试

```sh
node test/run-tests.js
```

覆盖：`graph.json` 前 14 样本与 `first14.json` 逐位一致、补偿计算、
7 种批大小渲染结果逐位一致、普通边成环报错并列出环上节点、
零延迟反馈拒绝、探针数值、WAV 头、节点数/时长上限。
