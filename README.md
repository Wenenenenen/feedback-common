# 远征拿牌核算

一个单页工具：按当前局面精确计算“每次看两张、拿一张”远征规则下的最优成功率，补录实际揭出的牌，试选拿法，并导出/导入整局记录继续算。

## 使用

直接用浏览器打开 `index.html`，或用任意静态服务器托管。

- **补录揭牌**：当前能揭出的牌会以按钮列出，标出剩余张数和出现概率。不在剩余多重集里的牌（未知牌堆耗尽前不会出现的牌、队尾非队首的牌）不会出现，也无法写入。
- **拿牌**：两张都揭出后，每张牌显示“拿它之后的最优成功率”和是否建议。同率取揭示顺序靠前的一张。得分或集齐徽章立即成功，两张都拿不了即失败。
- **试选**：预览某个拿法带来的局面与成功率，可取消或确认，均不落记录。
- **撤销一步**：回退最近一次揭牌或拿牌。
- **导出与续算**：导出形如 `{format, version, deck, actions}` 的 JSON；导入时按牌组逐条重放 `reveal` / `take`，任何一条不合法（揭不可能的牌、拿牌时通行券变负、未揭完就取牌）都会整份拒绝，不会写入。

## 规则口径

- 未知牌堆按剩余多重集均匀逐张揭；耗尽后才从公开队尾的队首继续。
- 每拍最多揭 `min(2, 当前总剩余张数)` 张，拿恰好一张；未拿的按揭示顺序放回队尾。
- 通行券不能扣成负数；两张都拿不了即失败。
- 达到分数与徽章目标立即成功；牌堆或拍数耗尽仍未达标则失败。

所有概率都是精确分数（BigInt 有理数），按最优策略枚举计算，不使用随机模拟。大牌堆的搜索在 Web Worker 里跑；不支持 Worker 时退回主线程同步计算。

## 开发

```
node build.js                 # 由 app/、solver.js、session.js、samples/ 生成 index.html
node tests/run-tests.js       # 求解器 vs 独立暴力参考、随机对拍
node tests/session-tests.js   # 记录校验、撤销、导出/导入
node tests/worker-tests.js    # Worker 协议与本地计算一致
node tests/ui-smoke.js        # jsdom 端到端（需要 jsdom，见下）
```

`tests/ui-smoke.js` 依赖装在仓库外的 jsdom：

```
mkdir -p /tmp/jsdomenv && (cd /tmp/jsdomenv && npm install jsdom)
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `solver.js` | 精确分数、牌组校验、最优策略搜索 |
| `session.js` | 局面、动作日志、撤销、导出与重放 |
| `app/page.html` | 页面骨架与样式 |
| `app/app.js` | 页面交互与渲染 |
| `app/worker.js` | 后台求解 Worker |
| `build.js` | 内联所有源码生成 `index.html` |
| `samples/expedition-deck.json` | 示例牌组 |
