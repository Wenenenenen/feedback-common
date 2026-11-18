# Poisson 局部无缝合成

把源图选区无缝合成到底图的纯前端工具：在线性 RGB 中求解 Poisson 方程，消除直接粘贴的亮度接缝。核心梯度构造与方程求解均为自行实现（`js/solver.js`），无第三方依赖。

## 运行

```bash
python3 -m http.server 8123
# 打开 http://localhost:8123/
```

（Worker 与样例 fetch 不支持 file:// 直开。）

## 功能

- **导入**：8 位 RGB PNG 源图、底图（各 ≤512×512），以及与源图同尺寸的灰度掩膜（非零=选中）。掩膜可含多个区域与孔洞。也可从下拉框直接加载 `samples/cases/` 中的样例。
- **平移**：整数像素 dx/dy（目标坐标 = 源坐标 + (dx,dy)），可输入或在「直接粘贴」视图上拖动。移出画布的选区不参与合成。
- **画笔**：在「选区编辑」视图上涂抹增删选区（右键拖动=擦除），支持全选/清空/反选。
- **引导梯度**：源梯度 / 混合梯度（逐边取两种 RGB 向量平方模较大者，平局取源）切换。
- **求解**：按 `samples/cases/约定.json` 在线性 RGB 中构造方程，预条件共轭梯度（Jacobi）逐通道求解，在 Web Worker 中运行；修改参数自动取消旧计算，也可手动取消。选区贴画布边缘时度数只计画布内邻居；整幅选中时以左上角固定为底图值作锚点。
- **视图联动**：选区编辑 / 直接粘贴 / 求解结果 / 差值（增益可调）四视图统一缩放，悬停显示像素探针（含未限幅线性值）。显示限幅仅发生在编码 sRGB 时，不改变求解结果。
- **导出**：结果 PNG（限幅编码）与报告 JSON（残差、迭代次数、裁剪范围、未限幅数值范围、参数等）。

## 测试

```bash
node test/test-solver.js
```

以包内样例验证约定：overshoot 中心未限幅值 = `1 + srgb_to_linear(64/255)`、常量零梯度、恒等、整幅选中锚点、平移裁剪、混合梯度取模、画布边缘度数。

## 文件

- `index.html` / `css/style.css` — 页面
- `js/app.js` — 交互、视图、求解调度
- `js/solver.js` — 求解核心（Worker 与 Node 测试共用）
- `js/solver-worker.js` — Worker 包装
- `test/test-solver.js` — 约定测试
- `samples/cases/` — 样例（解包自 `samples/poisson-mask-compositor-cases.zip`）
