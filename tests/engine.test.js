#!/usr/bin/env node
'use strict';
/*
 * Node test harness for the ECS engine.
 * Run: node tests/engine.test.js <cases-dir>
 * Exit code 0 when every check passes.
 */
const fs = require('fs');
const path = require('path');
const enginePath = path.join(__dirname, '..', 'src', 'engine.js');
const { World, helpers, constants } = require(enginePath);

const casesDir = process.argv[2] || '/tmp/ecs-cases';
let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name + '\n       ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : err));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg || 'mismatch') + '\n       actual:   ' + a + '\n       expected: ' + e);
}
function readCase(name) {
  return JSON.parse(fs.readFileSync(path.join(casesDir, name), 'utf8'));
}
function loadRun(file) {
  const data = readCase(file);
  const w = new World();
  w.enqueueExternal(data.commands);
  return { w, data };
}
function handleStr(h) { return h.slot + ':' + h.generation; }
function componentSnapshot(w, handle) {
  const view = w.entityView(handle);
  if (!view.valid) return null;
  const out = {};
  for (const name of Object.keys(view.values)) out[name] = view.values[name];
  return { handle: view.handle, components: out };
}
function sortedBySlot(views) {
  return views.slice().sort((a, b) => a.slot - b.slot || a.generation - b.generation);
}

console.log('ECS engine tests — cases dir: ' + casesDir);

// ---------------------------------------------------------------------------
console.log('\n[reuse.json — destroy/reuse with generations]');
check('reuse sample matches expected', () => {
  const { w, data } = loadRun('reuse.json');
  w.step();
  const lastCreateEvent = w.events.filter((e) => e.type === 'create').pop();
  eq(lastCreateEvent.handle, data.expected.lastCreate, 'lastCreate');
  const failed = w.events.filter((e) => e.type === 'cmd' && !e.ok).pop();
  eq(failed.reason, data.expected.lastError, 'lastError');
  const view = w.entityView(data.expected.lastCreate);
  eq(view.values.Position, data.expected.position, 'position @ reused slot');
  // The stale handle must not be able to touch the new entity.
  eq(w.entityView({ slot: 0, generation: 1 }).error, '过期句柄', 'stale handle rejected');
});

// ---------------------------------------------------------------------------
console.log('\n[barrier.json — structural system commands are deferred]');
check('tick 0 flush destroys generator but it still spawns this tick', () => {
  const { w, data } = loadRun('barrier.json');
  w.step();
  const alive = w.query([], []);
  eq(alive.length, data.expectedAfterTick0.length, 'alive count after tick 0');
  const child = data.expectedAfterTick0[0];
  const view = w.entityView(child.handle);
  assert(view.valid, 'child exists at expected handle');
  eq(view.values, child.components, 'child components');
  // generator destroyed by damage (Health 1 - Poison 1 = 0), and it spawned first.
  const types = w.events.filter((e) => e.tick === 0).map((e) => e.type);
  assert(types.indexOf('spawn') >= 0, 'spawn happened');
  assert(types.indexOf('destroy') >= 0, 'destroy happened');
  assert(types.indexOf('spawn') < types.indexOf('destroy'), 'spawn queued before destroy applied');
  eq(w.tick, 1, 'tick advanced');
});
check('tick 1 keeps the child moving, generator stays gone', () => {
  const { w, data } = loadRun('barrier.json');
  w.step();
  w.step();
  const alive = w.query([], []);
  eq(alive.length, data.expectedAfterTick1.length, 'alive count after tick 1');
  const child = data.expectedAfterTick1[0];
  eq(w.entityView(child.handle).values, child.components, 'child components after tick 1');
});

