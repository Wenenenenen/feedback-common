/* node --test 风格的断言脚本：node tests/solver.test.js */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Solver = require('../solver.js');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'game-mod-load-order.json'), 'utf8'));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

// ---------- 主样例：期望 festival@1.0.0 链 ----------
test('主样例求解：顺序与补丁合并完全匹配 expected', () => {
  const v = Solver.validateModel(sample);
  assert.ok(v.ok, v.errors && v.errors.join('; '));
  const sol = Solver.solve(v.model, v.model.roots);
  assert.ok(sol.feasible, JSON.stringify(sol.reasons));
  const order = sol.order.map(s => s.id + '@' + s.version);
  assert.deepStrictEqual(order, sample.expected.order);
  const sim = Solver.simulate(v.model, sol);
  assert.deepStrictEqual(sim.data, sample.expected.data);
  const powerHistory = sim.history['lamp.power'].map(h => h.value);
  assert.deepStrictEqual(powerHistory, sample.expected.powerHistory);
  // delete 的键不出现在合并数据
  assert.ok(!('lamp.old' in sim.data));
  // set null 键仍然存在
  assert.ok('lamp.tint' in sim.data && sim.data['lamp.tint'] === null);
  // 仅装了 3 个包
  assert.strictEqual(sol.selected.size, 3);
});

test('主样例：festival@2.0.0 不可行（theme 锁死 lamp<2.0.0），回退 1.0.0 有诊断不触发', () => {
  const v = Solver.validateModel(sample);
  const sol = Solver.solve(v.model, ['festival']);
  assert.ok(sol.feasible);
  assert.strictEqual(sol.selected.get('festival').rawV, '1.0.0');
});

// ---------- 环场景 ----------
test('环场景：a@2.0.0 成环，回退 a@1.0.0', () => {
  const v = Solver.validateModel(sample.cycle);
  assert.ok(v.ok);
  const sol = Solver.solve(v.model, v.model.roots);
  assert.ok(sol.feasible, JSON.stringify(sol.reasons));
  assert.deepStrictEqual(sol.order.map(s => s.id + '@' + s.version), sample.cycle.expectedOrder);
});

test('所有候选都在环上时无解，并给出成环诊断', () => {
  const m = {
    roots: ['a', 'b'], base: {},
    packs: [
      { id: 'a', v: '1.0.0', requires: [['b', '1.0.0', '2.0.0']] },
      { id: 'b', v: '1.0.0', requires: [['a', '1.0.0', '3.0.0']] }
    ]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['a', 'b']);
  assert.strictEqual(sol.feasible, false);
  assert.ok(sol.reasons.some(r => r.kind === 'cycle'), JSON.stringify(sol.reasons));
  assert.ok(sol.reasons.some(r => r.kind === 'stuck'));
});

test('自依赖直接判定成环', () => {
  const m = {
    roots: ['a'], base: {},
    packs: [{ id: 'a', v: '1.0.0', requires: [['a', '1.0.0', '2.0.0']] }]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['a']);
  assert.strictEqual(sol.feasible, false);
  assert.ok(sol.reasons.some(r => r.kind === 'cycle' && r.pkg === 'a'));
});

// ---------- 冲突场景 ----------
test('冲突场景：任一方声明冲突即无解', () => {
  const v = Solver.validateModel(sample.conflict);
  const sol = Solver.solve(v.model, v.model.roots);
  assert.strictEqual(sol.feasible, false);
  const cf = sol.reasons.find(r => r.kind === 'conflict');
  assert.ok(cf, '应有冲突诊断');
  assert.strictEqual(cf.declaredBy, 'a@1.0.0');
  assert.strictEqual(cf.other, 'b@1.0.0');
});

// ---------- 反向冲突：b 声明与 a 冲突 ----------
test('反向声明冲突同样禁止共存', () => {
  const m = {
    roots: ['a'], base: {},
    packs: [
      { id: 'a', v: '1.0.0', requires: [['b']] },
      { id: 'b', v: '1.0.0', conflicts: [['a']] }
    ]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['a']);
  assert.strictEqual(sol.feasible, false);
  assert.ok(sol.reasons.some(r => r.kind === 'conflict' && r.declaredBy === 'b@1.0.0'));
});

