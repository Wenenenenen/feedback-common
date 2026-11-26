// 端到端契约测试：模拟主线程与 worker 的消息协议（不依赖 DOM）
import { readFileSync } from 'node:fs';
import { parseFingerprints, align, buildExport, validateLocks, validateSettings } from '../web/algo.js';

let pass = 0;
let fail = 0;
const check = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

const masterArr = JSON.parse(readFileSync('data-extract/master.json'));
const deliveryArr = JSON.parse(readFileSync('data-extract/delivery.json'));
const settingsRaw = JSON.parse(readFileSync('data-extract/settings.json'));

// 模拟 worker 内部处理
function runAlign(locks) {
  const master = parseFingerprints(masterArr, '主版');
  const delivery = parseFingerprints(deliveryArr, '交付版');
  const settings = validateSettings(settingsRaw);
  const result = align(master, delivery, settings, locks || [], () => {});
  return { result, exportData: buildExport(result) };
}

// 1. 正常对齐
const { result, exportData } = runAlign([]);
check(result.totalFee === 18 && result.gapSegments === 2, '样本费用 18、段数 2');
check(exportData.steps.length === result.steps.length, '导出步数与内部一致');
check(exportData.gapIntervals.length === 2, '导出两个缺多区间');
check(exportData.steps.every((s) =>
  (s.type === 'match' && s.masterFrame != null && s.deliveryFrame != null) ||
  (s.type === 'missing' && s.masterFrame != null && s.deliveryFrame === null) ||
  (s.type === 'extra' && s.masterFrame === null && s.deliveryFrame != null)),
'导出步类型与空侧约定正确');
check(exportData.steps.reduce((sum, s) => sum + s.cost, 0) === exportData.totalFee,
  '导出逐步费用之和等于总费用');

// 2. 半开区间边界正确性
const extra = exportData.gapIntervals.find((i) => i.type === 'extra');
const missing = exportData.gapIntervals.find((i) => i.type === 'missing');
check(extra.start === 8 && extra.end === 9 && extra.otherConsumed === 8, 'extra 半开边界与对侧已消费');
check(missing.start === 21 && missing.end === 22 && missing.otherConsumed === 22, 'missing 半开边界与对侧已消费');

// 3. 加锁后重对齐（取一个真实配对）
const aMatch = result.steps.find((s) => s.t === 'm');
const locked = runAlign([{ i: aMatch.ai, j: aMatch.bi }]);
check(locked.result.locks.length === 1, '锁点被保留');
check(locked.result.steps.some((s) => s.t === 'm' && s.ai === aMatch.ai && s.bi === aMatch.bi),
  '锁定配对必须经过');

// 4. 撤锁（重复同一对）
const master = parseFingerprints(masterArr, '主版');
const delivery = parseFingerprints(deliveryArr, '交付版');
const settings = validateSettings(settingsRaw);
// 模拟 UI 撤锁：传入不含该锁的空列表
const unlocked = align(master, delivery, settings, [], () => {});
check(unlocked.locks.length === 0, '撤锁后无锁点');

// 5. 非法锁点 -> LOCK_INVALID，且不产生新结果（worker 保留旧结果）
let err = null;
try {
  validateLocks([{ i: 0, j: 999 }], master, delivery, settings);
} catch (e) { err = e; }
check(err && err.code === 'LOCK_INVALID' && err.at, '非法锁点带 code 与定位');

// 6. 结构性无路 -> INFEASIBLE 带 segment
err = null;
try {
  const big = parseFingerprints(Array(130).fill('0000000000000000'), 'A');
  const small = parseFingerprints(Array(60).fill('0000000000000000'), 'B');
  align(big, small, settings, [], () => {});
} catch (e) { err = e; }
check(err && err.code === 'INFEASIBLE' && err.segment && typeof err.segment.index === 'number',
  '无路错误带 segment 阻断区间');

// 7. 进度回调被调用
let ticks = 0;
align(master, delivery, settings, [], () => { ticks++; });
check(ticks > 0, '进度回调触发');

console.log(`\n${fail === 0 ? '端到端契约全部通过' : '存在失败'}：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