// ---------------------------------------------------------------------------
console.log('\n[migration.json — archetype migration]');
check('migration sample matches expected', () => {
  const { w, data } = loadRun('migration.json');
  w.step();
  const positions = {};
  for (const e of w.query(['Position'], [])) positions[handleStr(e)] = [e.values.Position.x, e.values.Position.y];
  eq(positions, data.expectedAfterTick0.positions, 'positions');
  eq(w.queryHandles(['Position'], ['Velocity']), data.expectedAfterTick0.queryPositionWithoutVelocity, 'query without Velocity');
  // Migration happened exactly once, and handles are unchanged.
  const mig = w.events.filter((e) => e.type === 'migrate');
  eq(mig.length, 1, 'one migration');
  eq(mig[0].from, 'Position');
  eq(mig[0].to, 'Position+Velocity');
  eq(mig[0].handle, { slot: 0, generation: 1 }, 'migration keeps handle');
});

// ---------------------------------------------------------------------------
console.log('\n[stress.json — 10000 entities / 20000 commands]');
let stressWorld = null;
check('stress sample runs in one tick and lands on the expected shape', () => {
  const t0 = Date.now();
  let w;
  if (fs.existsSync(path.join(casesDir, 'stress.json'))) {
    w = loadRun('stress.json').w;
  } else {
    // samples/cases has no 3.7MB stress file: regenerate the identical command set
    w = new World();
    w.enqueueExternal(helpers.stressCommands());
  }
  const report = w.step();
  stressWorld = w;
  eq(report.external.count, 20000, 'all external commands flushed');
  eq(report.external.failed, 0, 'no failures');
  eq(w.aliveCount, 10000, 'alive entities');
  eq(w.query(['Position', 'Velocity', 'Frozen'], []).length, 10000, 'frozen query');
  eq(w.query(['Position', 'Velocity'], ['Frozen']).length, 0, 'held query empty');
  eq(w.stats().internalCounter, 0, 'no spawns (no Spawner)');
  const ms = Date.now() - t0;
  console.log('       elapsed ' + ms + ' ms');
  assert(ms < 15000, 'stress run under 15s');
});

// ---------------------------------------------------------------------------
console.log('\n[core semantics]');
check('allocation takes the smallest free slot, then extends', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: {} },
    { seq: 2, op: 'create', components: {} },
    { seq: 3, op: 'create', components: {} },
    { seq: 4, op: 'destroy', handle: { slot: 1, generation: 1 } },
    { seq: 5, op: 'destroy', handle: { slot: 2, generation: 1 } },
    { seq: 6, op: 'create', components: {} },
    { seq: 7, op: 'create', components: {} },
    { seq: 8, op: 'create', components: {} },
  ]);
  w.step();
  const created = w.events.filter((e) => e.type === 'create').map((e) => handleStr(e.handle));
  eq(created, ['0:1', '1:1', '2:1', '1:2', '2:2', '3:1'], 'alloc order');
});

check('generation is bumped on destroy; repeated destroy fails', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: {} },
    { seq: 2, op: 'destroy', handle: { slot: 0, generation: 1 } },
    { seq: 3, op: 'destroy', handle: { slot: 0, generation: 1 } },
    { seq: 4, op: 'destroy', handle: { slot: 0, generation: 2 } },
  ]);
  w.step();
  const cmds = w.events.filter((e) => e.type === 'cmd');
  eq(cmds.map((e) => e.ok), [true, true, false, false], 'ok flags');
  eq(cmds[2].reason, '过期句柄');
  eq(cmds[3].reason, '实体为空');
  eq(w.slotView()[0].generation, 2, 'generation bumped once');
});

check('add existing / remove missing / set missing are per-command errors', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: { Position: { x: 0, y: 0 } } },
    { seq: 2, op: 'add', handle: { slot: 0, generation: 1 }, component: 'Position', value: { x: 1, y: 1 } },
    { seq: 3, op: 'remove', handle: { slot: 0, generation: 1 }, component: 'Velocity' },
    { seq: 4, op: 'set', handle: { slot: 0, generation: 1 }, component: 'Velocity', value: { x: 1, y: 1 } },
    { seq: 5, op: 'set', handle: { slot: 0, generation: 1 }, component: 'Position', value: { x: 5, y: 6 } },
  ]);
  w.step();
  const cmds = w.events.filter((e) => e.type === 'cmd');
  eq(cmds.map((e) => e.ok), [true, false, false, false, true]);
  eq(cmds[1].reason, '组件已存在: Position');
  eq(cmds[2].reason, '组件不存在: Velocity');
  eq(cmds[3].reason, '组件不存在: Velocity');
  eq(w.entityView({ slot: 0, generation: 1 }).values.Position, { x: 5, y: 6 });
});

