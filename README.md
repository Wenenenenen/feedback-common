# 铰链骨架逆运动学校验台 (Hinge IK Workbench)

面向带关节限位、共享底座多末端机械臂的逆运动学 (IK) 校验网页。纯前端、零第三方依赖，
求解器为自行实现的 Levenberg–Marquardt 阻尼高斯-牛顿法，不调用任何现成 IK 库。

## 目录结构

```
app/
  hinge-ik-solver.js   求解器核心: FK、解析雅可比、LM、盒约束、Cholesky、确定性自检
  app.js               应用: 3D 软件渲染、轨道相机、目标拖拽、UI 状态、配置存取
  index.html           页面骨架与样式 (明暗双主题)
tools/
  solver_proto.py      Python 参考原型 (仅标准库, python3 -I 运行)
  test_solver.py       原型合成测试 (3D 轴、限位、锁定、热启动追踪、奇异位形诚实停滞)
  crosscheck.js        JS 求解器对样例期望与 known-pose 的对拍
  test_iterator.js     验证单步迭代器与一次性 solve 完全等价、可复现
  browser-smoke.js     Playwright 端到端测试 (渲染/求解/拖拽/槽位/错误输入)
  build.js             内联打包为单文件 dist/hinge-ik-workbench.html
dist/
  hinge-ik-workbench.html   构建产物, 双击即可在浏览器离线运行
```

## 运行

直接打开 `dist/hinge-ik-workbench.html`（`file://` 即可，无需服务器、无需联网）。
重新构建：

```bash
node tools/build.js
```

## 数学模型

与样例 `说明.txt` 完全一致：

- 关节世界矩阵 `W_j = W_parent · T(offset_j) · R(axis_j, angle_j)`，根父矩阵为单位阵，无缩放。
- 末端世界点 `p_e = W_joint · point_e`。
- 代价函数
  `cost = Σ_e weight_e · |p_e − target_e|² + λ · Σ_j (θ_j − rest_j)²`，
  角度用弧度，正则项包含锁定关节的常量。
- 角度始终投影在 `[min, max]` 内，不做周期越界；`locked` 关节不参与更新但影响所有后代。

## 求解算法

Levenberg–Marquardt 阻尼高斯-牛顿：

1. 解析位置雅可比 `∂p_e/∂θ_j = axis_world × (p_e − pivot_j)`（仅对祖先关节非零），
   末端按 `√weight` 加权；正则项贡献对角行 `√λ`。
2. 法方程 `(JᵀJ + μ·diag(JᵀJ)) Δθ = −Jᵀr`，自实现 Cholesky 分解求解。
3. 盒约束投影：每步把角度 clamp 回限位区间。
4. 接受/拒绝：总代价下降才接受并下调 μ，否则上调 μ 重试。
5. 停止策略：
   - 全部末端位置误差 `< positionTolerance` 且相对代价变化收敛 → `converged`；
   - 投影梯度接近零（约束局部最优）、找不到下降方向或步长下溢 → `stalled`，如实报告残差；
   - 达到 `maxIterations`（上限 2000）→ `max_iterations`。
   **不可达目标绝不显示为已到达**，并给出停止原因与各末端残差。

### 确定性

整条路径不含 `Math.random`、`Date` 或任何随机源，阻尼初值与调度为固定常量。
同一初值任意多次求解，角度、每轮日志逐位一致（页面内“确定性自检”按钮可现场双跑比对）。
单步按钮与“运行到停止”由同一个 `IKIterator` 驱动，逐轮累积结果与一次性求解完全相同
（`tools/test_iterator.js` 验证）。

### 共享关节

角度状态按关节 id 全局唯一存储；两个末端挂在同一底座/共享子树时，雅可比在同一组关节变量上
累加，一次法方程联合求解，共享关节只保留一个状态，拉动任一目标都会通过该共享状态联动另一条链。

## 功能

- 可旋转/缩放/平移的 3D 骨架，显示关节旋转轴、关节点、当前末端（绿）与目标（黄，可拖拽）。
- 拖动目标球在相机平面移动，按住 Shift 沿视线深度移动；也可用数字输入精确设定目标 xyz。
- 每个关节可手工改角度（滑杆/数字，自动限位）、可锁定/解锁。
- 单步、运行到停止、暂停、重置为初值；显示每轮总代价、位置代价、正则项、最大误差、阻尼 μ。
- 各末端独立位置误差与到达着色；不可达时显示停止原因和残差。
- 配置可保存到浏览器本地槽位、重载继续调整，也可复制/导入完整 JSON、导出每轮记录。
- 内置全部 4 个样例（two-link / unreachable / shared / locked）。

## 验证

```bash
python3 -I tools/test_solver.py      # 原型数值与边界行为
node tools/crosscheck.js             # JS 对拍样例与 known-pose
node tools/test_iterator.js          # 单步/运行等价 + 可复现
node tools/browser-smoke.js          # 浏览器端到端 (需 Playwright/Chromium)
```

已知特性：32 关节全伸展串联链在全伸展位形存在固有雅可比零空间（多个精确零奇异值），
从零位驱动远离的目标可能停滞在局部最优——规格不要求全局最优，页面会如实报告停滞与残差而非假装收敛；
从可行姿态邻域热启动（工作台的实际调整方式）可稳定收敛。
