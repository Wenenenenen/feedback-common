# 输入动作仲裁调试器(Input Action Arbiter)

游戏输入动作映射的网页调试器。解决两类典型问题:

- **单键与组合键共用按键同时触发**:单键绑定先进入候选等待窗,组合键在窗内集齐后按优先级裁决,胜者占用按键,共享按键的其他候选取消或淘汰。
- **弹出菜单 / 窗口失焦后残留按住状态**:失焦(blur)按键名字典序合成 up,清空候选与占用,物理键状态一并释放。

直接用浏览器打开 `index.html` 即可,无构建步骤、无外部依赖。

## 功能

- 自研仲裁引擎 `arbiter.js`(不依赖现成输入动作库):候选等待、长按计时、按键占用、`started` / `performed` / `canceled` 三阶段。
- 真实键盘捕获(忽略操作系统自动重复)与毫秒日志回放;回放支持播放 / 暂停 / 单步 / 0.25x–8x 变速,日志只取决于逻辑时间戳,与速度无关。
- 事件流逐事件展示:物理按键集合、各候选截止时间、获胜绑定、淘汰原因。
- 页面内切换上下文(注入 `context` 事件)、编辑绑定(应用配置等价于游戏内换绑定)。
- 导出:配置 JSON、动作日志 JSON、输入日志 JSON(实时键盘可录制后回放)。
- 容量:64 个绑定、10000 条事件,超限拒绝并提示。

## 协议

见 `samples/extracted/说明.md`。要点:

- 事件按 `(t, seq)` 处理;同一 t 的全部输入处理完后,再处理到期定时器;正好截止的输入有效。
- 忽略重复 down 与未按下键的 up。
- 组合须在 `first_down + window_ms` 内集齐;最早 performed 时刻 = `max(first_down + window_ms, complete_time + hold_ms)`。
- 裁决顺序:context.priority 降序 → keys 数量降序 → binding.priority 降序 → id 升序。
- 每轮无论失败或完成,均等该绑定全键释放后重新武装。

## 文件

| 文件 | 说明 |
| --- | --- |
| `arbiter.js` | 纯逻辑时钟仲裁引擎(浏览器 / Node 通用) |
| `app.js` | 页面交互逻辑 |
| `index.html` | 调试器页面 |
| `test/run-tests.js` | 引擎测试(`node test/run-tests.js`),含样例包全部用例 |
| `samples/extracted/` | 样例包解压内容(CC0-1.0) |

## 测试

```sh
node test/run-tests.js
```

覆盖:combo 样例的全部预期值(`combo-expected.json`)、长按边界(同刻 up 与就绪定时器,输入优先)、上下文切换 + 失焦、同刻 down/up 约定、重新武装、确定性(runAll 与逐步 step 日志一致)、容量上限。
