# 镀膜层序光谱台

多层平行膜相干干涉预览工具：编辑膜层厚度、复折射率 n+ik 和层序，实时计算
400–700 nm（10 nm 步进）× 0–85° 入射角下 s/p 偏振的反射率、透射率、吸收率，
并用样例给定的 RGB 权重渲染白光正交球面。

## 打开方式

直接用浏览器打开 `index.html` 即可，无构建步骤、无外部依赖（样例数据已内嵌在
`js/samples.js`，离线可用）。

## 物理方法

散射矩阵（S-matrix / Redheffer 星乘）逐层组合界面与传播矩阵，而非常规特征矩阵：

- 传播因子 `exp(iδ)` 在被动介质中只衰减不放大，5000 nm × 16 层强吸收膜不溢出；
- 全反射时层内 q 为纯虚数（倏逝波），无除零；受抑全反射的隧穿透射自然给出；
- 厚度为 0 的膜层等价于无该层；
- 能量守恒：A = 1 − R − T，基底与入射介质均为无吸收介质。

约定：时间因子 `exp(−iωt)`，前向波 `exp(ikz·z)`，复折射率 n+ik（k≥0），
平方根取 Re(q)≥0 的被动支。

## 目录结构

```
index.html          页面入口
css/app.css         主题令牌与布局（明/暗双主题，响应式）
js/tmm.js           散射矩阵光学引擎（浏览器 + Node 通用）
js/samples.js       内嵌样例（与 samples/film-stack-cases.json 一致）
js/color.js         光谱加权 RGB 与 sRGB gamma
js/chart.js         内联 SVG 折线图（十字线 + 悬浮提示）
js/sphere.js        正交球面 Canvas 渲染与点击/拖动定位
js/app.js           状态、重算调度与 UI 联动
tools/tmm_ref.py    Python 参考实现与解析解测试
tools/dump_ref.py   参考端全网格导出
tools/crosscheck.js JS/Python 双端数值交叉比对
tools/smoke.js      Playwright 浏览器端冒烟测试
```

## 验证

```bash
# 1. Python 参考实现的解析解测试（裸玻璃、布儒斯特、全反射、增透、厚吸收膜等）
python3 -I tools/tmm_ref.py

# 2. 生成参考网格并与 JS 引擎交叉比对（容差 1e-10）
python3 -I tools/dump_ref.py samples/film-stack-cases.json tools/ref_outputs.json
node tools/crosscheck.js samples/film-stack-cases.json tools/ref_outputs.json

# 3. 浏览器端冒烟测试（需要全局安装 playwright 与 chromium）
NODE_PATH=$(npm root -g) node tools/smoke.js
```

## 导出

- **光谱 JSON**：含完整膜层参数、波长/角度网格、RGB 权重和 s/p 的 R/T/A 全网格；
- **预览 PNG**：1200×900，含球面、膜层参数表和当前角度的无偏振能量谱。

## 参数范围

厚度 d：0–5000 nm；折射率 n：1–3.5；消光系数 k：0–2；最多 16 层。
