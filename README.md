# 录音漂移校准工作台

纪录片采访后期用：多台录音机开机时间不同、长录音逐渐错位（时钟漂移）。本工具在本地网页中
估计每条待校准轨到参考轨的线性时间映射 `t_ref = a · t_track + b`，显示偏移 `b` 与漂移
`(a−1)×10⁶` ppm，支持手动锚点修正、对齐波形预听与 48kHz/16位/双声道 WAV 导出。

**完全离线**：零 npm 依赖、无 CDN、无网络请求，断网可用。

## 启动

```bash
node server.js          # 默认端口 8123，PORT=9000 node server.js 可改
```

- WSL 内启动后，Windows 浏览器打开 `http://localhost:8123`（WSL2  localhost 转发）；
  若不通，使用启动时打印的 WSL IP（如 `http://172.x.x.x:8123`）。
- 无需 `npm install`，Node ≥ 14 即可。

## 使用流程

1. **导入参考 WAV**（一条）与**待校准 WAV**（多条）。
   支持 44.1/48kHz、16/24 位 PCM、单/双声道，单轨最长 3 分钟；立体声取双声道均值。
2. 每轨自动在 Web Worker 中分析（页面保持可操作，可随时**取消**，立即生效）。
   结果显示 `b`（秒）与漂移 ppm；共同片段不足 10 秒或内容无关时提示**证据不足**。
3. 选中一轨：上方波形为参考轨，下方为按当前映射对齐后的待校准轨（同一参考时间轴）。
   **点击**波形跳转预听（左声道=参考，右声道=待校准轨）；**拖动**选择导出范围。
4. 自动结果不理想时，用**两对时间锚点**手动修正（锚点1/锚点2 的待校准轨时间与参考时间）。
5. **导出 WAV**：按参考时间范围导出 48kHz/16位/双声道，预听与导出使用同一映射，缺失区补零。
6. **保存项目**为不含音频的 JSON；**打开项目**后重新导入原音频文件即恢复校准参数。
   同名但内容不同的文件会弹出提示，可选择是否仍恢复参数。

## 算法说明

- 双声道先混为单声道，重采样到 8kHz，提取 16ms 窗 RMS 能量的正向差分作为**起音包络**
  （静音/掉音段包络为零，自动不参与匹配）。
- 阶段一：200Hz 包络分块全局互相关 + RANSAC 直线拟合，得粗 `(a, b)`；
  重复片段造成的错误相关峰作为离群点被剔除。
- 阶段二：1kHz 包络在粗映射预测位置 ±150ms 内局部相关，抛物线插值到亚毫秒，
  再次 RANSAC + 最小二乘精化。
- 证据门槛：内点锚窗并集覆盖 ≥ 10 秒且平均相关强度达标，否则判证据不足。

## 验收

```bash
unzip -o samples/clock-drift-fixtures.zip -d /tmp/fixtures
node test/acceptance.js /tmp/fixtures                      # 算法精度验收（对照 truth.json）
NODE_PATH=$(npm root -g) node test/e2e.js /tmp/fixtures    # 端到端 UI 验收（需 Playwright）
```

- `truth.json` 仅供验收脚本核对，**应用本体从不读取它**（应用只读取用户手动选择的文件）。
- 当前素材验收结果：两条有效轨四个参考时标（10/30/60/85s）误差均 < 0.1ms（限值 10ms）；
  `short-overlap.wav`（共同 3 秒）与 `unrelated.wav` 均正确判为证据不足。

## 目录结构

```
server.js              零依赖静态服务器（绑定 0.0.0.0）
public/
  index.html           页面
  app.js               主线程 UI：导入、调度、波形、预听、导出、项目存取
  analysis-core.js     漂移估计核心（Worker 与 Node 双模式）
  dsp.js               FFT/重采样/包络/相关/RANSAC/映射渲染（预听与导出共用）
  wav.js               WAV 解码（16/24位PCM、单/双声道）与 16位立体声编码
  worker.js            分析 Worker（terminate 即取消，世代号防旧任务覆盖）
test/
  acceptance.js        算法精度验收（唯一读取 truth.json 的文件）
  e2e.js               Playwright 端到端测试
samples/               验收素材（clock-drift-fixtures.zip）
```