// ---------- 范围含下界不含上界 ----------
test('范围边界：等于下界可用，等于上界不可用', () => {
  const m = {
    roots: ['x'], base: {},
    packs: [
      { id: 'x', v: '1.0.0', requires: [['d', '1.0.0', '2.0.0']] },
      { id: 'd', v: '2.0.0' },
      { id: 'd', v: '1.0.0' }
    ]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['x']);
  assert.ok(sol.feasible);
  assert.strictEqual(sol.selected.get('d').rawV, '1.0.0');
});

// ---------- 多解优选：字典序最大版本向量，未选视为最低 ----------
test('多解优选：高包名优先升级，未选包低于任何已选版本', () => {
  const m = {
    roots: ['root'], base: {},
    packs: [
      { id: 'root', v: '1.0.0', requires: [['a'], ['b']] },
      { id: 'a', v: '2.0.0' }, { id: 'a', v: '1.0.0' },
      { id: 'b', v: '2.0.0' }, { id: 'b', v: '1.0.0' }
    ]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['root']);
  assert.strictEqual(sol.selected.get('a').rawV, '2.0.0');
  assert.strictEqual(sol.selected.get('b').rawV, '2.0.0');
});

test('多解优选：a 的低版本能让 z 装上时，优先 a 高版本（未选 z 视为最低）', () => {
  // 解 A: a@2.0.0, z 未选；解 B: a@1.0.0, z@1.0.0
  // 按包名排序 a 在 z 前，A 的 a 更高 → 取 A，z 不装
  const m = {
    roots: ['root'], base: {},
    packs: [
      { id: 'root', v: '1.0.0', requires: [['a']] },
      { id: 'a', v: '2.0.0' },
      { id: 'a', v: '1.0.0', requires: [['z']] },
      { id: 'z', v: '1.0.0' }
    ]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['root']);
  assert.strictEqual(sol.selected.get('a').rawV, '2.0.0');
  assert.ok(!sol.selected.has('z'), 'z 不应被安装');
});