check('failed command does not block later commands', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'set', handle: { slot: 9, generation: 1 }, component: 'Position', value: { x: 0, y: 0 } },
    { seq: 2, op: 'create', components: {} },
    { seq: 3, op: 'add', handle: { slot: 0, generation: 1 }, component: 'Poison', value: { amount: 3 } },
  ]);
  w.step();
  const cmds = w.events.filter((e) => e.type === 'cmd');
  eq(cmds.map((e) => e.ok), [false, true, true]);
  eq(w.entityView({ slot: 0, generation: 1 }).values.Poison, { amount: 3 });
});

check('commands are processed in seq order; duplicate seqs are rejected', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 5, op: 'create', components: {} },
    { seq: 3, op: 'create', components: {} },
    { seq: 5, op: 'create', components: {} },
    { seq: 2, op: 'create', components: {} },
  ]);
  w.step();
  const cmds = w.events.filter((e) => e.type === 'cmd');
  eq(cmds.map((e) => e.seq), [2, 3, 5, 5]);
  eq(cmds.map((e) => e.handle ? handleStr(e.handle) : null).filter(Boolean), ['0:1', '1:1', '2:1']);
  eq(cmds[3].ok, false);
  eq(cmds[3].reason, 'seq 重复');
  // A new command with an old, never-used seq is accepted; one reusing a used seq is not.
  const ev = w.applyExternalCommand({ seq: 4, op: 'create', components: {} });
  eq(ev.ok, true, 'unused lower seq accepted');
  const ev2 = w.applyExternalCommand({ seq: 4, op: 'create', components: {} });
  eq(ev2.ok, false, 'used seq rejected');
  eq(ev2.reason, 'seq 重复');
});

check('new entities do not take part in systems on their birth tick', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: { Position: { x: 0, y: 0 }, Velocity: { x: 10, y: 0 } } },
    { seq: 2, op: 'create', components: { Position: { x: 0, y: 0 }, Velocity: { x: 10, y: 0 }, Spawner: { period: 1, vx: 0, vy: 0 } } },
  ]);
  // tick 0: both external creates are flushed first, so both integrate.
  w.step();
  eq(w.entityView({ slot: 0, generation: 1 }).values.Position, { x: 10, y: 0 });
  // The spawner child is created at the barrier of tick 0; it must not move until tick 1.
  const child = w.events.filter((e) => e.type === 'syscmd' && e.op === 'create').pop();
  assert(child && child.ok, 'child created');
  const childView = w.entityView(child.handle);
  // Born at the barrier with the parent's post-integration position (10,0) and
  // velocity (0,0); it must not be integrated again on its birth tick.
  eq(childView.values.Position, { x: 10, y: 0 }, 'child not integrated on birth tick');
  w.step();
  eq(w.entityView(child.handle).values.Position, { x: 10, y: 0 }, 'child has Spawner velocity 0');
});

check('spawner period gates emission and uses post-integration position', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: {
      Position: { x: -4, y: 0 }, Velocity: { x: 1, y: 0 },
      Spawner: { period: 3, vx: 0, vy: 2 },
    } },
  ]);
  for (let i = 0; i < 7; i++) w.step();
  const spawns = w.events.filter((e) => e.type === 'spawn');
  eq(spawns.map((e) => e.tick), [0, 3, 6], 'spawn ticks');
  eq(spawns[0].components.Position, { x: -3, y: 0 }, 'position after integrate');
  eq(spawns[2].components.Position, { x: 3, y: 0 });
  const children = w.query(['Spawner'], []);
  eq(children.length, 1, 'children have no Spawner');
  eq(w.query([], []).length, 4, 'three children + parent');
});

