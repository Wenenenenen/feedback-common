# AmbiX 方向校准台 · 一阶全景声方向校准

展厅换朝向时，常把**声道顺序**（文件里哪一路是 X、哪一路是 Y）和**听者转头方向**
（声场该往哪转）混在一起。本页把两件事拆开：

- **文件格式**由你手动指定：AmbiX（ACN / SN3D，W Y Z X）或 FuMa（W X Y Z，W 为 AmbiX 的 √2 倍）。
  不按声道掩码猜测，也不按普通四声道环绕声理解。
- **旋转方向**由你按右手系（X 前 / Y 左 / Z 上）给出，采用**主动旋转** `q·v·q⁻¹`：
  声场整体逆着听者转头方向转回去。静态欧拉角按 `Rz(yaw)·Ry(pitch)·Rx(roll)`。

> 四声道一阶 B-format 不是普通 4.0 环绕声。W 是全向项，**不参与旋转**。

## 功能

### 输入
- 拖入或选择 WAV：四声道、整数 PCM、**44.1 / 48 kHz**、**16 / 24-bit**、时长 **≤ 60 s**。
  逐项校验并给出具体原因（声道数、位深、采样率、帧对齐、时长、RIFF 结构）。
- 输入格式手选 AmbiX / FuMa；页面显示格式换算矩阵 `M` 与包内 `monitor_rows_wyzx` 监听矩阵。
- 载入后显示采样率、位深、帧数、时长、峰值、声道掩码（仅提示，不用于判断格式）。

### 旋转（两种模式互斥）
1. **静态欧拉角**：yaw / pitch / roll 以度输入（数字框 + 滑块），四元数 `q = qz(yaw)·qy(pitch)·qx(roll)`
   实时显示。整段使用同一矩阵。
2. **关键帧四元数**：`[w, x, y, z]` 按**采样帧**定位。
   - 端点之外保持最近端值，不外推；
   - 四元数导入即归一化；相邻点积为负时翻转后一项，**走最短弧 SLERP**；
   - **拒绝**零四元数、重复帧、非递增帧、非整数帧、负帧、超出 `[0, N-1]` 的帧；
   - 可在表格里直接改 `frame` 与四个分量，行内显示等价欧拉角；
   - 支持导入 / 导出 `{"keyframes":[{"frame":…,"q":[…,…,…,…]}]}`（也接受裸数组）。

切到哪种模式，就只有那种模式参与渲染。切换不会清除另一种模式的数据，也不会把两者叠加。

### 试听与方向
- 时间轴显示四条旋转后包络（按当前输出格式的通道序）与关键帧标记；可点击/拖动定位。
- 播放/暂停、任意拖动试听；拖动时方向示意与四元数读数同步更新。
- 方向示意：斜投影单位球，显示旋转后的 X/Y/Z 轴与声场「前」方向，附方位角/仰角。
- 监听解码用 `monitor_rows_wyzx` 的 L/R 两行，**只用于试听**，不进入导出，不改变电平。
- 当前帧四通道电平与数值读数，供逐帧核对。

### 输出
- 24-bit PCM 四声道 WAV，可选 **AmbiX**（W Y Z X）或 **FuMa**（W X Y Z）。
- **采样率与帧数保持不变**，位深统一为 24-bit。
- 只做格式换算与旋转，**不做响度归一化、不限幅**。
- 任一通道出现超出 `[-1, 1)` 的样点时：显示峰值、溢出样点数、首个溢出帧与通道，
  **阻止 PCM 导出**；不会自动压低音量。改角度或换 FuMa 输出可让 W 回到范围内。
- 可另存格式 JSON：记录输入/输出布局、通道序、归一化、采样率、帧数、旋转模式与曲线、
  监听矩阵与统计，便于归档。
- 页面带「参考文件核对」：载入参考样例时自动把导出级渲染与
  `reference-automated-48000-24.wav` 逐样点比较（允许 ±4 个 24-bit 整数单位）。

## 启动（WSL / Linux）

```bash
./scripts/start.sh            # 默认 8000，可传端口
# 或
python3 -I src/py/server.py --port 8000
```

打开 <http://localhost:8000/>。纯标准库、无 CDN、无外部依赖、离线可用。
首次启动会把 `samples/ambisonic-cases.zip` 解压到 `samples/extracted/`
（不可信数据：只读提供，不执行）。

## 自检

```bash
./scripts/selfcheck.sh          # Python 交叉核对 + Node 单元测试
./scripts/selfcheck.sh --e2e    # 另加 Playwright 浏览器端到端
```