test('多解优选：与暴力枚举结果一致（随机小模型交叉验证）', () => {
  let seed = 0x5eed;
  function rnd(n) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  }
  for (let iter = 0; iter < 200; iter++) {
    const ids = ['a', 'b', 'c', 'd'].slice(0, 2 + rnd(3));
    const packs = [];
    ids.forEach(id => {
      const n = 1 + rnd(3);
      for (let i = 1; i <= n; i++) packs.push({ id, v: i + '.0.0' });
    });
    // 随机加依赖与冲突
    packs.forEach(p => {
      if (rnd(2) === 0 && ids.some(x => x !== p.id)) {
        const dep = ids.filter(x => x !== p.id)[rnd(ids.length - 1)];
        const lo = (1 + rnd(2)) + '.0.0';
        p.requires = [[dep, lo, (3 + rnd(2)) + '.0.0']];
      }
      if (rnd(5) === 0) {
        const other = ids.filter(x => x !== p.id)[rnd(ids.length - 1)];
        p.conflicts = [[other]];
      }
    });
    const model = { roots: [ids[0]], base: {}, packs };
    const v = Solver.validateModel(model);
    if (!v.ok) continue;
    const sol = Solver.solve(v.model, v.model.roots);

    // 暴力枚举所有版本组合（含不选），过滤可行解，取字典序最大
    const options = v.model.ids.map(id => [null].concat(v.model.byId.get(id).versions));
    let best = null;
    function feasible(combo) {
      const sel = new Map();
      combo.forEach((p, i) => { if (p) sel.set(v.model.ids[i], p); });
      if (!sel.has(ids[0])) return null;
      // 闭包：依赖必须在 sel 中且满足范围
      let bad = false;
      sel.forEach((p) => {
        p.requires.forEach(r => {
          const dep = sel.get(r.id);
          if (!dep || !Solver.inRange(dep.vt, r.lo, r.hi)) bad = true;
        });
        p.conflicts.forEach(c => {
          const o = sel.get(c.id);
          if (o && Solver.inRange(o.vt, c.lo, c.hi)) bad = true;
        });
      });
      if (bad) return null;
      // 无环
      const color = new Map();
      function dfs(x) {
        color.set(x, 1);
        for (const r of (sel.get(x).requires || [])) {
          if (!sel.has(r.id)) continue;
          if (color.get(r.id) === 1) return false;
          if (!color.has(r.id) && !dfs(r.id)) return false;
        }
        color.set(x, 2);
        return true;
      }
      for (const id of sel.keys()) {
        if (!color.has(id) && !dfs(id)) return null;
      }
      // 可达性：每个已选包必须是根或能从根沿依赖到达（禁止安装多余的包）
      const reach = new Set();
      const stack = ids[0] && sel.has(ids[0]) ? [ids[0]] : [];
      while (stack.length) {
        const x = stack.pop();
        if (reach.has(x)) continue;
        reach.add(x);
        for (const r of (sel.get(x).requires || [])) {
          if (sel.has(r.id)) stack.push(r.id);
        }
      }
      for (const id of sel.keys()) {
        if (!reach.has(id)) return null;
      }
      return sel;
    }
    function recurse(i, combo) {
      if (i === options.length) {
        const sel = feasible(combo);
        if (sel) {
          const vec = v.model.ids.map(id => sel.has(id) ? sel.get(id).vt.slice() : null);
          if (!best || Solver.compareVectors(vec, best.vec) > 0) best = { vec, sel };
        }
        return;
      }
      for (const opt of options[i]) recurse(i + 1, combo.concat([opt]));
    }
    recurse(0, []);

    if (best) {
      assert.ok(sol.feasible, 'iter ' + iter + ': 求解器漏解 ' + JSON.stringify(model));
      const gotVec = Solver.solutionVector(v.model, sol.selected);
      assert.strictEqual(Solver.compareVectors(gotVec, best.vec), 0,
        'iter ' + iter + ': 非最优，模型=' + JSON.stringify(model));
    } else {
      assert.strictEqual(sol.feasible, false, 'iter ' + iter + ': 求解器误判有解 ' + JSON.stringify(model));
    }
  }
});

// ---------- 装载顺序：依赖先装，同层按包名 ----------
test('拓扑顺序：同层可先装的包按包名排', () => {
  const m = {
    roots: ['zeta'], base: {},
    packs: [
      { id: 'zeta', v: '1.0.0', requires: [['m'], ['a']] },
      { id: 'm', v: '1.0.0', requires: [['a']] },
      { id: 'a', v: '1.0.0' }
    ]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['zeta']);
  assert.deepStrictEqual(sol.order.map(s => s.id), ['a', 'm', 'zeta']);
  assert.deepStrictEqual(sol.order.map(s => s.direct), [false, false, true]);
});

// ---------- 同名包只选一个版本 ----------
test('同名包只选一个版本（两个根共享依赖，范围取交集）', () => {
  const m = {
    roots: ['r1', 'r2'], base: {},
    packs: [
      { id: 'r1', v: '1.0.0', requires: [['d', '1.0.0', '3.0.0']] },
      { id: 'r2', v: '1.0.0', requires: [['d', '2.0.0', '3.0.0']] },
      { id: 'd', v: '2.0.0' }, { id: 'd', v: '1.0.0' }
    ]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['r1', 'r2']);
  assert.ok(sol.feasible);
  assert.strictEqual(sol.selected.get('d').rawV, '2.0.0');
  assert.strictEqual(sol.selected.size, 3);
});

