# 栅格测区矩量台（clipped-raster-moments）

扫描灰度图上任意测区（可越出图像、可含孔）的精确灰度矩计量工具。解决斜边切像素时
按像素中心取样导致窄条重心跳格的问题：所有积分在 **BigInt 有理数** 上对测区与像素
方格的真实相交面积进行，绝不使用中心取样或超采样。

## 精确性方案

- 顶点坐标为 1/16 像素整数；测区可越出图像，最多 1024 个顶点。
- 每个环独立用 Sutherland–Hodgman 对每个像素格做精确裁剪（BigInt 分数）。
- 外环正向贡献、孔环扣减；孔与外环均先按面积符号归一，因此结果与绕序无关。
- 裁剪多边形的 0–2 阶矩由 Green 定理闭式给出，每格灰度为常量，加权矩 = 几何矩 × 灰度。
- 分数全程保持约分、分母为正；只计落在图像内的部分。
- 零质量（M00 = 0）时重心与协方差输出 `null`。

六个矩为 `Mij = ∫ gray·x^i·y^j dA`（i+j ≤ 2）：M00、M10、M01、M20、M02、M11。
协方差是以 M00 归一化的二阶中心矩。

## 目录

| 路径 | 作用 |
|---|---|
| `src/bigfraction.js` | BigInt 有理数（含热路径用的未约分 raw 运算） |
| `src/pgm.js` | 二进制 P5 PGM 解析（8 位 / 大端 16 位） |
| `src/zip.js` | 最小 ZIP 读取（stored / deflate，浏览器与 Node 双路解压） |
| `src/validate.js` | 测区合法性校验，错误带环/顶点/边定位 |
| `src/moments.js` | 精确裁剪 + Green 积分引擎、单格贡献、重心、协方差 |
| `src/reference.js` | 独立的第二套逐格裁剪实现，仅用于引擎对拍 |
| `src/region.js` | 区域数据与坐标文本编辑 |
| `src/export.js` | 约分分数 JSON 导出 |
| `src/worker-client.js` | 异步计算包装 |
| `src/app.js` / `index.html` | 网页界面 |
| `tools/reference.py` | Python `Fraction` 独立参考实现 |
| `tools/gen_cases.py` | 确定性测试用例生成器 |
| `tests/run-tests.mjs` | 单元 + 全量 Python 分数对拍（8000+ 断言） |
| `tests/cross-check.mjs` | JS 两套独立实现互验 |
| `tests/e2e.mjs` | Playwright 浏览器端到端测试 |

## 运行

纯静态页面，任意 HTTP 服务器即可（ES module 不能用 `file://` 直接打开）：

```bash
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

## 测试

```bash
python3 -I tools/gen_cases.py     # 生成 tests/cases/
node tests/run-tests.mjs          # 单元 + 与 Python 参考的逐格精确分数对拍
node tests/cross-check.mjs        # JS 引擎 vs JS 独立裁剪器
node tests/e2e.mjs                # 浏览器端到端（需 Playwright）
```

对拍在每个用例上比较六个总量矩和每个相交像素格的面积与六个加权分量，全部以约分
分数严格相等判定，而非浮点容差。

## 校验规则

外环必须是简单多边形；孔必须是简单多边形、严格位于外环内部、孔之间互不碰触
（不相交、不触边、不包含）。非法修改（自交、共线重叠、触边、孔越界、顶点超 1024
等）会返回带环号与顶点/边索引的定位信息，界面保留上一个合法测区。
