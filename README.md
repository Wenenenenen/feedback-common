# 实例匹配对照台

本地运行的实例分割交付对照网页。导入同尺寸的 16 位大端 P5 PGM 真值图与预测图，按最多 32 个重叠阈值分别计算精确的一对一匹配，并在两图中联动点选、检查交集/并集面积和未配对象、导出 JSON。

## 打开方式

直接用现代浏览器打开 [`index.html`](./index.html) 即可。页面会自动载入 `samples/instance-agreement.zip` 的内置副本；也可以：

- 点击 **导入 ZIP** 选择 `samples/instance-agreement.zip` 或同结构压缩包；
- 分别选择 `truth.pgm` 和 `prediction.pgm`；
- 把 ZIP 或两个 PGM 拖入页面。

ZIP 解压使用浏览器内置 `DecompressionStream('deflate-raw')`。若浏览器不支持，可解压后分别导入两个 PGM。

也可以启动静态服务器：

```bash
npm run serve
# 打开 http://localhost:8123
```

自包含单文件版本在构建后生成：

```bash
npm run build
# dist/instance-agreement.html
```

## 输入约定

- 仅支持二进制 `P5`；`maxval > 255` 时按大端无符号 16 位采样读取。
- 宽、高最多 `1024`。
- `0` 是背景。
- 真值 `65535` 是忽略区；这些像素同时从真值面积、预测面积、交集和并集中剔除。
- 预测编号允许 `0..65534`；出现预测 `65535` 会报格式错误。
- 剔除忽略区后面积为零的编号不进入匹配。
- 每边参与匹配的有效实例最多 `256` 个。

## 阈值与匹配规则

阈值以万分数输入，例如 `5000` 表示 `IoU >= 0.5000`。可同时输入最多 32 个，用空格、逗号、中文逗号、分号或换行分隔；重复阈值会去重。

资格判断不使用浮点：

```text
intersection / union >= thresholdNumerator / (thresholdScale * 10000)
```

即使阈值为 `0`，交集为零的边也没有资格。

每个阈值独立求解一对一匹配，不使用贪心最高重叠或第三方匹配器。优化顺序为：

1. 配对数最大；
2. 各对 `floor(IoU * 1_000_000)` 之和最大；
3. 按真值编号递增，将其配对的预测编号组成序列，取字典序最小；未配符号排在所有数字编号之后。

实现见 [`agreement-core.js`](./agreement-core.js)。它把上述三级目标准确编码为 BigInt 边权，再用自带的矩形 Hungarian 势函数算法求最大权指派。随机小矩阵测试会与穷举所有匹配的结果逐项对照。

## 测试

```bash
npm test
```

测试覆盖：

- P5 大端 16 位解析；
- 忽略区与空实例剔除；
- “一个预测抢走两个真值位置”的全局配对数反例；
- 阈值零交集规则；
- 精确阈值边界；
- 200 组随机矩阵上的基数、百万分总分和字典序穷举一致性；
- 内置样例 ZIP 的端到端计数。

## 导出 JSON

点击 **导出各档 JSON** 可查看、复制或下载报告。主要结构为：

```json
{
  "schema": "instance-mask-agreement/v1",
  "image": { "width": 4, "height": 3, "ignoredPixels": 2 },
  "summary": [],
  "thresholds": [
    {
      "thresholdPermyriad": "5000",
      "counts": {},
      "scoreMillionTotal": 1800000,
      "pairs": [
        {
          "truthId": 1,
          "predictionId": 301,
          "intersectionArea": 2,
          "unionArea": 2,
          "iouExact": "2/2",
          "iouMillionFloor": 1000000
        }
      ],
      "unmatchedTruthIds": [],
      "unmatchedPredictionIds": []
    }
  ]
}
```

所有文件和计算都留在本地浏览器，不上传图像。