test('两个依赖范围无交集时报具体规则', () => {
  const m = {
    roots: ['r1', 'r2'], base: {},
    packs: [
      { id: 'r1', v: '1.0.0', requires: [['d', '1.0.0', '2.0.0']] },
      { id: 'r2', v: '1.0.0', requires: [['d', '2.0.0', '3.0.0']] },
      { id: 'd', v: '2.0.0' }, { id: 'd', v: '1.0.0' }
    ]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['r1', 'r2']);
  assert.strictEqual(sol.feasible, false);
  const rangeReasons = sol.reasons.filter(r => r.kind === 'range' && r.pkg === 'd');
  assert.ok(rangeReasons.some(r => r.by === 'r1@1.0.0' && r.rule.hi === '2.0.0'));
  assert.ok(rangeReasons.some(r => r.by === 'r2@1.0.0' && r.rule.lo === '2.0.0'));
  assert.ok(sol.reasons.some(r => r.kind === 'stuck' && r.pkg === 'd'));
});

// ---------- 未勾选包不安装 ----------
test('只装勾选包和实际需要的依赖；未勾选也不被依赖的包不装', () => {
  const m = {
    roots: ['r'], base: {},
    packs: [
      { id: 'r', v: '1.0.0' },
      { id: 'unused', v: '1.0.0' }
    ]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['r']);
  assert.ok(!sol.selected.has('unused'));
});

test('勾选不存在的包给出 unknown 诊断', () => {
  const v = Solver.validateModel(sample);
  const sol = Solver.solve(v.model, ['ghost']);
  assert.strictEqual(sol.feasible, false);
  assert.ok(sol.reasons.some(r => r.kind === 'unknown' && r.pkg === 'ghost'));
});

// ---------- 导入上限与校验 ----------
test('超过 24 个包 / 每包超过 6 个版本被拒', () => {
  const many = { roots: [], base: {}, packs: [] };
  for (let i = 0; i < 25; i++) many.packs.push({ id: 'p' + i, v: '1.0.0' });
  assert.strictEqual(Solver.validateModel(many).ok, false);
  const over = { roots: [], base: {}, packs: [] };
  for (let i = 1; i <= 7; i++) over.packs.push({ id: 'p', v: i + '.0.0' });
  const res = Solver.validateModel(over);
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some(e => e.includes('上限 6')));
});

test('非法版本号、未知依赖、空范围、坏 patch 均被拒', () => {
  assert.strictEqual(Solver.validateModel({
    roots: [], base: {}, packs: [{ id: 'p', v: '1.0' }]
  }).ok, true); // 两段允许，补齐
  assert.strictEqual(Solver.validateModel({
    roots: [], base: {}, packs: [{ id: 'p', v: '1.x.0' }]
  }).ok, false);
  assert.strictEqual(Solver.validateModel({
    roots: ['p'], base: {}, packs: [{ id: 'p', v: '1.0.0', requires: [['q']] }]
  }).ok, false);
  assert.strictEqual(Solver.validateModel({
    roots: ['p'], base: {},
    packs: [{ id: 'p', v: '1.0.0', requires: [['p', '2.0.0', '2.0.0']] }]
  }).ok, false);
  assert.strictEqual(Solver.validateModel({
    roots: ['p'], base: {},
    packs: [{ id: 'p', v: '1.0.0', patch: [['frobnicate', 'k']] }]
  }).ok, false);
});

// ---------- 覆盖来源链 ----------
test('逐项历史：base → set → delete → set 的来源与值完整', () => {
  const m = {
    roots: ['r'],
    base: { k: 0 },
    packs: [
      { id: 'r', v: '1.0.0', requires: [['d']], patch: [['set', 'k', 2]] },
      { id: 'd', v: '1.0.0', patch: [['delete', 'k'], ['set', 'k', 1]] }
    ]
  };
  const v = Solver.validateModel(m);
  const sol = Solver.solve(v.model, ['r']);
  const sim = Solver.simulate(v.model, sol);
  assert.strictEqual(sim.data.k, 2);
  assert.deepStrictEqual(sim.history.k.map(h => [h.op, h.source]), [
    ['base', 'base'], ['delete', 'd@1.0.0'], ['set', 'd@1.0.0'], ['set', 'r@1.0.0']
  ]);
});

console.log('\n全部 ' + passed + ' 项测试通过');
