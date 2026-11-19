// Node 测试（不在 samples 目录内运行，路径以参数形式传入；仅读取不可信样例数据）
// 运行: node tests/run-tests.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { simulate, validateConfig, LIMITS } from '../src/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'samples', 'extracted');
const read = (f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8'));

let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
};
const section = (name) => console.log('\n=== ' + name + ' ===');

// ---------- 三个黄金用例 ----------
const cases = read('cases.json');
for (const c of cases) {
  section('用例: ' + c.name);
  const r = simulate(c);
  check(r.ok, '模拟应成功: ' + r.errors.join('; '));

  // hpAt：取不晚于指定时刻的最后一帧血量
  const hpAt = (t) => {
    let hp = c.actors[0].hp;
    for (const f of r.frames) {
      if (f.time <= t) hp = f.hpAfter[c.actors[0].id];
    }
    return hp;
  };
  for (const [t, want] of Object.entries(c.expected.hpAt || {})) {
    check(hpAt(Number(t)) === want, `hpAt(${t}) 期望 ${want}, 实际 ${hpAt(Number(t))}`);
  }

  if (c.expected.damageTimes) {
    const got = r.logs.filter((l) => l.type === 'damage' && l.target === 'a').map((l) => l.time);
    check(JSON.stringify(got) === JSON.stringify(c.expected.damageTimes),
      `damageTimes 期望 ${JSON.stringify(c.expected.damageTimes)}, 实际 ${JSON.stringify(got)}`);
  }

  if ('removedAt2' in c.expected) {
    const n = r.logs.filter((l) => l.type === 'cleanup' && l.time === 2).length;
    check(n === c.expected.removedAt2, `t=2 清理数期望 ${c.expected.removedAt2}, 实际 ${n}`);
  }

  if (c.expected.absorptionAt21) {
    const dmg = r.logs.find((l) => l.type === 'damage' && l.time === 21);
    check(!!dmg, 't=21 应有 damage 日志');
    if (dmg) {
      const got = dmg.absorption.map((a) => ({ instance: a.instance, amount: a.amount }));
      check(JSON.stringify(got) === JSON.stringify(c.expected.absorptionAt21),
        `absorption 期望 ${JSON.stringify(c.expected.absorptionAt21)}, 实际 ${JSON.stringify(got)}`);
      check(dmg.hpAfter === 100, 't=21 伤害应全被吸收，hp=100');
    }
  }

  if ('activeAt10' in c.expected) {
    // t=10 之后仍存活的实例数（对目标 a）
    const aliveAt = (t) => {
      const born = r.logs.filter((l) => l.type === 'apply' && l.time <= t);
      const gone = new Set(r.logs.filter((l) => l.type === 'cleanup' && l.time <= t).map((l) => l.instance));
      return born.filter((l) => !gone.has(l.instance)).length;
    };
    check(aliveAt(10) === c.expected.activeAt10.length, `t=10 活动效果应为空, 实际 ${aliveAt(10)}`);
    const heal = r.logs.find((l) => (l.type === 'heal' || l.type === 'ignored') && l.time === 10);
    check(!!heal && (heal.type === 'ignored' || heal.actual === 0), '对尸体的治疗应记忽略或 actual=0');
  }
}

// ---------- 非法定义必须被拒绝 ----------
section('invalid.json 校验');
const invalid = read('invalid.json');
const errs = validateConfig(invalid);
check(errs.some((e) => e.includes('period')), 'period=0 必须报错; 实际: ' + JSON.stringify(errs));
check(!simulate(invalid).ok, 'simulate 对非法配置应返回 ok=false');

// ---------- 压力测试 ----------
section('stress.json 性能与上限');
const stress = read('stress.json');
const t0 = performance.now();
const sr = simulate(stress);
const ms = performance.now() - t0;
check(sr.ok, '压力模拟应成功: ' + sr.errors.join('; '));
check(sr.actors.length === 64, '64 个角色');
const maxActive = (() => {
  let cur = 0; let max = 0;
  for (const l of sr.logs) {
    if (l.type === 'apply') { cur++; max = Math.max(max, cur); }
    if (l.type === 'cleanup') cur--;
  }
  return max;
})();
check(maxActive <= LIMITS.MAX_ACTIVE_EFFECTS, `活动效果峰值 ${maxActive} 不超过 256`);
check(sr.logs.every((l, i) => l.idx === i), '日志 idx 单调连续');
// 时间单调性
let prev = -1;
let mono = true;
for (const f of sr.frames) { if (f.time < prev) mono = false; prev = f.time; }
check(mono, '帧时间单调不减');
console.log(`  frames=${sr.frames.length}, logs=${sr.logs.length}, 耗时=${ms.toFixed(1)}ms`);

// ---------- 复现性：重放两次结果一致 ----------
section('确定性复现');
const r1 = simulate(stress);
const r2 = simulate(stress);
check(JSON.stringify(r1.logs) === JSON.stringify(r2.logs), '相同输入两次模拟日志完全一致');
check(JSON.stringify(r1.frames) === JSON.stringify(r2.frames), '相同输入两次模拟帧完全一致');