check('damage destroys but the entity still participates in later systems that tick', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: {
      Position: { x: 0, y: 0 }, Health: { value: 2 }, Poison: { amount: 5 },
      Spawner: { period: 1, vx: 0, vy: 0 },
    } },
  ]);
  w.step();
  const spawns = w.events.filter((e) => e.type === 'spawn');
  eq(spawns.length, 1, 'spawner still emitted after lethal damage step');
  const destroys = w.events.filter((e) => e.type === 'destroy');
  eq(destroys.length, 1);
  eq(destroys[0].tick, 0);
  eq(destroys[0].cause, 'damage');
  w.step();
  // Next tick: Health+Poison entity gone; children (Health 1, no Poison) survive.
  eq(w.query(['Health', 'Poison'], []).length, 0);
  eq(w.query(['Health'], []).length, 1);
});

check('a destroy queued for a slot that was reused fails instead of killing the new entity', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: { Health: { value: 2 }, Poison: { amount: 2 } } },
    // external destroy of the same entity is applied BEFORE systems → damage sees it gone,
    // so queue a system destroy by making damage kill it, then reuse the slot externally next tick.
  ]);
  w.step();
  eq(w.query([], []).length, 0, 'killed by damage');
  w.enqueueExternal([{ seq: 2, op: 'create', components: { Health: { value: 7 } } }]);
  w.step();
  eq(w.entityView({ slot: 0, generation: 2 }).values.Health, { value: 7 }, 'reused slot alive');
  // A stale system destroy could only exist if queued while alive; simulate the queue directly.
  const w2 = new World();
  w2.enqueueExternal([{ seq: 1, op: 'create', components: { Health: { value: 1 }, Poison: { amount: 1 } } }]);
  // Drain external only, run systems, then externally destroy+recreate before flush:
  w2.flushExternal();
  w2.runIntegrate({ integrate: { count: 0, overflow: 0 } });
  w2.runDamage({ damage: { count: 0, overflow: 0, queuedDestroy: 0 } });
  eq(w2.systemPending.length, 1, 'destroy queued');
  w2.enqueueExternal([
    { seq: 2, op: 'destroy', handle: { slot: 0, generation: 1 } },
    { seq: 3, op: 'create', components: { Health: { value: 5 } } },
  ]);
  // Not a real tick order, but proves the barrier validation: apply the flush directly.
  w2.flushExternal();
  w2.flushSystem();
  const sys = w2.events.filter((e) => e.type === 'syscmd');
  eq(sys.length, 1);
  eq(sys[0].ok, false, 'stale system destroy rejected');
  eq(w2.entityView({ slot: 0, generation: 2 }).values.Health, { value: 5 }, 'new entity survives');
});

check('queries reject overlapping include/exclude', () => {
  const w = new World();
  let threw = null;
  try { w.query(['Position'], ['Position']); } catch (e) { threw = e; }
  assert(threw && /交叠/.test(threw.message), 'overlap rejected');
});

check('queries are stable and sorted by slot then generation', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: { Position: { x: 0, y: 0 } } },
    { seq: 2, op: 'create', components: { Position: { x: 1, y: 0 } } },
    { seq: 3, op: 'create', components: { Position: { x: 2, y: 0 }, Frozen: {} } },
    { seq: 4, op: 'destroy', handle: { slot: 0, generation: 1 } },
    { seq: 5, op: 'create', components: { Position: { x: 3, y: 0 } } },
  ]);
  w.step();
  eq(w.queryHandles(['Position'], []), [
    { slot: 0, generation: 2 }, { slot: 1, generation: 1 }, { slot: 2, generation: 1 },
  ], 'ordered by slot');
  eq(w.queryHandles(['Position'], ['Frozen']), [
    { slot: 0, generation: 2 }, { slot: 1, generation: 1 },
  ], 'excluding Frozen');
});

