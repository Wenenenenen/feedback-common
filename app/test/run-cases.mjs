// Node 验证：对样例包 5 个用例的 expected 字段逐一断言。
// 运行：node app/test/run-cases.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';

const CASES_DIR = process.argv[2] ?? 'work/cases-extract';
let failures = 0;

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

function loadCase(file) {
  const raw = JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8'));
  return { raw, eng: new Engine(raw) };
}

function runAll(eng) {
  // 跑到足够远：所有队列清空且无未来指令
  let guard = 0;
  const maxScheduled = [...eng.commandsByTick.keys()].reduce((a, b) => Math.max(a, b), 0);
  while (guard++ < 100000) {
    const anyQueued = eng.buildingOrder.some(id => eng.buildings.get(id).queue.length > 0);
    if (!anyQueued && eng.tick > maxScheduled && eng.pendingMultipliers.length === 0) break;
    eng.step();
  }
}

// ---- fraction ----
{
  console.log('fraction.json: 速度 2/3，work 1 的两个 unit 应在 tick1、tick2 完成');
  const { eng } = loadCase('fraction.json');
  runAll(eng);
  const completions = eng.events.filter(e => e.kind === 'complete' && e.itemKind === 'unit');
  check('两个完成事件', completions.length === 2, `got ${completions.length}`);
  check('完成 tick = 1, 2', completions.map(e => e.tick).join(',') === '1,2',
    completions.map(e => e.tick).join(','));
  check('usedPopulationAfterTick2 = 2', eng.usedPopulation === 2n, String(eng.usedPopulation));
}

// ---- research ----
{
  console.log('research.json: 科技 tick0 完成、tick1 生效，z 的 slow 在 tick1 完成');
  const { eng } = loadCase('research.json');
  // tick0 后检查 z 进度
  eng.step();
  const z = eng.buildings.get('z');
  check('zProgressAfterTick0 = 1/1（被 2/1 科技前的预算推进 1）',
    z.queue[0].progress.toJSON().join(',') === '1,1',
    z.queue[0].progress.toString());
  runAll(eng);
  const slowComplete = eng.events.find(e => e.kind === 'complete' && e.item === 'slow');
  check('zCompletionTick = 1', slowComplete?.tick === 1, String(slowComplete?.tick));
  const speedEvent = eng.events.find(e => e.kind === 'speedMultiplier');
  check('科技倍率在 tick1 才乘入', speedEvent?.tick === 1, String(speedEvent?.tick));
  check('全局倍率 = 2/1', eng.speedMultiplier.toJSON().join(',') === '2,1');
}

// ---- blocked ----
{
  console.log('blocked.json: 人口满 -> ready 卡住队首，release 后下一 tick 交付');
  const { eng } = loadCase('blocked.json');
  eng.step(); // tick0
  const b = eng.buildings.get('b');
  check('readyAt0 = true', b.queue[0].ready === true);
  check('队首仍在（未交付）', b.queue.length === 2);
  eng.step(); // tick1
  check('queueLengthAt1 = 2（卡住）', b.queue.length === 2);
  check('tick1 有 blocked 事件', eng.events.some(e => e.tick === 1 && e.kind === 'blocked'));
  eng.step(); // tick2：release 1，然后交付队首，第二个变 ready
  check('usedPopulationAfterTick2 = 1', eng.usedPopulation === 1n, String(eng.usedPopulation));
  check('secondReadyAt2 = true', b.queue[0]?.ready === true);
  check('队列剩 1（首个已交付）', b.queue.length === 1);
}

// ---- refund ----
{
  console.log('refund.json: tick1 取消已做 1/3 的项目，退 floor(10*2/3)=6');
  const { eng } = loadCase('refund.json');
  eng.step(); // tick0：progress 0->1
  eng.step(); // tick1：指令阶段 cancel
  check('oreAfterTick1 = 6', eng.resources.get('ore') === 6n, String(eng.resources.get('ore')));
  check('队列已清空', eng.buildings.get('b').queue.length === 0);
  const refundEvt = eng.events.find(e => e.op === 'cancel' && e.accepted);
  check('退款记录 6', refundEvt?.refunds?.[0]?.refund === '6');
}

