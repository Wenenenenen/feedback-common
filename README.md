# G53 灰度图渐进传输编码实验

手工实现的 G53 渐进灰度流实验台：整数 5/3 可逆提升 + 带符号位平面流，支持把 8 位灰度
PNG 编码成可分片到达的字节流，在浏览器里模拟“低清预览逐步补细节”的接收过程。

所有小波变换、位平面打包、容器记录、CRC32、PNG chunk/滤镜均为自行实现；没有调用任何
现成小波库，也没有用其他编码器替代 G53 流。第三方代码只有 `pako`（zlib 压缩，规范明确
允许）。

## 运行

```bash
npm install          # 仅安装 pako（也可直接使用仓库内 assets/pako.min.js）
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/index.html
```

直接双击 `index.html` 在部分浏览器下也可运行，但通过 http 服务加载样例最稳妥。

## 目录结构

```
index.html              实验台页面
src/g53.js              G53 核心：5/3 提升、位平面流、G53A 容器、渐进解析器
src/png8.js             最小 8 位灰度 PNG 读写（手工 chunk/滤镜，zlib 用 pako）
src/app.js              页面交互
src/zlib-browser.js     pako 适配器
assets/pako.min.js      pako 2.x（zlib）
assets/samples/         内置样例（含任务包内 5 张 + 边界尺寸补充图）
tests/g53.test.js       核心逻辑 Node 测试（397 项断言）
tests/png8.test.js      PNG 模块测试（含全部 5 种反滤镜）
tests/browser.smoke.js  Playwright 页面冒烟测试（41 项）
scripts/g53_reference.py  独立 Python 参考实现（只按 README 规范编写，用于交叉验证）
scripts/cross_check.py    JS/Python 双向字节级交叉验证
scripts/extract_raw.py    样例 PNG 转原始灰度
```

## 测试

```bash
node tests/g53.test.js
node tests/png8.test.js
python3 -I scripts/extract_raw.py
# 生成 Python 参考流后
node scripts/gen_js_streams.js
python3 -I scripts/cross_check.py
node tests/browser.smoke.js   # 需先在仓库根目录起 http 服务
```

## G53 格式要点（实现所依据的规范）

- 像素先减 128，不量化；对每行再每列做整数 5/3 提升：
  - `d_i = o_i - floor((e_i + e_min(i+1,last)) / 2)`
  - `s_i = e_i + floor((d_max(i-1,0) + d_min(i,last) + 2) / 4)`
  - 长度为 1（无奇项）时原样；单轴为 1 时继续变换另一轴。
- 头部 14 字节小端 `<4sIIBB`：魔数 `G53A`、宽、高、实际层数、最高幅值位号
  （全零系数为 255，头后无层）。
- 每个位平面一条记录，13 字节小端 `<BIII`：位号、解压字节数、压缩字节数、
  CRC32（针对解压负载），后接 zlib 负载。
- 负载按最终系数矩阵行优先、MSB 优先打包；每系数每层 1 个幅值位，首次出现 1 时
  紧随符号位（负为 1）；尾部补零且补齐位必须为 0。
- 渐进语义：未收位视为 0、不补中点；末尾不完整记录等待更多字节；完整但 CRC 错误
  （或 zlib 无法解压）立即报错，不得当成截断；层位号必须连续递减。
- 完整流 inverse 后 +128 逐像素还原；显示允许夹紧，误差判定在有符号域进行、不提前夹紧。

## 实现中处理的关键边界

- 奇数长度末端高频只有一个相邻偶项（`n=2` 时回退到 `e_i` 自身）。
- 多级分解系数矩阵保持全尺寸，每级只就地变换左上低频子区域。
- 负系数幅值与符号分开存储，避免 32 位有符号位运算在置高位时污染数值。
- 单行、单列、1×1、1024 最大边、全零系数、非字节对齐的补齐位均走同一套格式。
