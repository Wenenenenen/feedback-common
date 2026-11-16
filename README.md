# APNG Disposal Studio

活动贴纸局部更新帧的残影排错工具：自行解析 APNG 动画控制块（acTL / fcTL / fdAT）、
自行实现分帧与处置合成，浏览器只负责把合成好的像素画到画布上，不使用浏览器内置 APNG
播放，也不使用任何现成 APNG 合成器。

## 能力边界

- 仅接受 8 位、颜色类型 6（RGBA）、非隔行 PNG/APNG
- 最多 120 帧、1024×1024、50MB
- 单帧 PNG 的 zlib 解压/压缩委托 pako（ESM 构建，见 `lib/pako.esm.mjs`）；
  块结构、CRC、PNG 行过滤器逆变换、APNG 分帧、混合与处置全部手写

## 四态画布

每个帧并排展示四张画布，红框标出该帧的更新矩形：

1. **局部原帧** — fcTL 帧矩形内、解码后的原始像素
2. **合成前 before** — 本帧绘制前的整幅画布
3. **展示时 shown** — 按 blend_op 绘制后、处置前的画面
4. **处置后 after** — 按 dispose_op 处置后的画面，即下一帧的 before

支持棋盘格透明背景、整数倍像素缩放、悬停取像素 RGBA 值。

## 语义与计时约定（与 samples 包内 约定.json 一致）

- 每轮循环从全透明画布开始
- `blend_op=0` SOURCE 直接替换；`blend_op=1` OVER 按 straight alpha 混合，每步四舍五入到 8 位
- `dispose_op`：0 NONE 保留 / 1 BACKGROUND 区域清透明 / 2 PREVIOUS 恢复绘制前
- 透明像素之间的比较只核对 alpha
- `delay_den=0` 按 100 解释；`delay_num=0` 播放时用 10ms 下限，**导出仍保存原始分子分母**
- 单帧时长保留有理数，累计时间不提前取整
- `num_plays=0` 无限循环；有限次数播完停在最终 shown 画面（最后一帧的处置不展示）

## 可编辑项

每帧的 `delay_num`、`delay_den`、`dispose_op`、`blend_op`，以及 acTL 的 `num_plays`。
图像数据与帧矩形不可改。修改早期帧后整段动画重新合成，后续画面与时间轴缩略图即时刷新。

## 导出

- **修改后的 APNG**：保留全部原始图像数据块（IDAT/fdAT 负载逐字节不变）与默认图是否
  参与动画的结构；重建所有块 CRC，fcTL/fdAT 共享的序号空间从 0 连续重排
- **完整展示帧 PNG 序列**：每帧 shown 画面编码为独立 PNG，打包成 ZIP（STORE，零依赖）
- 导出结果重新导入后，解析参数与合成画面与编辑态一致（测试覆盖往返一致性）

## 错误定位

校验签名、块 CRC、块长度、帧数、帧矩形越界、fcTL/fdAT 连续序号与截断。每个错误给出
块类型与字节偏移（CRC 错误另给 CRC 字段偏移），多个问题聚合展示，绝不降级为静态图
冒充成功。

## 目录结构

```
index.html            页面与样式
src/
  crc32.js            IEEE CRC-32
  png-codec.js        手写 PNG 块封装/行过滤器，编解码 8-bit RGBA
  apng-parser.js      APNG 块解析、分组与全部校验
  compositor.js       跨 IDAT/fdAT 拼流、解码、SOURCE/OVER 与三种处置
  apng-exporter.js    仅改控制字段的 APNG 重建
  zip-store.js        STORE 方式 ZIP 打包
  canvas-view.js      像素精确缩放、棋盘格、取色
  app-state.js        编辑状态与重新合成
  main.js             UI 控制器、时间轴、播放、导出
lib/pako.esm.mjs      pako 2.1.0 ESM 构建（仅 zlib 用途）
tests/                Node 与 Playwright 测试
```

## 测试

```bash
node tests/node-test.mjs            # 与包内 36 张参照图逐像素比对等 115 项
node tests/export-test.mjs          # 导出 CRC/序号/字节级往返 33 项
node tests/error-aggregate-test.mjs # 多错误聚合 5 项
node tests/browser-test.mjs         # Playwright 端到端 53 项（需全局 Playwright）
```
