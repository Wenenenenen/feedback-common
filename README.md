# 星座图短音频来源检索

在本地素材库中检索一段短录音的来源。基于 Shazam 风格的**频谱峰星座图 + 成对指纹 + 倒排索引 + 时间偏移投票**，
对调低音量、反相、混入底噪等变换保持鲁棒；全部计算在本地完成，**不依赖任何现成音频识别服务**。

## 功能

- **指纹流水线**（参数严格遵循素材包 `说明.md` 约定）
  - 16kHz / 16bit / 单声道 PCM，`x = PCM/32768`
  - STFT：N=512、hop=128、周期 Hann 窗 `0.5-0.5cos(2πn/N)`，只分析完整窗口
  - 频谱峰：频率箱 3–230，左右各 2 箱局部最大（等值取较小箱），不低于全文件最大幅值 −40dB，
    每帧按幅值降序/箱号升序最多 4 个；全文件最大幅值 < 1e-5 判为静音无峰
  - 成对指纹：锚峰与后续 4–24 帧的峰配对，按帧差/目标幅值/目标箱号排序，每锚最多 4 对
  - 哈希 = (锚箱, 目标箱, 帧差) 三元组
- **倒排索引**：SQLite 保存库文件、频谱峰与 `哈希 → (库文件, 锚帧)` 发布表
- **时间偏移投票**：同哈希产生 `d = 参考锚帧 − 查询锚帧`；对每个候选整数中心，
  统计偏移落在 `[d−1, d+1]` 内的**不同查询配对数**（每配对最多 1 票）；
  最佳中心取票数最多、d 最小；`score = 票数 / 查询总配对数`，**≥12 票且 score≥0.25** 才可靠
- **网页**
  - 频谱热力图上叠加频谱峰与配对连线，可开关连线
  - 点击任意配对连线，展示该指纹的哈希、命中的发布表、每条命中的偏移计算与最终计票依据
  - 结果给出来源、起点（样本 `d×128` 与秒）、支持票数、匹配比例；可靠/不可靠分别标识
  - 重复来源（指纹一致）同时列出；静音与无关查询明确显示「无可靠匹配」
  - 每张结果卡可直接试听**来源对应区间**（自动从偏移起点播放、区间结束暂停）与查询录音
  - 支持上传添加、移除库文件，以及按库目录现存文件**重建索引**（用于替换文件）
  - 导出 JSON / Markdown 检索报告
- 约束：库最多 8 条、每条 ≤20s；查询 0.25–8s；上传时严格校验采样格式

## 运行

仅依赖 Python 3.10+ 与 numpy（FFT 用 `numpy.fft`，Web 服务用标准库 `http.server`）。

```bash
pip install -r requirements.txt
python3 -m app.server --host 127.0.0.1 --port 8000
# 浏览器打开 http://127.0.0.1:8000
```

## 目录

```
app/
  audio.py        WAV 读取与格式/时长校验
  fingerprint.py  STFT、频谱峰、成对指纹
  index.py        SQLite 倒排索引与库文件管理
  matcher.py      时间偏移投票、可靠性判定、配对级解释
  multipart.py    multipart/form-data 解析（标准库）
  server.py       HTTP 服务与 API
  static/         前端页面（无框架、无构建）
tests/
  validate_samples.py          对照素材包 truth.json 的端到端验证
  test_voting_equivalence.py   向量化投票与朴素定义对拍、约定边界测试
  ui_test.js                   Playwright 浏览器端到端测试
data/                          运行时生成：索引、库副本、最近查询音频（不入库）
```

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/library` | 库文件列表与门槛参数 |
| POST | `/api/library/add` | multipart 上传 WAV 入索引 |
| POST | `/api/library/remove` | `{"file_id": ...}` 移除并删除副本 |
| POST | `/api/rebuild` | 按库目录现存文件重建倒排索引 |
| POST | `/api/query` | multipart 上传查询 WAV，返回指纹、星座图、全部候选与可靠匹配 |
| GET | `/api/explain?query_id=&pair=` | 某条查询配对为何投到某个时间 |
| GET | `/api/audio?kind=library\|query&...` | 试听音频 |
| GET | `/api/constellation?file_id=` | 库文件星座图数据 |
| GET | `/api/report?query_id=&format=json\|markdown` | 导出检索报告 |

## 测试

```bash
python3 tests/validate_samples.py
python3 tests/test_voting_equivalence.py
NODE_PATH=$(npm root -g) node tests/ui_test.js   # 需本机 Playwright
```

## 设计说明

- 偏移单位为样本 `d×128`，表示**查询时刻 0 映射到来源的位置**，不自动去掉查询开头静音。
- 每条参考只输出一个最佳偏移；结果按 score 降序、票数降序、文件标识升序排列。
- 投票用 numpy 向量化实现（排序 + 二分窗口 + 一维编码去重 + bincount），
  与逐中心集合朴素定义在 `tests/test_voting_equivalence.py` 中随机对拍等价。
- 库文件标识使用导入时的唯一名称（重名自动追加 `-2`、`-3`…）。
