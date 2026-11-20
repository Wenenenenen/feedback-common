# 光泽环境探针 · 预过滤立方体贴图烘焙器

零依赖的网页工具：导入六面线性浮点环境图，按余弦幂（光泽反射）核生成多档粗糙度
预过滤立方体贴图，提供跨面双线性采样、确定性球面重要性采样与积分，并支持可视化检查
与浮点 PFM 导出。不调用任何现成环境预过滤接口。

## 运行

```bash
# 任意静态服务器即可（ES module 需经 http 访问，不能 file:// 直开）
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/
```

## 输入约定

JSON 含 `size`（边长，1–64）与 `faces`，六个面 `px/nx/py/ny/pz/nz`，每个面为
行优先的线性 RGB 三元组数组，HDR 不裁剪。面内 `u,v` 由左上 `(-1,-1)` 到右下 `(1,1)`，
纹素中心 `(col,row)` 对应 `u=-1+2(col+0.5)/N`、`v=-1+2(row+0.5)/N`。

## 数学实现（严格对应样例包 `说明.txt`）

### 方向表（均归一化）

| 面 | 方向 d | 反解 u,v |
|----|-------|----------|
| px | `(1,-v,-u)` | `u=-z/x, v=-y/x` |
| nx | `(-1,-v,u)` | `u=-z/x, v= y/x` |
| py | `(u,1,v)` | `u= x/y, v= z/y` |
| ny | `(u,-1,-v)` | `u=-x/y, v= z/y` |
| pz | `(u,-v,1)` | `u= x/z, v=-y/z` |
| nz | `(-u,-v,-1)` | `u= x/z, v= y/z` |

方向→面：按绝对值最大坐标选面，并列按 `px,nx,py,ny,pz,nz` 顺序（符号须与面一致）。
反解先由主导分量还原归一化系数 L，再除回单位平面坐标。

### 跨面双线性

像素坐标 `((u+1)N/2-0.5, (v+1)N/2-0.5)`，标准双线性四邻点与权重。**越界邻点**：
仅夹越界的那个坐标、另一坐标保持，取原面该边/角纹素中心方向重新选面，再取邻面
最近纹素；四个原始双线性权重保持不变。这保证了接缝处不塌陷、不暗化。

### 核与确定性采样

- 指数 `n = max(0, 2/(r*r) - 2)`
- 核 `(n+1)/(2π) · max(dot(d,ω),0)^n`，对 d 的半球积分
- 样本 `i`：`xi1=(i+0.5)/S`，`xi2` 为 i 的二进制位反转小数（Van der Corput 基数 2）
- `cosTheta=(1-xi1)^(1/(n+1))`，`phi=2π·xi2`
- 局部帧：`|d.z|<0.999` 时 `a=(0,0,1)` 否则 `a=(0,1,0)`；`t=normalize(a×d)`，`b=d×t`
- `ω = t·sinθcosφ + b·sinθsinφ + d·cosθ`
- 重要性采样结果 = S 个环境（双线性）取值的等权平均；`r=0` 直接取 d 方向环境（重采样）

### 预览与导出

- 显示映射 `1-exp(-exposure·value)` 后标准 sRGB 编码；**仅作用于预览，浮点导出不变**
- PFM：`PF` 头、宽高、`-1.0`、小端 RGB float32、底行优先
- 每面输出 ≤ 32×32；每纹素采样数 64–1024；默认档位 `r = 0, 0.25, 0.5, 1`，默认 S=256

## 文件结构

```
index.html        页面骨架
styles.css        样式（亮/暗自适应）
app.js            UI、状态、渲染、反射球、检查器、导出
app/cube-core.js  纯计算核心（方向/双线性/采样/积分/PFM），Node 与浏览器共用
app/zip.js        零依赖 ZIP（store + CRC32）
tools/            独立验证与测试脚本（不参与页面运行）
samples/extracted/  样例数据（含说明.txt）
```

## 验证

`tools/` 下含两套相互独立的实现与多层测试：

- `reference_bake.py` —— 独立 Python 参考实现（不看 JS），用于跨语言数值对拍
- `verify_bake.py` —— 跨语言对拍 + 常量保持 + 接缝连续性检查
- `verify_independent.py` —— 以 `direction.json` 已知编码 `0.5(d+1)` 为解析真值锚点，
  不 import 任何被测实现，独立验证 r=0 同尺寸中心对齐的精确还原
- `test_core.mjs` —— 确定性（两次烘焙逐位一致）、半球/归一化、常量积分、r=0、位反转序列
- `test_pfm.mjs` —— PFM 底行优先字节序与往返、大小端读回
- `e2e.mjs` —— Playwright 真实浏览器端到端（导入、四档烘焙、纹素检查、反射球、导出 ZIP）

运行（在仓库根目录）：

```bash
node tools/test_core.mjs
node tools/test_pfm.mjs
node tools/e2e.mjs
# 跨语言对拍（Python 用 -I 隔离，路径参数化）
python3 -I tools/reference_bake.py samples/extracted/highlight.json /tmp/py.json 32
node tools/node_bake.mjs samples/extracted/highlight.json /tmp/js.json 32
python3 -I tools/verify_bake.py /tmp <见脚本参数>
```

### 已验证结论

- 常量环境 `[0.25,1,4]` / `[0.2,0.4,0.8]`：所有档位、面、纹素逐值保持
- 跨语言对拍最大误差 ≤ 2.4e-7（仅 float32 量化）
- 独立锚点 r=0 同尺寸还原误差 ≤ 3e-8，无超差纹素
- 跨 px/pz 缝高光在粗糙档下接缝相邻列 R 通道差 ≈ 0（无暗化）
- 相同输入两次烘焙逐位一致；PFM 往返无损；导出 ZIP 通过标准库 CRC 校验

## 页面功能

- 六面展开图（输入/当前粗糙度输出可切），点击输出纹素查看中心方向、线性 RGB 与
  逐条采样追踪（方向、命中面、环境值、权重）及采样方向分布图
- 可拖动旋转的反射球，反射方向实时映射当前粗糙度贴面
- 曝光、粗糙度、输出边长、采样数调节；导出含 24 个 PFM（4 档 × 6 面）、`config.json`
  与全量 `sampling-trace.json` 的 ZIP