check('int32 overflow skips only that entity for that system and is reported', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: { Position: { x: 2147483647, y: 0 }, Velocity: { x: 1, y: 0 } } },
    { seq: 2, op: 'create', components: { Position: { x: 0, y: 0 }, Velocity: { x: 5, y: 5 } } },
    { seq: 3, op: 'create', components: { Health: { value: -2147483648 }, Poison: { amount: 1 } } },
  ]);
  const report = w.step();
  eq(report.integrate.overflow, 1);
  eq(report.damage.overflow, 1);
  eq(w.entityView({ slot: 0, generation: 1 }).values.Position, { x: 2147483647, y: 0 }, 'overflow untouched');
  eq(w.entityView({ slot: 1, generation: 1 }).values.Position, { x: 5, y: 5 }, 'other entity moved');
  eq(w.entityView({ slot: 2, generation: 1 }).values.Health, { value: -2147483648 }, 'health untouched');
  const ovf = w.events.filter((e) => e.type === 'overflow');
  eq(ovf.length, 2);
  assert(ovf[0].detail.indexOf('超出 int32') >= 0, 'detail mentions int32');
});

check('component value validation', () => {
  const bad = [
    { component: 'Position', value: { x: 1 } },
    { component: 'Position', value: { x: 1, y: 2, z: 3 } },
    { component: 'Position', value: { x: 1.5, y: 0 } },
    { component: 'Poison', value: { amount: -1 } },
    { component: 'Spawner', value: { period: 0, vx: 0, vy: 0 } },
    { component: 'Frozen', value: { x: 0 } },
  ];
  for (const { component, value } of bad) {
    let threw = null;
    try { helpers.normalizeComponentValue(component, value); } catch (e) { threw = e; }
    assert(threw, 'rejected ' + component + ' ' + JSON.stringify(value));
  }
  eq(helpers.normalizeComponentValue('Frozen', {}), {});
  eq(helpers.normalizeComponentValue('Health', { value: -3 }), { value: -3 });
});

check('entity cap of 10000 is enforced per create', () => {
  const w = new World();
  const cmds = [];
  for (let i = 0; i < 10001; i++) cmds.push({ seq: i + 1, op: 'create', components: {} });
  w.enqueueExternal(cmds);
  w.step();
  eq(w.aliveCount, 10000);
  const last = w.events.filter((e) => e.type === 'cmd').pop();
  eq(last.ok, false);
  assert(/10000/.test(last.reason), 'cap reason');
});

check('external pending cap of 20000', () => {
  const w = new World();
  const cmds = [];
  for (let i = 0; i < 20001; i++) cmds.push({ seq: i + 1, op: 'create', components: {} });
  let threw = null;
  try { w.enqueueExternal(cmds); } catch (e) { threw = e; }
  assert(threw && /20000/.test(threw.message), 'cap enforced');
});

// ---------------------------------------------------------------------------
console.log('\n[persistence — resume equals uninterrupted run]');

