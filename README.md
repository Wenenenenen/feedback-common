# 录音降位深校验台（Shaped Dither Workbench）

纯浏览器实现的 16-bit PCM 降位深校验工具，用于核对发行版从长录音截段后的
抖动序列与误差反馈是否与整轨版本一致。所有运算为精确整数运算，文件本地处理、
不上传；`index.html` 可直接以 `file://` 打开，无需构建、无外部依赖。

## 支持的输入

- WAV：48kHz、16-bit、无压缩 PCM，单声道或双声道，最长 180 秒
- ZIP：内含 `settings.json` 与一个 WAV（参考 `samples/dither-lsb.zip`），
  支持存储（method 0）与 deflate（method 8）两种压缩方式

`settings.json` 示例：

```json
{"bits": 5, "seeds": [23, 91], "resets": [[4800], []]}
```

- `bits`：丢弃位数 k（2–12），量化步长 2^k
- `seeds`：各声道非零 32 位种子
- `resets`：各声道的重置帧列表（可为空数组）

直接导入 WAV 时使用默认参数（k=5，种子 23/91，无重置），可在界面修改。

## 算法（每声道、逐样本）

各声道随机状态与误差互相独立，从种子与零误差开始。

1. 若当前帧在重置帧列表中：随机状态恢复为种子，误差 `e` 清零
2. 随机状态做两次 xorshift32，得到两个随机字 `w1`、`w2`
   （`x ^= x<<13; x ^= x>>>17; x ^= x<<5`，每次更新保留低 32 位）
3. 随机差 `d = (w1 mod 2^k) − (w2 mod 2^k)`
4. 加抖动前的值 `v0 = x + ⌊3e/4⌋`（向下取整，负数亦然）
5. 加抖动后 `v = v0 + d`
6. 按步长 2^k 就近量化，正好半档取偶数档（round half to even）
7. 夹位到 `[−32768, 32768 − 2^k]`
8. 误差反馈：未夹住时 `e = v0 − q`；量化值被夹住时 `e = 0`

逐样本查验表展示 `w1 / w2 / d / e_in / v0 / v / q / y / e_out` 及夹位、重置标记。

## 选区一致性

试听与导出始终基于**整轨逐样本渲染结果**再切片，半开区间 `[起点, 终点)` 内的
样本与整轨对应帧逐位相同，不会在截点重新初始化随机状态或误差。这正是本工具
要校验的性质：截段版本只有沿用整轨在该帧的状态才可能与整轨一致。

## 目录结构

```
index.html            页面
css/app.css           样式
js/dither-core.js     整数 DSP、WAV 解析/导出、参数校验（UMD，Node 可直接 require）
js/zip-import.js      最小 ZIP 读取器（存储/deflate，DecompressionStream）
js/app.js             界面逻辑、分块异步渲染、波形、选区、试听、导出
tests/e2e.js          Playwright 端到端测试
tests/perf-browser.js 浏览器内满长性能测试
samples/dither-lsb.zip 示例设置与输入 WAV
```

## 测试

需要本机可用的 Playwright 与 Chromium：

```bash
# 端到端（导入、渲染、逐样本、选区导出一致性、非法输入拦截）
NODE_PATH=$(npm root -g) node tests/e2e.js
# 满长 180 秒双声道性能（预算 8 秒）
NODE_PATH=$(npm root -g) node tests/perf-browser.js
```

`js/dither-core.js` 为 UMD 模块，可在 Node 中 `require` 后与独立参照实现做
逐样本对拍。

## 性能

180 秒 × 48kHz 双声道（8,640,000 帧/声道）在主流笔记本浏览器中渲染约 0.7 秒、
含界面调度约 1.3 秒，整轨 WAV 导出编码另约 0.1 秒，满足 8 秒预算。渲染按
262,144 样本分块让出主线程，界面保持响应并显示进度。
