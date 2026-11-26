# 偏振照片 Stokes 复原工作台

纯前端（无第三方运行时依赖、无现成优化或偏振重建库）的偏振成像复原页面。
导入 4–12 张同尺寸 16 位灰度 PGM 与标定清单（ZIP），逐像素在物理锥约束下
最小化含单边饱和罚的加权平方残差，求 Stokes 量 (s0, s1, s2)。

## 运行

直接用浏览器打开 `index.html` 即可（所有脚本为本地 ES5 风格 IIFE，无需构建、无需服务器）。
建议用 Chromium 内核浏览器。样例：`samples/polarimetric-stokes-cases.zip`。

## 数学模型

未截断预测（曝光标定已吸收共同强度比例）：

```
p_i = offset_i + (gain_i/4) · ( s0 + (u_i·s1 + v_i·s2)/5 )
```

残差按实测码值 m 取单边形式，避免把过/欠饱和码值当实测亮度：

- 普通 `0 < m < 65535`：`r = p − m`
- 下饱和 `m = 0`：`r = max(0, p)`
- 上饱和 `m = 65535`：`r = min(0, p − 65535)`

在物理可行锥 `s0 ≥ sqrt(s1² + s2²)` 内最小化 `Σ w_i r_i²`。
仅统计启用且掩膜可用的帧。启用、掩膜可用且未饱和的不同 (u,v) 方向少于 3 个时，该像素标为无解。

### 求解方法（全部手写，见 `src/solver.js`）

1. **主动集（active set）** 处理饱和帧的分段二次罚，工作集只增不重复。
2. 固定主动集下为凸二次规划：内部解走 3×3 正规方程（高斯消元）；
   越界则在锥边界 `x = s0(1,cosθ,sinθ)` 上做多级角度网格 + WLS 投影热启动 + 黄金分割。
3. 收尾用 BB 步长非单调投影梯度抛光，并以“当前真实截断状态的二阶 WLS 热启动”
   克服病态 Hessian 的线性慢收敛；最后在锥边界对 θ 做分段闭式射线优化。
4. 凸性保证全局最优；用归一化 KKT 残差独立核验（`tests/kkt_check.js`，实测最差 ~1e-7）。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/zip.js` | 手写 ZIP 容器解析与 RFC1951 inflate（stored/deflate）、CRC32、路径穿越防护 |
| `src/io.js` | `case.json` 严格校验、16 位灰度/8 位掩膜 PGM 解析、项目组装 |
| `src/solver.js` | 逐像素 Stokes 求解（主动集 + 锥约束二次规划 + 投影梯度） |
| `src/render.js` | 强度灰度、DoLP 顺序带、角度循环带的伪彩/灰度渲染，无解品红标记 |
| `src/app.js` | 状态机、可取消分块重算、代际隔离（只发布与最新设置一致的结果）、导出 |
| `src/ui.js` | DOM 绑定、帧开关、视图切换、画布选像素、明细表 |
| `index.html` | 页面与样式（自动深浅色） |

### 并发与一致性

每次切换帧都会令上一代计算作废（runId + 设置指纹双校验）。分块调度在让出事件循环的
同时保证：只有代际最新、且启用帧指纹与当前设置完全一致的结果才会被发布；重算中可继续
切换并再次重算，不会出现中间态“幽灵”结果。

## 输入/输出约定

输入 ZIP 根目录含 `case.json` 与 `frames/ii.pgm`，可选 `masks/ii.pgm`，细节见样例包内
`format.txt`。坏输入抛出带**具体文件名或字段名**的错误，且不破坏当前已加载项目。

导出 UTF-8 JSON：`{ width, height, enabled, pixels }`，`enabled` 为升序启用帧下标，
`pixels` 为行优先一维数组，元素为 `[s0,s1,s2]` 或 `null`（无解），数值为原始码值尺度。

## 测试

无第三方前端依赖；测试用 Node 内置断言，端到端用全局 Playwright，独立参考求解器仅用 Python 标准库。

```bash
node tests/solver_test.js      # 求解器单元（锥约束、饱和罚、无解、权重、掩膜）
node tests/validation_test.js  # 19 项坏输入校验（文件/字段级报错）
node tests/app_test.js         # 代际隔离、导出格式、坏输入保留项目
node tests/e2e_test.js         # 真实 Chromium 端到端
node tests/perf_test.js        # 满额 256×256×12 帧端到端 8 秒预算
node tests/kkt_check.js <zip> <result.json>   # KKT 最优性独立核验
python3 -I tests/reference_solver.py <case_dir> <out.json>   # 独立枚举参考实现
python3 -I tests/gen_cases.py <dir>           # 含饱和/掩膜/无解的合成用例
python3 -I tests/gen_stress.py <dir>          # 满额压力用例
```

实测满额（256×256、12 帧、约 10.8 万饱和观测）导入到可导出约 3.8 秒，满足 8 秒预算。