- `tests/crosscheck.py`：独立的标准库实现，从 `conventions.json` 重新推导一遍，
  逐样点核对参考 WAV、FuMa↔AmbiX 换算、溢出样例、44.1 kHz / 16-bit、无效 automation。
- `tests/node_check.mjs`：四元数/欧拉角、最短弧 SLERP、关键帧拒绝路径、格式换算矩阵、
  24-bit 量化、WAV 编解码与拒绝、参考逐样点、溢出判定、监听解码、预览/导出同源、模式互斥。
- `tests/e2e_check.mjs`：浏览器端实际操作——样例、播放、拖动、方向示意、导出字节与参考比对、
  静态角、溢出阻止导出且无下载、关键帧增删改与四类拒绝、JSON 导入导出、格式切换、44.1 kHz。

样例参考值（`samples/ambisonic-cases.zip`）：

| 样例 | 核对点 |
|---|---|
| `ambix-48000-24.wav` | 288,000 帧；峰值 0.12；前向正负脉冲串 |
| `reference-automated-48000-24.wav` | 与 `automation.json` 曲线逐样点一致（±4 整数单位；实测 0） |
| `fuma-48000-24.wav` | 同一信号；W 为 AmbiX 的 1/√2，序为 W X Y Z |
| `ambix-44100-16.wav` | 264,600 帧；44.1 kHz / 16-bit |
| `overload-48000-24.wav` | yaw=45° 时 Y≈1.131，24000 个样点溢出 → 阻止导出 |
| `automation.json` | 6 帧；含端点保持、最短弧翻转与近零分量归一化 |
| `invalid-zero.json` | 零四元数，应拒绝 |
| `invalid-duplicate.json` | 重复帧 0，应拒绝 |

## 目录结构

```
src/py/server.py              本地静态服务 + 样例 API（路径白名单，防目录穿越）
src/web/index.html            页面与样式（暗色，无外部资源）
src/web/js/app.js             主线程：导入、校验、参数、时间轴、试听、导出、竞态
src/web/js/rotation-worker.js Worker：整段渲染、监听解码、WAV 编码、参考核对
src/web/js/wav.js             16/24-bit PCM WAV 解析与 24-bit 编码
src/web/js/quaternion.js      四元数、欧拉角、SLERP、方向换算
src/web/js/automation.js      关键帧校验 / 序列化 / 曲线求值
src/web/js/ambisonic.js       AmbiX / FuMa 通道序与换算矩阵
src/web/js/rotation-mode.js   静态角 / 关键帧两种模式的互斥入口
src/web/js/dsp/rotation.js    规范序换算、逐帧旋转、24-bit 量化、逐格式统计
src/web/js/player.js          监听矩阵解码与 Web Audio 播放
src/web/js/draw.js            Canvas 时间轴与方向示意
tests/                        Python 参考、Node 单元、浏览器端到端
scripts/start.sh              启动
scripts/selfcheck.sh          一键自检
```

## 实现说明

- **统一内部表示**：无论输入 AmbiX 还是 FuMa，都先换到规范序 `[W, Y, Z, X]`
  （W 按格式乘增益）。旋转只作用于 `(X, Y, Z)`，W 原样通过。
- **一次渲染、两处使用**：Worker 的 `renderCanonical()` 同时被预览与导出调用；
  导出优先复用预览用同一 rotation 渲染出的 24-bit 整数平面，因此**预览与导出逐样点一致**。
- **量化**：规范序浮点 → 24-bit 整数用「四舍五入到最近整数，.5 远离零」。
  与参考文件逐样点比较，最大差 0。
- **FuMa 的 W**：导出时由原始输入的 W 直接乘 `1/√2` 再量化，不经过第二次量化。
- **溢出判定**：按未量化样点 `|x| ≥ 1`，与格式相关（FuMa 的 W 阈值是 `√2`）。
  只有确实越界才阻止导出。
- **性能**：60 s / 48 kHz 的整段渲染在普通桌面 CPU 上约 0.3–0.5 s；
  分块渲染并在块间让出事件循环，界面全程可操作。

## 安全

- 样例 ZIP 按不可信数据对待：解压到独立目录，只作为静态文件提供，不执行其中内容；
  解压时跳过绝对路径、`..`、隐藏文件与非白名单字符。
- Python 以 `-I` 隔离模式启动；`/api/sample` 路径逐段白名单校验并复核 resolve 结果。
- 样例包里的 `conventions.json` 只读解析：监听矩阵形状/数值异常时退回内置值。
- 页面零外部请求，所有计算在本地浏览器完成。
