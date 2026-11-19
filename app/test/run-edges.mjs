// 边界规则测试：指令拒绝、退款档位、重排限制、上限截断、快照恢复。
// 语义：scheduleLive 登记到当前 tick，下一次 step() 的指令阶段执行。
import { Engine } from '../src/engine.js';
import { Fraction } from '../src/fraction.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(cond ? `  ✓ ${name}` : `  ✗ ${name} ${detail}`);
  if (!cond) failures++;
}

const base = () => JSON.parse(JSON.stringify({
  resources: { ore: 100 },
  resourceCaps: { ore: 100 },
  usedPopulation: 0,
  populationCap: 5,
  speedMultiplier: [1, 1],
  buildings: [{ id: 'b', speed: [1, 1], paused: false, queue: ['u'] }],
  catalog: {
    u: { work: 2, cost: { ore: 10 }, kind: 'unit', population: 1 },
    cheap: { work: 1, cost: { ore: 3 }, kind: 'unit', population: 1 },
    r: { work: 1, cost: {}, kind: 'research', multiplier: [3, 2] },
  },
  commands: [],
}));

// enqueue 即时扣款（当前 tick 登记，下一步执行）
{
  console.log('enqueue: 资源足够则扣款入队，不足则拒绝且队列不变');
  const eng = new Engine(base());
  eng.scheduleLive({ op: 'enqueue', building: 'b', item: 'cheap' });
  eng.step(); // tick0：指令阶段扣款 3，随后建筑推进
  check('ore 97 = 100-3', eng.resources.get('ore') === 97n, String(eng.resources.get('ore')));
  check('队列长度 2', eng.buildings.get('b').queue.length === 2);

  const eng2 = new Engine(base());
  eng2.resources.set('ore', 1n);
  eng2.scheduleLive({ op: 'enqueue', building: 'b', item: 'cheap' });
  eng2.step();
  const rej = eng2.events.find(e => e.kind === 'command' && e.op === 'enqueue');
  check('资源不足被拒绝', rej.accepted === false);
  check('队列仍为 1', eng2.buildings.get('b').queue.length === 1);
  check('ore 未变', eng2.resources.get('ore') === 1n);
}

// 取消未开工：全退；ready：不退
{
  console.log('cancel: 未开工全退 10；ready 不退');
  const eng = new Engine(base());
  eng.scheduleLive({ op: 'enqueue', building: 'b', item: 'u' }); // 实例2，未开工
  eng.step(); // tick0：扣款10；实例1 推进 1/2
  check('tick0 后 ore 90', eng.resources.get('ore') === 90n);
  eng.scheduleLive({ op: 'cancel', instance: 2 });
  eng.step(); // tick1：实例2 未开工，全退 10
  check('全退后 ore 100', eng.resources.get('ore') === 100n, String(eng.resources.get('ore')));

  // 让实例1 变 ready 后取消，不退
  const eng3 = new Engine(base());
  eng3.populationCap = 0n; // 永远交付不了
  eng3.step(); // tick0: work 1/2
  eng3.step(); // tick1: 完成但 ready
  const b = eng3.buildings.get('b');
  check('实例 ready', b.queue[0].ready === true);
  eng3.scheduleLive({ op: 'cancel', instance: 1 });
  const oreBefore = eng3.resources.get('ore');
  eng3.step();
  check('ready 取消不退款', eng3.resources.get('ore') === oreBefore);
  check('ready 实例被移除', b.queue.length === 0);
}

// 退款按仓库上限截断
{
  console.log('cancel: 退款超仓上限时截断并标记 clamped');
  const raw = base();
  raw.resourceCaps.ore = 105;
  raw.catalog.u.work = 10; // 放慢，保证取消时项目仍在队列中
  const eng = new Engine(raw);
  eng.scheduleLive({ op: 'enqueue', building: 'b', item: 'u' });
  eng.step(); // ore 90
  eng.scheduleLive({ op: 'cancel', instance: 2 });
  eng.step(); // 未开工全退 10 -> 100
  check('ore 100', eng.resources.get('ore') === 100n);
  // 清晰时间线：实例1 连续两步各做 1，进度达到数值 2（work=10）
  const raw2 = base();
  raw2.resourceCaps.ore = 105;
  raw2.catalog.u.work = 10;
  const eng2 = new Engine(raw2);
  eng2.step(); // tick0：进度 1
  eng2.step(); // tick1：进度 2
  check('实例1 进度 = 2（work=10，已做两个单位）',
    eng2.buildings.get('b').queue[0].instanceId === 1 &&
    eng2.buildings.get('b').queue[0].progress.eq(Fraction.from(2)),
    eng2.buildings.get('b').queue[0].progress.toString());
  // 仓满时取消：应退 floor(10*(10-2)/10)=8，实际只能进 0
  eng2.resources.set('ore', 105n);
  eng2.scheduleLive({ op: 'cancel', instance: 1 });
  const cancelSeq = String(eng2.commandsByTick.get(eng2.tick)[0].seq);
  eng2.step();
  check('仓满截断 ore=105', eng2.resources.get('ore') === 105n);
  const clampEvt = eng2.events.find(e => e.kind === 'resource' && e.clamped &&
    e.source.op === 'cancel' && e.source.seq === cancelSeq);
  check('退款事件记录 clamped 且 intendedDelta=8、实入 delta=0',
    !!clampEvt && clampEvt.intendedDelta === '8' && clampEvt.delta === '0',
    JSON.stringify(clampEvt));
}