function scenarioCommands(seed, n) {
  const rnd = helpers.mulberry32(seed);
  const cmds = [];
  let seq = 0;
  const alive = [];
  let nextSlotGuess = 0;
  bySeed: for (let i = 0; i < n; i++) {
    const r = rnd();
    seq++;
    if (r < 0.35 || alive.length === 0) {
      const comps = {};
      if (rnd() < 0.8) comps.Position = { x: Math.floor(rnd() * 20) - 10, y: Math.floor(rnd() * 20) - 10 };
      if (rnd() < 0.5) comps.Velocity = { x: Math.floor(rnd() * 5) - 2, y: Math.floor(rnd() * 5) - 2 };
      if (rnd() < 0.4) comps.Health = { value: Math.floor(rnd() * 20) + 1 };
      if (rnd() < 0.3) comps.Poison = { amount: Math.floor(rnd() * 4) };
      if (rnd() < 0.15) comps.Spawner = { period: 1 + Math.floor(rnd() * 3), vx: Math.floor(rnd() * 3) - 1, vy: 0 };
      if (rnd() < 0.1) comps.Frozen = {};
      cmds.push({ seq, op: 'create', components: comps });
      continue;
    }
    const h = alive[Math.floor(rnd() * alive.length)];
    const roll = rnd();
    if (roll < 0.3) {
      cmds.push({ seq, op: 'destroy', handle: { ...h } });
    } else if (roll < 0.55) {
      const comp = ['Position', 'Velocity', 'Health', 'Poison', 'Frozen', 'Spawner'][Math.floor(rnd() * 6)];
      const values = {
        Position: () => ({ x: Math.floor(rnd() * 20), y: 0 }),
        Velocity: () => ({ x: Math.floor(rnd() * 4) - 2, y: 1 }),
        Health: () => ({ value: 1 + Math.floor(rnd() * 9) }),
        Poison: () => ({ amount: Math.floor(rnd() * 3) }),
        Frozen: () => ({}),
        Spawner: () => ({ period: 1 + Math.floor(rnd() * 2), vx: 1, vy: 0 }),
      };
      cmds.push({ seq, op: 'add', handle: { ...h }, component: comp, value: values[comp]() });
    } else if (roll < 0.75) {
      const comp = ['Position', 'Velocity', 'Health', 'Poison', 'Frozen', 'Spawner'][Math.floor(rnd() * 6)];
      cmds.push({ seq, op: 'remove', handle: { ...h }, component: comp });
    } else {
      const comp = ['Position', 'Velocity', 'Health', 'Poison', 'Frozen', 'Spawner'][Math.floor(rnd() * 6)];
      const values = {
        Position: () => ({ x: Math.floor(rnd() * 20), y: 2 }),
        Velocity: () => ({ x: 1, y: 1 }),
        Health: () => ({ value: 2 + Math.floor(rnd() * 9) }),
        Poison: () => ({ amount: 1 }),
        Frozen: () => ({}),
        Spawner: () => ({ period: 2, vx: 1, vy: 1 }),
      };
      cmds.push({ seq, op: 'set', handle: { ...h }, component: comp, value: values[comp]() });
    colorless: ;
    }
    if (alive.length > 400) alive.splice(0, 100);
  }
  return cmds;
}