// ---------- 补充边界用例 ----------
section('补充边界语义');
{
  // 净化撤销未来到期/跳伤任务
  const cfg = {
    actors: [{ id: 'a', maxHp: 100, hp: 100 }],
    definitions: [
      { id: 'p', kind: 'dot', stack: 'independent', cap: 3, duration: 30, period: 10, amount: 4 },
      { id: 'w', kind: 'shield', stack: 'independent', cap: 3, duration: 15, amount: 3 },
    ],
    events: [
      { id: 'e1', seq: 1, time: 0, op: 'apply', target: 'a', effect: 'p' },
      { id: 'e2', seq: 2, time: 5, op: 'cleanse', target: 'a', effect: 'p' },
      { id: 'e3', seq: 3, time: 10, op: 'damage', target: 'a', amount: 5 },
      { id: 'e4', seq: 4, time: 20, op: 'heal', target: 'a', amount: 999 },
    ],
  };
  const r = simulate(cfg);
  check(r.ok, '边界配置有效: ' + r.errors.join(';'));
  const ticks = r.logs.filter((l) => l.root && l.root.kind === 'tick');
  check(ticks.length === 0, '净化后不应再有任何跳伤');
  const dmg = r.logs.find((l) => l.type === 'damage');
  check(dmg.absorption.length === 0 && dmg.hpAfter === 95, '无护盾时直接扣 5 血 -> 95');
  const heal = r.logs.find((l) => l.type === 'heal');
  check(heal.actual === 5 && heal.hpAfter === 100, '治疗封顶到 maxHp, actual=5');
}

{
  // independent 满层替换：到期最早者被删，并列删编号最小
  const cfg = {
    actors: [{ id: 'a', maxHp: 1000, hp: 1000 }],
    definitions: [{ id: 'w', kind: 'shield', stack: 'independent', cap: 2, duration: 10, amount: 1 }],
    events: [
      { id: 'e1', seq: 1, time: 0, op: 'apply', target: 'a', effect: 'w' }, // 实例1 exp10
      { id: 'e2', seq: 2, time: 2, op: 'apply', target: 'a', effect: 'w' }, // 实例2 exp12
      { id: 'e3', seq: 3, time: 4, op: 'apply', target: 'a', effect: 'w' }, // 满层 -> 删实例1
    ],
  };
  const r = simulate(cfg);
  const rep = r.logs.find((l) => l.type === 'cleanup' && l.reason === 'replaced');
  check(rep && rep.instance === 1, '应替换编号最小/最早到期的实例 1');
  const applies = r.logs.filter((l) => l.type === 'apply').map((l) => l.instance);
  check(JSON.stringify(applies) === JSON.stringify([1, 2, 3]), '三次 apply 实例编号 1,2,3');
}

{
  // 同刻：外部 damage 先于到期处理，护盾仍可吸收；随后到期删除
  const cfg = {
    actors: [{ id: 'a', maxHp: 100, hp: 100 }],
    definitions: [{ id: 'w', kind: 'shield', stack: 'refresh', cap: 1, duration: 10, amount: 7 }],
    events: [
      { id: 'e1', seq: 1, time: 0, op: 'apply', target: 'a', effect: 'w' },
      { id: 'e2', seq: 2, time: 10, op: 'damage', target: 'a', amount: 9 },
    ],
  };
  const r = simulate(cfg);
  const dmg = r.logs.find((l) => l.type === 'damage');
  check(dmg.absorbed === 7 && dmg.hpLoss === 2 && dmg.hpAfter === 98, '同刻到期护盾先吸收 7，再扣 2 血');
  const order = r.logs.filter((l) => l.time === 10).map((l) => l.type);
  check(order.indexOf('damage') < order.lastIndexOf('cleanup'), 'damage 日志早于到期清理');
}

{
  // 跳伤与到期同刻：tickTime < expires 才跳，相等不跳
  const cfg = {
    actors: [{ id: 'a', maxHp: 100, hp: 100 }],
    definitions: [{ id: 'p', kind: 'dot', stack: 'refresh', cap: 1, duration: 20, period: 10, amount: 3 }],
    events: [{ id: 'e1', seq: 1, time: 0, op: 'apply', target: 'a', effect: 'p' }],
  };
  const r = simulate(cfg);
  const ticks = r.logs.filter((l) => l.root && l.root.kind === 'tick');
  check(ticks.length === 1 && ticks[0].time === 10, '仅 t=10 一跳，t=20 到期不跳');
  check(r.logs.some((l) => l.type === 'cleanup' && l.reason === 'expired' && l.time === 20), 't=20 到期清理');
}

{
  // 对已死亡目标的后续操作全部忽略
  const cfg = {
    actors: [{ id: 'a', maxHp: 5, hp: 5 }],
    definitions: [{ id: 'w', kind: 'shield', stack: 'refresh', cap: 1, duration: 10, amount: 1 }],
    events: [
      { id: 'e1', seq: 1, time: 0, op: 'damage', target: 'a', amount: 5 },
      { id: 'e2', seq: 2, time: 1, op: 'apply', target: 'a', effect: 'w' },
      { id: 'e3', seq: 3, time: 2, op: 'heal', target: 'a', amount: 5 },
      { id: 'e4', seq: 4, time: 3, op: 'damage', target: 'a', amount: 1 },
    ],
  };
  const r = simulate(cfg);
  check(r.logs.filter((l) => l.type === 'ignored').length === 3, '死后 3 个操作均记忽略');
  check(r.actors[0].hp === 0 && r.actors[0].dead, '保持死亡 hp=0');
}

{
  // 排序鲁棒性：乱序输入按 (time, seq) 稳定执行
  const cfg = {
    actors: [{ id: 'a', maxHp: 100, hp: 100 }],
    definitions: [{ id: 'w', kind: 'shield', stack: 'refresh', cap: 1, duration: 10, amount: 2 }],
    events: [
      { id: 'b', seq: 2, time: 5, op: 'damage', target: 'a', amount: 2 },
      { id: 'a', seq: 1, time: 0, op: 'apply', target: 'a', effect: 'w' },
    ],
  };
  const r = simulate(cfg);
  const dmg = r.logs.find((l) => l.type === 'damage');
  check(dmg.absorbed === 2 && dmg.hpAfter === 100, '乱序事件重排后护盾先生效');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