// ---- stress ----
{
  console.log('stress.json: 32 建筑 × 8 队列，2/3 速度全部精确完成，账本与人口对账');
  const { raw, eng } = loadCase('stress.json');
  const totalUnits = 32 * 8;
  const oreStart = BigInt(raw.resources.ore);
  runAll(eng);
  const delivered = eng.events.filter(e => e.kind === 'complete' && e.itemKind === 'unit').length;
  check(`256 个 unit 全部交付（got ${delivered}）`, delivered === totalUnits);
  check('人口 = 256', eng.usedPopulation === 256n, String(eng.usedPopulation));
  // 初始队列视为已付款：初始资源已是付款后的值，模拟期间无新 enqueue 故 ore 不变
  check('ore 精确 = 10000（初始队列已付款，期间无资源事件）',
    eng.resources.get('ore') === oreStart, String(eng.resources.get('ore')));
  check('所有队列为空', eng.buildingOrder.every(id => eng.buildings.get(id).queue.length === 0));

  // 账本对账：所有 resource 事件 before/after/delta 必须自洽
  let ledgerBad = 0;
  for (const e of eng.events.filter(e => e.kind === 'resource')) {
    if (BigInt(e.after) - BigInt(e.before) !== BigInt(e.delta)) ledgerBad++;
  }
  check('资源账本 before+delta=after 全部自洽', ledgerBad === 0);
  // 人口账本同理
  let popBad = 0;
  for (const e of eng.events.filter(e => e.kind === 'population')) {
    if (BigInt(e.after) - BigInt(e.before) !== BigInt(e.delta)) popBad++;
  }
  check('人口账本 before+delta=after 全部自洽', popBad === 0);
  // 账本校验：每个 work 事件的 delta 总和 = 总工作量（256），用分数累加
  const { Fraction } = await import('../src/fraction.js');
  let sum = Fraction.ZERO;
  for (const e of eng.events.filter(e => e.kind === 'work')) {
    sum = sum.add(Fraction.from(e.delta));
  }
  check('work 增量分数之和 = 256（无浮点误差）', sum.eq(new Fraction(256n)), sum.toString());
  // 每次 work 之后 progress 不超过 work
  let bad = 0;
  for (const e of eng.events.filter(e => e.kind === 'work')) {
    if (Fraction.from(e.progressAfter).gt(Fraction.from(BigInt(e.work)))) bad++;
  }
  check('没有超调进度', bad === 0);
}

// ---- 额外确定性：建筑遍历顺序无关（打乱 buildings 输入顺序结果相同）----
{
  console.log('determinism: 打乱建筑输入顺序，事件流一致');
  const raw = JSON.parse(readFileSync(join(CASES_DIR, 'research.json'), 'utf8'));
  const a = new Engine(JSON.parse(JSON.stringify(raw)));
  runAll(a);
  const reversed = JSON.parse(JSON.stringify(raw));
  reversed.buildings.reverse();
  const b = new Engine(reversed);
  runAll(b);
  check('事件流完全一致', JSON.stringify(a.events) === JSON.stringify(b.events));
}

// ---- 额外：中途完成剩余预算传递 ----
{
  console.log('carryover: 一步内完成两项时剩余工作量交给后续项目');
  const raw = JSON.parse(readFileSync(join(CASES_DIR, 'fraction.json'), 'utf8'));
  raw.buildings[0].speed = [3, 1]; // 预算 3，每项 work 1
  const eng = new Engine(raw);
  eng.step(); // tick0：完成两个 unit，还剩 1 预算但队列空
  check('一步交付 2 个', eng.usedPopulation === 2n);
  const ws = eng.events.filter(e => e.tick === 0 && e.kind === 'work');
  check('两项各得 1 工作量', ws.length === 2 && ws.every(e => e.delta.join(',') === '1,1'));
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