check('deterministic complex scenario: snapshot at every cut resumes identically', () => {
  // Build a command stream with handles learned from a dry run, so commands are valid.
  const base = new World();
  const rnd = helpers.mulberry32(99);
  const cmds = [];
  const live = [];
  let seq = 0;
  for (let i = 0; i < 400; i++) {
    seq++;
    if (live.length === 0 || rnd() < 0.35 || live.length < 3) {
      const comps = {};
      if (rnd() < 0.9) comps.Position = { x: Math.floor(rnd() * 40) - 20, y: Math.floor(rnd() * 10) };
      if (rnd() < 0.6) comps.Velocity = { x: Math.floor(rnd() * 3) + 1, y: 0 };
      if (rnd() < 0.5) comps.Health = { value: 1 + Math.floor(rnd() * 15) };
      if (rnd() < 0.4) comps.Poison = { amount: Math.floor(rnd() * 3) };
      if (rnd() < 0.2) comps.Spawner = { period: 1 + Math.floor(rnd() * 2), vx: 1, vy: 0 };
      if (rnd() < 0.15) comps.Frozen = {};
      const res = base.createEntity(comps, { phase: 'test' });
      live.push({ slot: res.handle.slot, generation: res.handle.generation });
      cmds.push({ seq, op: 'create', components: comps });
    } else {
      const h = live[Math.floor(rnd() * live.length)];
      const roll = rnd();
      if (roll < 0.3) {
        cmds.push({ seq, op: 'destroy', handle: { ...h } });
        const idx = live.indexOf(h);
        const view = base.entityView(h);
        if (view.valid) base.destroyEntity(h, { phase: 'test' });
        live.splice(idx, 1);
      } else if (roll < 0.6) {
        const comp = ['Position', 'Velocity', 'Health', 'Poison', 'Frozen', 'Spawner'][Math.floor(rnd() * 6)];
        const value = comp === 'Position' ? { x: 3, y: 4 }
          : comp === 'Velocity' ? { x: 1, y: 2 }
          : comp === 'Health' ? { value: 5 }
          : comp === 'Poison' ? { amount: 2 }
          : comp === 'Spawner' ? { period: 2, vx: 1, vy: 1 } : {};
        cmds.push({ seq, op: 'add', handle: { ...h }, component: comp, value });
      } else if (roll < 0.8) {
        const comp = ['Position', 'Velocity', 'Health', 'Poison', 'Frozen', 'Spawner'][Math.floor(rnd() * 6)];
        cmds.push({ seq, op: 'remove', handle: { ...h }, component: comp });
      } else {
        const comp = ['Position', 'Velocity', 'Health', 'Poison', 'Frozen', 'Spawner'][Math.floor(rnd() * 6)];
        const value = comp === 'Position' ? { x: 1, y: 1 }
          : comp === 'Velocity' ? { x: 1, y: 0 }
          : comp === 'Health' ? { value: 9 }
          : comp === 'Poison' ? { amount: 1 }
          : comp === 'Spawner' ? { period: 1, vx: 1, vy: 0 } : {};
        cmds.push({ seq, op: 'set', handle: { ...h }, component: comp, value });
      }
    }
  }

  // Uninterrupted reference: batches of 7 commands per tick.
  const ref = new World();
  let cursor = 0;
  const ticks = 80;
  for (let t = 0; t < ticks; t++) {
    ref.enqueueExternal(cmds.slice(cursor, cursor + 7));
    cursor += 7;
    ref.step();
  }
  const refDigest = ref.digest();
  const refState = JSON.stringify({ stats: ref.stats(), queries: [ref.queryHandles([], []), ref.queryHandles(['Position'], ['Frozen'])] });

  for (const cut of [1, 2, 5, 17, 30, 44, 61, 79]) {
    const a = new World();
    let c = 0;
    for (let t = 0; t < cut; t++) {
      a.enqueueExternal(cmds.slice(c, c + 7));
      c += 7;
      a.step();
    }
    const saved = JSON.parse(JSON.stringify(a.save()));
    const b = World.fromSnapshot(saved);
    // Continue to the same total on both.
    for (let t = cut; t < ticks; t++) {
      b.enqueueExternal(cmds.slice(c, c + 7));
      c += 7;
      b.step();
    }
    eq(b.digest(), refDigest, 'digest at cut ' + cut);
    eq(JSON.stringify({ stats: b.stats(), queries: [b.queryHandles([], []), b.queryHandles(['Position'], ['Frozen'])] }), refState, 'state at cut ' + cut);
    // Handles allocated after resume stay identical.
    eq(b.slotView(), ref.slotView(), 'slot table at cut ' + cut);
  }
});

check('snapshot keeps pending queues and clock and continues exactly', () => {
  const w = new World();
  w.enqueueExternal([{ seq: 1, op: 'create', components: {
    Position: { x: 0, y: 0 }, Velocity: { x: 2, y: 0 }, Health: { value: 3 }, Poison: { amount: 4 },
    Spawner: { period: 5, vx: 0, vy: 0 },
  } }]);
  w.step();
  w.step();
  // Queue commands that are NOT yet flushed, plus a spawner emission at tick 5.
  w.enqueueExternal([
    { seq: 2, op: 'create', components: { Position: { x: 100, y: 0 } } },
    { seq: 3, op: 'set', handle: { slot: 1, generation: 1 }, component: 'Position', value: { x: 200, y: 0 } },
  ]);
  const snap = w.save();
  eq(snap.externalPending.length, 2, 'pending kept');
  eq(snap.tick, 2, 'clock kept');
  const before = w.digest();

  const ref = new World();
  ref.enqueueExternal([{ seq: 1, op: 'create', components: {
    Position: { x: 0, y: 0 }, Velocity: { x: 2, y: 0 }, Health: { value: 3 }, Poison: { amount: 4 },
    Spawner: { period: 5, vx: 0, vy: 0 },
  } }]);
  ref.step(); ref.step();
  ref.enqueueExternal([
    { seq: 2, op: 'create', components: { Position: { x: 100, y: 0 } } },
    { seq: 3, op: 'set', handle: { slot: 1, generation: 1 }, component: 'Position', value: { x: 200, y: 0 } },
  ]);

  const resumed = World.fromSnapshot(JSON.parse(JSON.stringify(snap)));
  eq(resumed.digest(), before, 'resume identical before continuing');
  for (let i = 0; i < 8; i++) { ref.step(); resumed.step(); }
  eq(resumed.digest(), ref.digest(), 'resume identical after 8 ticks');
  eq(resumed.events.map((e) => e.type + ':' + e.i), ref.events.map((e) => e.type + ':' + e.i), 'event trace identical');
});