// reorder 限制
{
  console.log('reorder: 只允许未取得工作量的非 ready 实例，且必须是完整新顺序');
  const raw = base();
  raw.catalog.u.work = 10; // 放慢，保证重排期间队首不会完成
  raw.buildings[0].queue = ['u', 'u', 'u'];
  const eng = new Engine(raw);
  eng.step(); // 实例1 取得工作量（未完成），2/3 仍等待
  eng.scheduleLive({ op: 'reorder', building: 'b', order: [3, 2] });
  eng.step();
  const b = eng.buildings.get('b');
  check('重排后顺序 1,3,2', b.queue.map(x => x.instanceId).join(',') === '1,3,2',
    b.queue.map(x => x.instanceId).join(','));
  eng.scheduleLive({ op: 'reorder', building: 'b', order: [1, 2, 3] });
  eng.step();
  check('含已开工实例被拒', eng.events.filter(e => e.op === 'reorder').at(-1).accepted === false);
  eng.scheduleLive({ op: 'reorder', building: 'b', order: [2] });
  eng.step();
  check('不完整顺序被拒', eng.events.filter(e => e.op === 'reorder').at(-1).accepted === false);
}

// pause / destroy
{
  console.log('pause/destroy: 暂停不推进；摧毁不退且清队列');
  const eng = new Engine(base());
  eng.scheduleLive({ op: 'pause', building: 'b', paused: true });
  eng.step();
  const b = eng.buildings.get('b');
  check('暂停后无 work 事件', !eng.events.some(e => e.tick === 0 && e.kind === 'work'));
  check('进度仍为 0', b.queue[0].progress.isZero());
  const oreBefore = eng.resources.get('ore');
  eng.scheduleLive({ op: 'destroy', building: 'b' });
  eng.step();
  check('摧毁清空队列', b.queue.length === 0 && b.destroyed === true);
  check('摧毁不退款', eng.resources.get('ore') === oreBefore);
}

// release 限制 & grant
{
  console.log('grant/release: grant 受上限截断；release 超已用被拒');
  const eng = new Engine(base());
  eng.step(); // tick0 交付不了（work2 只做 1），人口仍 0
  eng.step(); // tick1 交付，人口 1
  check('人口 1', eng.usedPopulation === 1n);
  eng.scheduleLive({ op: 'release', amount: 5 });
  eng.step();
  check('超额 release 被拒', eng.usedPopulation === 1n);
  eng.scheduleLive({ op: 'release', amount: 1 });
  eng.step();
  check('合法 release 后人口 0', eng.usedPopulation === 0n);
  eng.scheduleLive({ op: 'grant', resource: 'ore', amount: 50 });
  eng.step();
  check('grant 截断到仓上限 100', eng.resources.get('ore') === 100n);
}

// 队列满 8 拒绝
{
  console.log('queue cap: 队列 8 满后 enqueue 被拒');
  const raw = base();
  raw.buildings[0].queue = Array(8).fill('u');
  const eng = new Engine(raw);
  eng.scheduleLive({ op: 'enqueue', building: 'b', item: 'u' });
  eng.step();
  check('满队 enqueue 被拒',
    eng.events.some(e => e.op === 'enqueue' && e.accepted === false));
}

// 快照恢复无损
{
  console.log('snapshot: 保存/恢复后继续推进与不中断结果一致');
  const a = new Engine(base());
  a.step(); a.step();
  const snap = a.snapshot();
  const b = Engine.restore(snap);
  let guard = 0;
  while (guard++ < 100) {
    const qa = a.buildingOrder.some(id => a.buildings.get(id).queue.length);
    const qb = b.buildingOrder.some(id => b.buildings.get(id).queue.length);
    if (!qa && !qb) break;
    a.step(); b.step();
  }
  check('恢复后事件流一致', JSON.stringify(a.events) === JSON.stringify(b.events));
  check('恢复后分数状态一致', b.snapshot() === a.snapshot());
}

// 科技倍率连乘、下一步生效
{
  console.log('research: 多科技连乘且均从下一 tick 生效');
  const raw = base();
  raw.buildings = [{ id: 'lab', speed: [1, 1], paused: false, queue: ['r', 'r'] }];
  const eng = new Engine(raw);
  eng.step(); // tick0: 第一个 r 完成，pending 3/2
  check('tick0 当步倍率仍 1/1', eng.speedMultiplier.eq(Fraction.ONE));
  eng.step(); // tick1: 乘入 3/2；预算 3/2，第二个 r(work1) 完成，pending 另一个 3/2
  check('tick1 倍率 3/2', eng.speedMultiplier.eq(new Fraction(3n, 2n)));
  eng.step(); // tick2: 乘入 -> 9/4
  check('tick2 倍率 9/4', eng.speedMultiplier.eq(new Fraction(9n, 4n)),
    eng.speedMultiplier.toString());
}

// 实时指令与同 tick 预置指令共用 seq 空间不冲突、顺序确定
{
  console.log('seq: 实时指令自动避开预置 seq，按 seq 升序执行');
  const raw = base();
  raw.commands = [{ tick: 0, seq: 1, op: 'grant', resource: 'ore', amount: 0 }];
  const eng = new Engine(raw);
  const entry = eng.scheduleLive({ op: 'grant', resource: 'ore', amount: 5 });
  check('实时指令拿到 seq 2', entry.seq === 2, String(entry.seq));
  eng.step();
  const seqOrder = eng.events
    .filter(e => e.kind === 'command' && e.op === 'grant')
    .map(e => e.source.seq);
  check('按 seq 升序执行', seqOrder.join(',') === '1,2', seqOrder.join(','));
}

console.log(failures === 0 ? '\n边界测试全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures ? 1 : 0);
