/* 随机差分测试：独立朴素实现 vs 引擎，覆盖随机 DAG、多字段 observe、各种分块轨迹 */
const assert = require('assert');
const RWS = require('../engine.js');

function toI32(x) { return x | 0; }

// 完全独立的朴素解释器（与引擎代码风格刻意不同）
function naiveReplay(doc, positions) {
  const oldS = Object.assign({}, doc.initial);
  const newS = Object.assign({}, doc.initial);
  const run = (table, kind, s) => {
    const list = table[kind];
    if (!list) return;
    for (const [cond, op, field, arg] of list) {
      if (cond) {
        const [cf, cmp, cv] = cond;
        const cur = s[cf] === undefined ? 0 : s[cf];
        if (cmp === 'eq' ? cur !== cv : !(cur < cv)) continue;
      }
      const cur = s[field] === undefined ? 0 : s[field];
      s[field] = op === 'set' ? toI32(arg) : toI32(cur + arg);
    }
  };
  let first = null;
  for (const idx of positions) {
    const ev = doc.events[idx];
    run(doc.old, ev.kind, oldS);
    run(doc.next, ev.kind, newS);
    if (!first) {
      for (const f of doc.observe) {
        const a = oldS[f] === undefined ? 0 : oldS[f];
        const b = newS[f] === undefined ? 0 : newS[f];
        if (a !== b) {
          first = { eventIndex: idx, field: f, sign: b - a > 0 ? '+' : '-', oldValue: a, nextValue: b };
          break;
        }
      }
    }
  }
  return first;
}

// 朴素级联闭包：删种子集合，沿 deps 反向传播
function naiveClosure(doc, aliveSet, seedPositions, positions) {
  const idToPos = new Map(positions.map((oi, p) => [oi, p]));
  const removed = new Set(seedPositions.map((p) => positions[p]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const oi of positions) {
      if (removed.has(oi)) continue;
      const ev = doc.events[oi];
      if (ev.deps.some((d) => removed.has(doc.events.findIndex((e) => e.id === d)))) {
        removed.add(oi);
        changed = true;
      }
    }
  }
  return positions.filter((oi) => !removed.has(oi));
}

function naiveSplit(m, k) {
  const q = Math.floor(m / k), rem = m % k;
  const blocks = [];
  let cur = 0;
  for (let b = 0; b < k; b++) {
    const len = q + (b < rem ? 1 : 0);
    blocks.push([cur, cur + len]);
    cur += len;
  }
  return blocks;
}

// 与规则一致的朴素缩减主循环，逐步返回每轮试删判定
function naiveShrink(doc) {
  let positions = doc.events.map((_, i) => i);
  const baseW = naiveReplay(doc, positions);
  if (!baseW) return { status: 'no-diff', positions, witness: null };
  const sameWitness = (w) => w && w.eventIndex === baseW.eventIndex && w.field === baseW.field && w.sign === baseW.sign;
  let k = 2;
  const trace = [];
  while (k <= positions.length) {
    const blocks = naiveSplit(positions.length, k);
    let accepted = false;
    for (const [lo, hi] of blocks) {
      const seeds = [];
      for (let p = lo; p < hi; p++) seeds.push(p);
      const nextPos = naiveClosure(doc, null, seeds, positions);
      const w = naiveReplay(doc, nextPos);
      trace.push({ k, lo, hi, ok: sameWitness(w), got: w });
      if (sameWitness(w)) {
        positions = nextPos;
        accepted = true;
        k = 2;
        break;
      }
    }
    if (!accepted) {
      if (k >= positions.length) break;
      k = Math.min(k * 2, positions.length);
    }
  }
  return { status: 'finished', positions, witness: baseW, trace };
}

let seed = 20261123;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

function randomDoc(n, kindCount, multiField) {
  const fields = multiField ? ['score', 'token', 'combo'] : ['score'];
  const initial = {};
  fields.forEach((f) => { initial[f] = Math.floor(rnd() * 20) - 10; });
  const kinds = [];
  for (let k = 0; k < kindCount; k++) kinds.push('k' + k);
  kinds.push('idle');
  const mkTable = (versionBias) => {
    const t = {};
    for (const kind of kinds) {
      if (kind === 'idle') continue;
      const ins = [];
      const steps = 1 + Math.floor(rnd() * 2);
      for (let s = 0; s < steps; s++) {
        const hasCond = rnd() < 0.4;
        const cond = hasCond ? [pick(fields), rnd() < 0.5 ? 'eq' : 'lt', Math.floor(rnd() * 10) - 5] : null;
        const arg = Math.floor(rnd() * 9) - 4 + (versionBias && rnd() < 0.3 ? 1 : 0);
        ins.push([cond, rnd() < 0.5 ? 'set' : 'add', pick(fields), arg]);
      }
      t[kind] = ins;
    }
    return t;
  };
  const old = mkTable(false);
  const next = mkTable(true);
  const events = [];
  for (let i = 0; i < n; i++) {
    const deps = [];
    if (i > 0 && rnd() < 0.7) {
      const depCount = 1 + Math.floor(rnd() * 2);
      for (let d = 0; d < depCount; d++) {
        const j = Math.floor(rnd() * i);
        if (!deps.includes(events[j].id)) deps.push(events[j].id);
      }
    }
    events.push({ id: 'e' + i, frame: i, kind: pick(kinds), deps });
  }
  return {
    initial,
    observe: multiField ? fields : ['score'],
    old, next, events,
  };
}

async function main() {
  let cases = 0;
  for (let iter = 0; iter < 300; iter++) {
    const n = 1 + Math.floor(rnd() * 40);
    const doc = randomDoc(n, 2 + Math.floor(rnd() * 3), rnd() < 0.5);
    const v = RWS.validate(doc);
    if (!v.ok) throw new Error('随机器生成了非法输入: ' + JSON.stringify(v.errors));
    const model = RWS.buildModel(doc);
    const base = RWS.baseline(model);
    const naiveW = naiveReplay(doc, doc.events.map((_, i) => i));
    assert.deepStrictEqual(base.witness && {
      eventIndex: base.witness.eventIndex,
      field: base.witness.field,
      sign: base.witness.sign,
      oldValue: base.witness.oldValue,
      nextValue: base.witness.nextValue,
    }, naiveW, '基线见证与朴素实现不一致');

    const res = await RWS.shrink(model, base, {});
    const ref = naiveShrink(doc);
    if (ref.status === 'no-diff') {
      assert.strictEqual(res.status, 'no-diff');
      cases++;
      continue;
    }
    assert.deepStrictEqual(Array.from(res.alive), ref.positions, '缩减结果与朴素实现不一致');
    // 缩减结果必须仍锁定同一见证，且编号/帧保持原值
    const verify = RWS.replayReduced(model, res.alive);
    assert.ok(verify.firstDiff);
    assert.strictEqual(verify.firstDiff.eventIndex, ref.witness.eventIndex);
    assert.strictEqual(verify.firstDiff.field, ref.witness.field);
    assert.strictEqual(verify.firstDiff.sign, ref.witness.sign);
    for (const oi of res.alive) {
      const ev = doc.events[oi];
      assert.strictEqual(ev.frame, oi); // 帧与原编号保留
    }
    cases++;
  }
  console.log('随机差分测试通过：' + cases + ' 个随机 DAG 用例，引擎与朴素实现完全一致');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
