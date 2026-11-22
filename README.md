# PGS Plane Inspector

PGS（HD-Graphics 位图字幕）网页检查工具，针对样例包 `samples/pgs-plane-cases.zip` 约定的合成子集：

- 只用 PCS `Normal` 与 `Epoch Start`；PTS 以 PCS 为准，显示集到 **END 段才提交**
- Epoch Start 清掉对象、窗口、调色板；普通段可复用前一状态
- `state=0x80` 且对象数为 0 = **只更新调色板**，保留上一次对象列表
- `state=0x00` 且对象数为 0 = **真正清屏**
- 裁剪矩形在对象内，裁完的左上放到 PCS 坐标，再依次按窗口、画布裁剪
- 对象按 PCS 列表顺序做 source-over；强制标记位 `0x80`、裁剪位 `0x40`
- 色彩按限幅 BT.709 YCbCr→直通道 RGBA；透明黑清屏

## 用法

```bash
# 任意静态服务器（ES 模块不能用 file:// 直接打开）
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

导入限制：SUP ≤ 20MB，画布 ≤ 1920×1080。支持点击按钮选择或拖拽到画布区。

### 功能

| 功能 | 说明 |
| --- | --- |
| 时间轴 | 滑块/上一段/下一段/点色带跳转；色带按 epoch/normal/palette/clear 着色，强制段左侧紫色条 |
| 仅看强制字幕 | 非强制状态在画面上变空白，区间 JSON 同步过滤 |
| 点像素检查 | 显示坐标、RGBA、参与叠加的对象条目（含"旧对象带入/缺 ODS/沿用列表/裁剪"标记）与放置矩形 |
| 导出 PNG | 当前画面的直通道透明 PNG（棋盘格只是背景，不进图） |
| 导出 JSON | 90kHz tick、半开 `[start,end)` 区间；最后一个区间的 `end` 用右上角"结束时刻"输入框给 |
| 解析失败 | 错误条给出段号与段头/文件字节偏移（十六进制） |

## 子集编码要点（解析器据此实现）

- 段头：标准 13 字节 `PG` + PTS(4) + DTS(4) + type(1) + len(2, 大端)
- PCS：11 字节固定头（state 在偏移 8、count 在偏移 10），条目 8 字节；带裁剪位追加 8 字节裁剪矩形
- WDS：`id16 flags16 x16 y16 w16 h16`（大端，12 字节/条），裁剪位追加 4 字节
- ODS：6 字节头（1 字节 objectId）+ RLE；头里不带尺寸，宽高由行布局与 WDS/PCS 几何交叉推断
- RLE：支持标准操作码（字面量、`0000` EOL、`0001` EOB、`00NN`/`0002 LLHH` 零游程），子集流常缺 EOB，按 W×H 隐式收尾
- 纪元边界：对象型 PCS 的 composition number 不前进即为新 Epoch；零对象 PCS 的调色板/清屏分类优先于纪元判断

## 测试

```bash
node tools/test-parser.mjs   # 三个样例的端到端解析/合成/区间/报错偏移
node tools/test-units.mjs    # RLE 变体、BT.709、source-over 与裁剪单元测试
node tools/json-check.mjs    # 打印 layers.sup 的导出 JSON 形状
```

样例解析结论：

- `layers.sup`：4 个已提交状态（epoch → palette → clear → normal），调色板段正确沿用强制对象
- `stale.sup`：PCS 引用当前纪元不存在的 ODS id 时沿用上一位图，诊断条明确标出"旧对象被带进新段"
- `truncated.sup`：第二个显示集缺 END 且文件有 9 字节残尾；第一个显示集仍上时间轴，错误锚定 PCS 段偏移 `0xc5`

## 目录

```
index.html          页面（UI + 交互）
js/pgs.js           纯 ES 模块解析器/合成器/区间构建，浏览器与 Node 通用
tools/              Node 测试与只读逆向脚本（dump.py/infer.py/solve.py 用 python3 -I 运行）
samples/extracted/  解压后的不可信样例，保持独立目录，脚本不从中运行
```
