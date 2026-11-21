# 斜边 MTF 工作台

用斜边靶图检查镜头清晰度的本地网页。导入线性 16 位灰度图与尺寸 JSON，在图上管理测区，
自动完成亚像素边缘定位、法向分箱与频响计算，对照查看 ESF / LSF / MTF 曲线并导出 CSV。

## 运行

页面需要通过 HTTP 打开（内置样例用 `fetch` 加载，`file://` 下会被浏览器拦截）：

```bash
cd web
python3 -m http.server 8000
# 浏览器访问 http://127.0.0.1:8000/
```

打开后点右上角「载入内置样例」可直接用 `samples/slanted-edge-mtf-cases.zip` 中的数据试跑。

## 输入约定

- 图像：逐行、小端 16 位线性灰度（`.u16` / `.bin` / `.raw`），单边不超过 1536 像素。
- 尺寸 JSON：`{"w": 195, "h": 179, "rois": [[x, y, w, h], ...]}`；`rois` 可省略，之后在图上手绘。
- 码值 32768 为靶图背景标记，不参与显示拉伸与分箱平均。
- 测区上限 16 个，可在图上拖画、拖动移动、Delete 键或按钮删除。

## 算法口径（与样例包 `约定.txt` 一致，见 `web/mtf-core.js`）

1. 每区按平均梯度选主方向（近垂直 / 近水平），剖面中点线性插值求亚像素穿越点，
   Theil 初值 + MAD 迭代加权鲁棒直线拟合；残差异常点标为剔除（对应印刷缺口）。
2. 斜率为较小轴分量 / 较大轴分量，绝对值须在 0.03–0.5；单位法线指向亮侧。
3. 按有符号法向距离在 `[-12, 12)` 以 0.25 像素分箱（96 箱），在边缘 ±12px 带内采样并裁到图像边界。
4. 内部连续缺箱至多两个，线性补值；首尾缺箱或更长缺箱判无效。
5. 中心差分得 LSF（94 点，去两端），乘汉宁窗。
6. DFT 频率步长 0.005 周期/像素、范围 0–0.5（101 点），直流幅值归一化；
   差分补偿 `ω/sin(ω)`，`ω = 2πf×0.25`，直流取 1。
7. MTF50 / MTF10 取首次下穿的相邻样点线性插值；未下穿标「不可测」。

## 目录

- `web/index.html`、`web/app.js`、`web/mtf-core.js`：页面、UI 逻辑、纯算法模块。
- `web/sample/`：内置样例数据。
- `tools/ref_mtf.py`：同口径 Python 参考实现，可导出参考结果 JSON。
- `tools/reference_results.json`：样例的参考计算结果。
- `tools/verify-core.js`：JS 核心与 Python 参考逐数值对照。
- `tools/e2e.js`：Playwright 端到端冒烟测试。

## 验证

```bash
# Python 参考实现对照样例真值
python3 -I tools/ref_mtf.py samples/_extracted/chart.u16 \
    samples/_extracted/chart.json samples/_extracted/truth.json

# JS 核心与 Python 参考逐数值一致
node tools/verify-core.js

# 端到端（需要全局 Playwright 的 Chromium）
NODE_PATH=$(npm root -g) node tools/e2e.js
```

样例四个测区：三个有效（斜率 +0.19 / -0.23 / +0.27），一个因斜率为 0 判无效；
JS 与 Python 参考的 ESF/LSF/MTF 整条曲线一致，MTF50 与包内真值偏差不超过 0.005 周期/像素。