check('free slot generation survives save/restore', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: {} },
    { seq: 2, op: 'create', components: {} },
    { seq: 3, op: 'destroy', handle: { slot: 0, generation: 1 } },
    { seq: 4, op: 'destroy', handle: { slot: 0, generation: 2 } }, // invalid, keeps gen 2
  ]);
  w.step();
  const r = World.fromSnapshot(JSON.parse(JSON.stringify(w.save())));
  eq(r.slotView()[0].generation, 2, 'generation kept');
  eq(r.stats().nextHandleSlot, 0, 'smallest free slot kept');
  eq(r.entityView({ slot: 0, generation: 1 }).error, '过期句柄');
  eq(r.entityView({ slot: 0, generation: 2 }).error, '实体为空');
  r.enqueueExternal([{ seq: 5, op: 'create', components: {} }]);
  r.step();
  eq(r.stats().nextHandleSlot, 2, 'extended after free slot used');
});

check('snapshot is canonical enough to survive JSON round-trip byte-identically', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 1, op: 'create', components: { Position: { x: -1, y: 2 }, Spawner: { period: 2, vx: 1, vy: -1 } } },
    { seq: 2, op: 'create', components: { Health: { value: 2 }, Poison: { amount: 1 } } },
  ]);
  w.step(); w.step();
  const a = JSON.stringify(w.save());
  const b = JSON.stringify(World.fromSnapshot(JSON.parse(a)).save());
  eq(b, a, 'save(restore(save)) is stable');
});

check('restored world keeps external seq history, so old seqs are still rejected', () => {
  const w = new World();
  w.enqueueExternal([
    { seq: 40, op: 'create', components: {} },
    { seq: 20, op: 'set', handle: { slot: 0, generation: 1 }, component: 'Position', value: { x: 0, y: 0 } },
  ]);
  w.step();
  const r = World.fromSnapshot(JSON.parse(JSON.stringify(w.save())));
  eq(r.applyExternalCommand({ seq: 40, op: 'create', components: {} }).ok, false, 'duplicate rejected');
  eq(r.applyExternalCommand({ seq: 20, op: 'create', components: {} }).ok, false, 'used seq rejected');
  eq(r.applyExternalCommand({ seq: 41, op: 'create', components: {} }).ok, true, 'new seq accepted');
});

check('restored world keeps internal command counter, so iseq continues', () => {
  const w = new World();
  w.enqueueExternal([{ seq: 1, op: 'create', components: {
    Position: { x: 0, y: 0 }, Spawner: { period: 1, vx: 0, vy: 0 },
  } }]);
  w.step();
  const snap = w.save();
  const savedEvents = snap.events.length;
  const r = World.fromSnapshot(JSON.parse(JSON.stringify(snap)));
  r.step();
  const iseqs = r.events.slice(savedEvents).filter((e) => e.type === 'syscmd').map((e) => e.iseq);
  eq(iseqs, [1], 'internal counter continued past snapshot');
  eq(r.stats().internalCounter, 2);
});

console.log('\n----------------------------------------');
if (failures.length) {
  console.log(failures.length + ' failure(s), ' + pass + ' passed');
  process.exit(1);
}
console.log(pass + ' passed');
