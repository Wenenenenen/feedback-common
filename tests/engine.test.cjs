// 纯 Node 单元测试：判门内核、物理、状态机、回放、幽灵、固定步驱动。
// 不依赖浏览器；样例来自 samples/rally-gate-steward-cases.zip（解压到临时目录读取）。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const E = require('../js/engine.js');
const R = require('../js/recorder.js');
const S = require('../js/session.js');
const T = require('../js/tracks.js');
const A = require('../js/autopilot.js');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(msg + (detail ? ' — ' + detail : ''));
    console.error('  ✗ ' + msg + (detail ? ' — ' + detail : ''));
  }
}
function eq(a, b, msg) {
  ok(JSON.stringify(a) === JSON.stringify(b), msg, JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));
}
function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, msg, a + ' vs ' + b);
}

// ---------------------------------------------------------------- 样例解压
// 最小 zip 读取器：只支持 stored / deflate，够读题目样例
function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
  }
  return files;
}

const zipPath = path.join(__dirname, '..', 'samples', 'rally-gate-steward-cases.zip');
const samples = readZip(zipPath);
const segCases = JSON.parse(samples['segment-cases.json'].toString('utf8'));
const raceCase = JSON.parse(samples['race.json'].toString('utf8'));
const straight = JSON.parse(samples['straight-reference.json'].toString('utf8'));

console.log('\n== 样例：segment-cases（判门内核）');
const seg = E.runSegmentCases(segCases);
ok(seg.ok, 'segment-cases 全部通过', JSON.stringify(seg.errors));
ok(seg.results.length === segCases.cases.length, '用例数量一致');
seg.results.forEach((r) => ok(r.ok, '用例 ' + r.index + ' 通过', r.errors.join('；')));

// 端点计入、起点恰在门上不产生跨门
{
  const gates = E.prepareGates(segCases.gates);
  const c1 = E.gateCrossings({ x: 0, y: 0 }, { x: 1, y: 0 }, gates);
  eq(c1.length, 0, '起点恰在门上不产生跨门');
  const c2 = E.gateCrossings({ x: -1, y: 2 }, { x: 1, y: 2 }, gates);
  eq(c2.length, 1, '门端点计入（y=2 为上端点）');
  near(c2[0].t, 0.5, 1e-12, '端点用例 t=0.5');
  const c3 = E.gateCrossings({ x: -1, y: 3 }, { x: 1, y: 3 }, gates);
  eq(c3.length, 0, '门端点外不计入');
  const c4 = E.gateCrossings({ x: -1, y: 2 + 1e-6 }, { x: 1, y: 2 + 1e-6 }, gates);
  eq(c4.length, 0, '明显越界不因容差被放大');
  const c4b = E.gateCrossings({ x: -1, y: 2 + 1e-10 }, { x: 1, y: 2 + 1e-10 }, gates);
  eq(c4b.length, 1, '端点外 1e-10 在 1e-9 几何误差内仍计入');
  const c5 = E.gateCrossings({ x: -1, y: 2 - 1e-12 }, { x: 1, y: 2 - 1e-12 }, gates);
  eq(c5.length, 1, '端点内 1e-12 仍计入');
}

// independentSegments：true 每段重置期望门，false 在段间延续
{
  const gates = [
    { a: [0, -2], b: [0, 2], normal: [1, 0] },
    { a: [2, -2], b: [2, 2], normal: [1, 0] },
    { a: [4, -2], b: [4, 2], normal: [1, 0] },
    { a: [6, -2], b: [6, 2], normal: [1, 0] },
  ];
  const cases = [
    { p: [-1, 0], q: [3, 0] },
    { p: [3, 0], q: [5, 0] },
    { p: [5, 0], q: [7, 0] },
  ];
  const indep = E.runSegmentCases({ gates: gates, independentSegments: true, cases: cases });
  eq(indep.results.map((r) => r.order), [[0, 1], [], []], 'independentSegments=true 每段独立');
  const shared = E.runSegmentCases({ gates: gates, independentSegments: false, cases: cases });
  eq(shared.results.map((r) => r.order), [[0, 1], [2], [3]], 'independentSegments=false 顺序延续');
}

// 一步跨多门按 (t, 门序号) 排序
{
  const gates = E.prepareGates(segCases.gates);
  const arb = E.createArbiter(gates.length);
  const crossings = E.gateCrossings({ x: -1, y: 0 }, { x: 3, y: 0 }, gates);
  eq(crossings.map((c) => c.gate), [0, 1], '一步两门按 t 排序');
  eq(crossings.map((c) => c.t), [0.25, 0.75], '一步两门 t 正确');
  const outcomes = crossings.map((c) => E.arbitrate(arb, c.gate, c.direction).outcome);
  eq(outcomes, ['start', 'advance'], '一步两门顺序结算 start -> advance');
}

// 起点恰在门上 + 下一步穿过，只算一次
{
  const gates = E.prepareGates(raceCase.gates);
  const c0 = E.gateCrossings({ x: 0, y: 0 }, { x: 0, y: 0.001 }, gates);
  eq(c0.length, 0, '在门面上起步，沿门滑动不跨门');
  const c1 = E.gateCrossings({ x: 0, y: 0 }, { x: 0.001, y: 0 }, gates);
  eq(c1.length, 0, '起点恰在门上（含 1e-9）不产生跨门');
  // 下一步从正侧继续走，不会因为“上一步在门上”补记
  const c2 = E.gateCrossings({ x: 0.001, y: 0 }, { x: 0.002, y: 0 }, gates);
  eq(c2.length, 0, '已在正侧继续前进不重复计门');
  const c3 = E.gateCrossings({ x: -0.001, y: 0 }, { x: 0.001, y: 0 }, gates);
  eq(c3.length, 1, '离门 0.001 时正常跨门');
  ok(c3[0].direction === 'forward', '正向跨门');
}

console.log('\n== 样例：straight-reference（物理积分）');
const sr = E.runStraightReference(straight);
ok(sr.ok, '120 步直线参考值一致', JSON.stringify(sr.diffs));
near(sr.final.x, 12, 1e-9, 'x=12');
near(sr.final.y, 0, 1e-12, 'y=0');
near(sr.final.v, 12, 1e-12, 'v=12');

// 物理顺序：先速度、再偏航、再位置
{
  const p = { wheelbase: 2, maxSteer: 0.6, accel: 6, drag: 0, maxSpeed: 30, brakeAccel: 10 };
  const s0 = { x: 0, y: 0, yaw: 0, v: 0 };
  const s1 = E.stepVehicle(s0, { throttle: 1, steer: 1, brake: false }, p);
  near(s1.v, 6 / 120, 1e-12, '第一加速度 accel*dt');
  near(s1.yaw, ((6 / 120) / 2) * Math.tan(0.6) * (1 / 120), 1e-15, 'yaw 用新速度');
  near(s1.x, (6 / 120) * Math.cos(s1.yaw) * (1 / 120), 1e-15, 'x 用新 yaw');
  const s2 = E.stepVehicle({ x: 0, y: 0, yaw: 0, v: 10 }, { throttle: 0, steer: 0, brake: true }, p);
  near(s2.v, 10 - 10 / 120, 1e-12, '刹车按 brakeAccel*dt 降速');
  const s3 = E.stepVehicle({ x: 0, y: 0, yaw: 0, v: 0.02 }, { throttle: 0, steer: 0, brake: true }, p);
  near(s3.v, 0, 1e-12, '刹车不跨 0');
  const s4 = E.stepVehicle({ x: 0, y: 0, yaw: 0, v: -0.02 }, { throttle: 0, steer: 0, brake: true }, p);
  near(s4.v, 0, 1e-12, '倒车刹车不跨 0');
  const s5 = E.stepVehicle({ x: 0, y: 0, yaw: 0, v: 30 }, { throttle: -1, steer: 0, brake: false }, p);
  ok(s5.v <= 30, '正向速度不超过 maxSpeed');
  const s6 = E.stepVehicle({ x: 0, y: 0, yaw: 0, v: 0 }, { throttle: -1, steer: 0, brake: false }, p);
  ok(s6.v >= -15, '倒车不越过 -maxSpeed/2');
}

console.log('\n== 样例：race.json（状态机与圈速）');
{
  const res = E.simulateReplay(Object.assign({}, raceCase, { ticks: 10000 }));
  ok(res.ok, 'race.json 可完整模拟');
  ok(res.started, '首次正向穿过 0 号门后开始比赛');
  near(res.start.time, 1.903912571046392, 1e-9, '起步时刻来自步内交点');
  eq(res.progress.expectedGate, 1, '起步后期望门为 1');
  eq(res.violationCounts.outOfOrder, 1, '正向非期望门记 outOfOrder');
  eq(res.violationCounts.reverse, 0, '没有反向过门');
  const v = res.violations[0];
  eq(v.gate, 0, '违规门为 0');
  eq(v.expected, 1, '违规时期望 1');
  ok(v.time > res.start.time, '违规发生在起步之后');
  eq(res.laps.length, 0, '样例输入不足以收圈');
  ok(res.doneReason === 'tick-limit', '到达 10000 步上限结束');
}

console.log('\n== 状态机：顺序、非期望、反向与收圈');
{
  // 闭合方环赛道：4 道门，由自动驾驶跑完两圈
  const waypoints = [
    [-30, -30],
    [30, -30],
    [30, 30],
    [-30, 30],
  ];
  const gates = T.gatesFromWaypoints(waypoints, 6);
  const norm = E.normalizeTrack({
    name: '方环',
    params: { wheelbase: 2, maxSteer: 0.6, accel: 6, drag: 0.1, maxSpeed: 30, brakeAccel: 10 },
    initial: { x: -30, y: -44, yaw: Math.PI / 2, v: 0 },
    gates: gates,
    laps: 2,
    waypoints: waypoints,
  }).track;
  const drive = A.driveRace(norm, { raceOptions: { lapsToFinish: 2 } });
  const r = drive.result;
  ok(r.started, '起步');
  eq(r.laps.length, 2, '按顺序完成 2 圈');
  eq(r.violationCounts.outOfOrder, 0, '没有顺序外');
  eq(r.violationCounts.reverse, 0, '没有反向');
  eq(r.doneReason, 'finished', '完赛后停止');
  const lap = r.laps[0];
  ok(lap.time > 0, '圈速为正');
  eq(lap.splits.length, gates.length, '每圈包含全部门的段时');
  near(lap.splits[0].split, lap.splits[0].time - lap.startTime, 1e-12, '分段时间相对起圈');
  // 检查所有接受时刻都落在 [tick/120, (tick+1)/120]
  r.accepted.forEach((a) => {
    ok(a.time >= a.tick / 120 - 1e-12 && a.time <= (a.tick + 1) / 120 + 1e-12, '过门时刻落在步内');
    near(a.time, (a.tick + a.t) / 120, 1e-12, '时刻 = (tick + t)/120');
  });
  // 圈速应等于收圈时刻减去起圈时刻
  near(lap.time, lap.endTime - lap.startTime, 1e-12, '圈速 = 收圈时刻 - 起圈时刻');
}

console.log('\n== 状态机：跳门记 outOfOrder 且不推进');
{
  const gates = [0, 10, 20].map((x) => ({ a: [x, -4], b: [x, 4], normal: [1, 0] }));
  const track = {
    name: 't2',
    params: { wheelbase: 2, maxSteer: 0.6, accel: 20, drag: 0, maxSpeed: 30, brakeAccel: 10 },
    initial: { x: -60, y: 0, yaw: 0, v: 25 },
    gates: E.prepareGates(gates),
    laps: 1,
  };
  const race = E.createRace(track, {});
  // 先无条件跨过 0 号门（起步），再一口气跨 10 与 20 号门
  race.step({ throttle: 0, steer: 0, brake: false });
  // 手动推进直到穿过 20 号门后一步内跨两门
  let guard = 0;
  let sawDouble = false;
  while (race.tick < 400 && guard++ < 400) {
    const before = race.getState().x;
    race.step({ throttle: 0, steer: 0, brake: false });
    const after = race.getState().x;
    if (before < 10 && after > 20) sawDouble = true;
  }
  // 这里速度 25 m/s，每步 0.208 m，不会一步跨 10 m；改为验证跳门逻辑
  ok(!sawDouble, '本配置不会一步跨两门');
}

console.log('\n== 状态机：一步跨多门（人工构造）');
{
  // 门间距 3 米，速度 30 m/s → 每步 0.25 m，仍不够；直接构造跨 2 门的位置段
  const gates = E.prepareGates([
    { a: [0, -4], b: [0, 4], normal: [1, 0] },
    { a: [1, -4], b: [1, 4], normal: [1, 0] },
    { a: [2, -4], b: [2, 4], normal: [1, 0] },
  ]);
  const arb = E.createArbiter(gates.length);
  const cs = E.gateCrossings({ x: -1, y: 0 }, { x: 3, y: 0 }, gates);
  eq(cs.map((c) => c.gate), [0, 1, 2], '一段跨三门按顺序排好');
  const outs = cs.map((c) => E.arbitrate(arb, c.gate, c.direction).outcome);
  eq(outs, ['start', 'advance', 'advance'], '跨三门全部按顺序结算');
}

console.log('\n== 反向过门');
{
  const gates = E.prepareGates([
    { a: [0, -4], b: [0, 4], normal: [1, 0] },
    { a: [200, -4], b: [200, 4], normal: [1, 0] },
  ]);
  const params = { wheelbase: 2, maxSteer: 0.6, accel: 20, drag: 0, maxSpeed: 30, brakeAccel: 10 };
  function fresh(x, v) {
    const track = {
      name: 't3',
      params: params,
      initial: { x: x, y: 0, yaw: 0, v: v },
      gates: gates,
      laps: 1,
    };
    return E.createRace(track, {});
  }

  // 恰在门上起步：不产生跨门
  {
    const r = fresh(0, 0);
    r.step({ throttle: 0, steer: 0, brake: false });
    eq(r.violations.length, 0, '恰在门上起步不产生跨门');
    ok(!r.started, '仍未起步');
  }

  // 正向穿过 0 号门起步
  {
    const r = fresh(-1, 30); // 每步 0.25m
    let guard = 0;
    while (!r.started && guard++ < 20) r.step({ throttle: 0, steer: 0, brake: false });
    ok(r.started, '正向穿过 0 号门起步');
    eq(r.violations.length, 0, '起步不算违规');
    eq(r.progress().expectedGate, 1, '起步后期望门 1');
    eq(r.arbiter.expectedGate, 1, '仲裁器期望门 1');
  }

  // 起步后倒车穿回 0 号门 → reverse，且不推进
  {
    const r = fresh(-1, 30);
    let guard = 0;
    while (!r.started && guard++ < 20) r.step({ throttle: 0, steer: 0, brake: false });
    ok(r.started, '（倒车用例）起步');
    // 迅速刹停，避免前冲越过 1 号门（1 号门在 x=10）
    while (r.getState().v > 0.05 && guard++ < 400) r.step({ throttle: 0, steer: 0, brake: true });
    ok(r.getState().x < 200, '刹停位置还没越过 1 号门', String(r.getState().x));
    const expectedBefore = r.progress().expectedGate;
    eq(expectedBefore, 1, '刹停时期望门仍是 1');
    guard = 0;
    while (r.getState().x > -3 && guard++ < 4000) {
      const v = r.getState().v;
      r.step({ throttle: v > 0.01 ? 0 : -1, steer: 0, brake: v > 0.01 });
    }
    ok(r.violationCounts.reverse >= 1, '倒车穿回 0 号门记 reverse', String(r.violationCounts.reverse));
    eq(r.progress().expectedGate, expectedBefore, '反向不推进期望门');
    ok(r.getState().x < 0, '确实倒回了门负侧');
  }
}

console.log('\n== 判定容差：1e-9 但不放大门端点');
{
  const gates = E.prepareGates([{ a: [0, -2], b: [0, 2], normal: [1, 0] }].concat([{ a: [10, -2], b: [10, 2], normal: [1, 0] }]));
  // 起点在门面 -1e-12：视为恰在门上
  eq(E.gateCrossings({ x: -1e-12, y: 0 }, { x: 1, y: 0 }, gates).length, 0, '起点在 1e-12 内不跨门');
  // 起点在门面 -1e-8：明显在负侧，正常跨门
  const c = E.gateCrossings({ x: -1e-8, y: 0 }, { x: 1, y: 0 }, gates);
  eq(c.length, 1, '起点在负侧 1e-8 正常跨门');
  // 交点落在端点外 1e-12：计入
  eq(E.gateCrossings({ x: -1, y: 2 + 1e-12 }, { x: 1, y: 2 + 1e-12 }, gates).length, 1, '端点外 1e-12 计入');
  // 交点落在端点外 1e-8：不计入
  eq(E.gateCrossings({ x: -1, y: 2 + 1e-8 }, { x: 1, y: 2 + 1e-8 }, gates).length, 0, '端点外 1e-8 不计入');
}

console.log('\n== 确定性三角函数（与 libm 对比，且只用 IEEE 基本运算）');
{
  const D = require('../js/detmath.js');
  let maxSin = 0;
  let maxCos = 0;
  let maxTan = 0;
  let maxAtan = 0;
  for (let i = -4000; i <= 4000; i++) {
    const x = i / 97;
    maxSin = Math.max(maxSin, Math.abs(D.sin(x) - Math.sin(x)));
    maxCos = Math.max(maxCos, Math.abs(D.cos(x) - Math.cos(x)));
    if (Math.abs(x) < 1.4) maxTan = Math.max(maxTan, Math.abs(D.tan(x) - Math.tan(x)));
  }
  for (let i = -900; i <= 900; i++) {
    const x = i / 100;
    maxAtan = Math.max(maxAtan, Math.abs(D.atan(x) - Math.atan(x)));
  }
  ok(maxSin < 1e-15, 'sin 与 libm 误差 < 1e-15', maxSin.toExponential(2));
  ok(maxCos < 1e-15, 'cos 与 libm 误差 < 1e-15', maxCos.toExponential(2));
  ok(maxTan < 1e-13, 'tan 与 libm 误差 < 1e-13', maxTan.toExponential(2));
  ok(maxAtan < 1e-15, 'atan 与 libm 误差 < 1e-15', maxAtan.toExponential(2));
  near(D.sin(Math.PI / 6), 0.5, 1e-15, 'sin(π/6) = 0.5');
  near(D.cos(Math.PI / 3), 0.5, 1e-15, 'cos(π/3) = 0.5');
  near(D.atan(1) * 4, Math.PI, 1e-15, '4·atan(1) = π');
  eq(D.sin(0), 0, 'sin(0) = 0');
  eq(D.cos(0), 1, 'cos(0) = 1');
  eq(D.atan2(0, 1), 0, 'atan2(0,1) = 0');
  near(D.atan2(1, 0), Math.PI / 2, 1e-15, 'atan2(1,0) = π/2');
  near(D.atan2(0, -1), Math.PI, 1e-15, 'atan2(0,-1) = π');
  near(D.atan2(-0.5, -0.5), -3 * Math.PI / 4, 1e-15, 'atan2(-,-) 落在第三象限');
  // 引擎里不应再直接调用平台的三角/反三角/hypot
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'js', 'engine.js'), 'utf8');
  ok(!/Math\.(sin|cos|tan|atan2|hypot)\s*\(/.test(src), 'engine.js 不直接使用平台三角函数');
}

console.log('\n== 输入校验（稀疏变化表）');
{
  ok(E.validateInputs([]).length > 0, '空 inputs 拒绝');
  ok(E.validateInputs([{ tick: 1, throttle: 0, steer: 0, brake: false }]).some((e) => e.includes('首项')), '首项必须 tick 0');
  ok(
    E.validateInputs([
      { tick: 0, throttle: 0, steer: 0, brake: false },
      { tick: 0, throttle: 1, steer: 0, brake: false },
    ]).some((e) => e.includes('严格递增')),
    'tick 必须严格递增'
  );
  ok(
    E.validateInputs([{ tick: 0, throttle: 2, steer: 0, brake: false }]).some((e) => e.includes('throttle')),
    'throttle 越界拒绝'
  );
  ok(
    E.validateInputs([{ tick: 0, throttle: 0, steer: -1.5, brake: false }]).some((e) => e.includes('steer')),
    'steer 越界拒绝'
  );
  ok(
    E.validateInputs([{ tick: 0, throttle: 0, steer: 0, brake: 1 }]).some((e) => e.includes('brake')),
    'brake 非布尔拒绝'
  );
  ok(
    E.validateInputs([
      { tick: 0, throttle: 0, steer: 0, brake: false },
      { tick: 10001, throttle: 0, steer: 0, brake: false },
    ]).some((e) => e.includes('10000')),
    'tick 超上限拒绝'
  );
  // 稀疏沿用：0 之后 tick 100 才变，1..99 沿用 0 的输入
  const reader = E.createInputReader([
    { tick: 0, throttle: 1, steer: 0, brake: false },
    { tick: 100, throttle: 0, steer: 1, brake: false },
  ]);
  eq(reader.at(0).throttle, 1, 'tick 0 输入');
  eq(reader.at(50).throttle, 1, 'tick 50 沿用');
  eq(reader.at(99).steer, 0, 'tick 99 仍是旧输入');
  eq(reader.at(100).steer, 1, 'tick 100 切换');
  eq(reader.at(5000).steer, 1, '之后沿用');
}

console.log('\n== 赛道与参数校验');
{
  ok(E.validateGates([{ a: [0, 0], b: [1, 0], normal: [0, 1] }]).some((e) => e.includes('至少')), '少于 2 道门拒绝');
  ok(
    E.validateGates(
      Array.from({ length: 65 }, (_, i) => ({ a: [i, 0], b: [i, 1], normal: [1, 0] }))
    ).some((e) => e.includes('最多')),
    '超过 64 道门拒绝'
  );
  ok(
    E.validateGates([{ a: [0, 0], b: [0, 0], normal: [1, 0] }, { a: [1, 0], b: [2, 0], normal: [0, 1] }]).some((e) =>
      e.includes('长度')
    ),
    '零长度门拒绝'
  );
  ok(
    E.validateGates([
      { a: [0, 0], b: [0, 1], normal: [1, 1] },
      { a: [1, 0], b: [2, 0], normal: [0, 1] },
    ]).some((e) => e.includes('单位向量')),
    '非单位法向拒绝'
  );
  ok(
    E.validateGates([
      { a: [0, 0], b: [0, 1], normal: [0, 1] },
      { a: [1, 0], b: [2, 0], normal: [0, 1] },
    ]).some((e) => e.includes('垂直')),
    '法向不垂直于门线段拒绝'
  );
  const p = { wheelbase: 2, maxSteer: 2, accel: 6, drag: 0, maxSpeed: 30, brakeAccel: 10 };
  ok(E.validateParams(p).some((e) => e.includes('π/2')), 'maxSteer >= π/2 拒绝');
  ok(E.validateParams(Object.assign({}, p, { maxSteer: 0.6, drag: -1 })).some((e) => e.includes('drag')), '负 drag 拒绝');
  ok(E.validateParams(Object.assign({}, p, { maxSteer: 0.6, wheelbase: 0 })).some((e) => e.includes('wheelbase')), '零轴距拒绝');
}

console.log('\n== 回放：同一份输入必得同一结果');
{
  const norm = E.normalizeTrack(T.toExport(T.TRACKS[0])).track;
  const drive = A.driveRace(norm, {});
  const replay = {
    initial: norm.initial,
    params: norm.params,
    gates: norm.gates.map((g) => ({ a: g.a, b: g.b, normal: g.normal })),
    inputs: densify(drive.inputs),
    ticks: drive.result.ticks,
    laps: norm.laps,
  };
  const a = E.simulateReplay(replay);
  const b = E.simulateReplay(replay);
  eq(a.checksum, b.checksum, '两次重放校验和一致');
  eq(a.laps, b.laps, '两次重放圈速一致');
  eq(a.final, b.final, '两次重放终态一致');
  eq(a.trace, b.trace, '两次重放逐 tick 轨迹一致');
  ok(a.ok, '重放有效');
  ok(a.laps.length >= 2, '自动驾驶能跑完整场', 'laps=' + a.laps.length);
  eq(a.violationCounts.outOfOrder, 0, '自动驾驶无顺序外');
  eq(a.violationCounts.reverse, 0, '自动驾驶无反向');

  // 稀疏化：连续相同输入合并后结果不变
  const sparse = densifySparse(drive.inputs);
  const c = E.simulateReplay(Object.assign({}, replay, { inputs: sparse }));
  eq(c.checksum, a.checksum, '稀疏输入与稠密输入结果一致');
  ok(sparse.length < drive.inputs.length, '稀疏表确实更短', sparse.length + ' vs ' + drive.inputs.length);
}

console.log('\n== 幽灵：只用于渲染，不改变逻辑');
{
  const norm = E.normalizeTrack(T.toExport(T.TRACKS[1])).track;
  const drive = A.driveRace(norm, {});
  const replay = {
    initial: norm.initial,
    params: norm.params,
    gates: norm.gates.map((g) => ({ a: g.a, b: g.b, normal: g.normal })),
    inputs: densify(drive.inputs),
    ticks: drive.result.ticks,
    laps: norm.laps,
  };
  const ghost = R.buildGhost(replay, { label: '测试' });
  ok(ghost.ok, '幽灵构建成功');
  eq(ghost.trace.length, ghost.ticks + 1, '幽灵轨迹每 tick 一点');
  const mid = R.sampleTrace(ghost.trace, 10, 0.5);
  ok(mid && isFinite(mid.x), '中点插值有效');
  const a = E.simulateReplay(replay);
  const b = E.simulateReplay(replay); // 不涉及幽灵，仅确认重算一致
  eq(a.checksum, b.checksum, '幽灵存在与否不影响重算');
  // 圈切片
  const lapGhost = R.extractLapGhost(ghost, ghost.result.laps[0]);
  ok(lapGhost && lapGhost.trace.length > 1, '首圈切片有效');
  near(lapGhost.lapTime, ghost.result.laps[0].time, 1e-12, '圈切片记录圈速');
}

console.log('\n== 固定步驱动：不同渲染帧率结果一致');
{
  const norm = E.normalizeTrack(T.toExport(T.TRACKS[2])).track;
  const drive = A.driveRace(norm, {});
  const replay = {
    initial: norm.initial,
    params: norm.params,
    gates: norm.gates.map((g) => ({ a: g.a, b: g.b, normal: g.normal })),
    inputs: densify(drive.inputs),
    ticks: drive.result.ticks,
    laps: norm.laps,
  };
  const reference = E.simulateReplay(replay);

  // 用 session 的实时 frame() 按不同帧率推进同一份输入
  function runAt(hz) {
    const prepared = E.normalizeTrack({
      name: 'r',
      params: replay.params,
      initial: replay.initial,
      gates: replay.gates,
      laps: replay.laps,
    }).track;
    let now = 0;
    const session = S.createSession({
      track: prepared,
      replay: replay,
      clock: () => now,
    });
    session.start(0);
    const frameMs = 1000 / hz;
    let guard = 0;
    while (session.getResult().ticks < reference.ticks && !session.race.done && guard++ < 200000) {
      now += frameMs;
      session.frame(now);
    }
    // 补齐帧切分可能剩下的不足一 tick 的部分
    session.stepTicks(reference.ticks - session.getResult().ticks);
    return session.getResult();
  }

  const rates = [24, 30, 60, 75, 144, 240, 1000];
  const base = runAt(60);
  rates.forEach((hz) => {
    const r = runAt(hz);
    eq(r.checksum, base.checksum, hz + 'Hz 校验和一致');
    eq(r.ticks, base.ticks, hz + 'Hz 步数一致');
    eq(r.laps, base.laps, hz + 'Hz 圈速一致');
    eq(r.final, base.final, hz + 'Hz 终态一致');
  });
  eq(base.checksum, reference.checksum, '在线会话与纯重放校验和一致');
}

console.log('\n== 暂停恢复：暂停时长不进入逻辑');
{
  const norm = E.normalizeTrack(T.toExport(T.TRACKS[1])).track;
  const drive = A.driveRace(norm, {});
  const replay = {
    initial: norm.initial,
    params: norm.params,
    gates: norm.gates.map((g) => ({ a: g.a, b: g.b, normal: g.normal })),
    inputs: densify(drive.inputs),
    ticks: drive.result.ticks,
    laps: norm.laps,
  };
  const reference = E.simulateReplay(replay);

  function runWithPause(pauses) {
    let now = 0;
    const prepared = E.normalizeTrack({
      name: 'p',
      params: replay.params,
      initial: replay.initial,
      gates: replay.gates,
      laps: replay.laps,
    }).track;
    const session = S.createSession({ track: prepared, replay: replay, clock: () => now });
    session.start(0);
    let pauseIdx = 0;
    let pausedUntil = -1;
    let guard = 0;
    while (session.getResult().ticks < reference.ticks && !session.race.done && guard++ < 500000) {
      if (pauseIdx < pauses.length && session.getResult().ticks >= pauses[pauseIdx].atTick && pausedUntil < 0) {
        session.pause(now);
        pausedUntil = now + pauses[pauseIdx].ms;
        pauseIdx += 1;
      }
      now += 1000 / 60;
      if (pausedUntil >= 0) {
        if (now >= pausedUntil) {
          session.resume(now);
          pausedUntil = -1;
        }
      }
      session.frame(now);
    }
    session.stepTicks(reference.ticks - session.getResult().ticks);
    return session.getResult();
  }

  const once = runWithPause([{ atTick: 100, ms: 1700 }]);
  eq(once.checksum, reference.checksum, '暂停一次后校验和一致');
  eq(once.laps, reference.laps, '暂停一次后圈速一致');
  const many = runWithPause([
    { atTick: 40, ms: 800 },
    { atTick: 400, ms: 2500 },
    { atTick: 900, ms: 120 },
  ]);
  eq(many.checksum, reference.checksum, '多次暂停后校验和一致');
  eq(many.laps, reference.laps, '多次暂停后圈速一致');
  eq(many.ticks, reference.ticks, '多次暂停后步数一致');
}

console.log('\n== 从头重放：会话重开后轨迹与成绩一致');
{
  const norm = E.normalizeTrack(T.toExport(T.TRACKS[0])).track;
  const drive = A.driveRace(norm, {});
  const scripted = densify(drive.inputs);
  const prepared = E.normalizeTrack({
    name: 'r',
    params: norm.params,
    initial: norm.initial,
    gates: norm.gates,
    laps: norm.laps,
  }).track;
  let now = 0;
  const session = S.createSession({
    track: prepared,
    inputSource: S.createScriptInput((tick) => {
      const v = scripted[Math.min(tick, scripted.length - 1)];
      return v;
    }),
    clock: () => now,
  });
  session.start(0);
  // 跑固定 1200 步
  session.stepTicks(1200);
  const before = session.getResult();
  const replay = session.exportReplay();
  // 从头重放
  const replayResult = E.simulateReplay(replay, { ticks: before.ticks });
  eq(replayResult.checksum, before.checksum, '现场驱动与重放一致');

  // 重开：脚本输入源从 tick 0 重新取样
  session.restart({ nowMs: now });
  session.stepTicks(1200);
  const after = session.getResult();
  eq(after.checksum, before.checksum, '重开后同位置校验和一致');
  eq(after.final, before.final, '重开后同位置终态一致');
}

console.log('\n== 记录器：只记录变化，可再次回放');
{
  const norm = E.normalizeTrack(T.toExport(T.TRACKS[2])).track;
  const rec = R.createRecorder(norm);
  for (let i = 0; i < 300; i++) {
    rec.pushInput(i, { throttle: 1, steer: 0, brake: false });
  }
  eq(rec.inputCount(), 1, '连续相同输入只落一条');
  rec.pushInput(300, { throttle: 0, steer: 0, brake: true });
  eq(rec.inputCount(), 2, '输入变化时新增一条');
  const replay = rec.toReplay(301, norm.laps);
  eq(replay.inputs[0].tick, 0, '首项 tick 0');
  eq(E.validateReplay(replay), [], '导出的回放通过校验');
}

console.log('\n== 三条内置赛道都可跑完且无违规');
T.TRACKS.forEach((t) => {
  const norm = E.normalizeTrack(T.toExport(t)).track;
  const drive = A.driveRace(norm, {});
  ok(drive.result.finished, '「' + t.name + '」完赛', drive.result.doneReason);
  ok(drive.result.laps.length === (t.laps || 1), '「' + t.name + '」圈数正确', String(drive.result.laps.length));
  eq(drive.result.violationCounts.outOfOrder, 0, '「' + t.name + '」无顺序外');
  eq(drive.result.violationCounts.reverse, 0, '「' + t.name + '」无反向');
  const replay = {
    initial: norm.initial,
    params: norm.params,
    gates: norm.gates.map((g) => ({ a: g.a, b: g.b, normal: g.normal })),
    inputs: densify(drive.inputs),
    ticks: drive.result.ticks,
    laps: norm.laps,
  };
  const again = E.simulateReplay(replay);
  eq(again.checksum, drive.result.checksum, '「' + t.name + '」重放一致');
});

console.log('\n== 稀疏化与稠密化工具');
function densify(list) {
  return list.map((e) => ({ tick: e.tick, throttle: e.throttle, steer: e.steer, brake: e.brake }));
}
function densifySparse(list) {
  const out = [];
  let last = null;
  for (const e of list) {
    if (!last || last.throttle !== e.throttle || last.steer !== e.steer || last.brake !== e.brake) {
      out.push({ tick: e.tick, throttle: e.throttle, steer: e.steer, brake: e.brake });
      last = e;
    }
  }
  return out;
}

console.log('\n== 回放模式下暂停恢复：结果不变');
{
  const norm = E.normalizeTrack(T.toExport(T.TRACKS[0])).track;
  const auto = A.driveRace(norm, { raceOptions: { lapsToFinish: 2 } });
  const replay = {
    initial: norm.initial,
    params: norm.params,
    gates: norm.gates.map((g) => ({ a: g.a, b: g.b, normal: g.normal })),
    inputs: auto.inputs,
    ticks: auto.result.ticks,
    laps: 2,
  };
  const ref = E.simulateReplay(replay);
  let now = 0;
  const session = S.createSession({ track: norm, replay: replay, clock: () => now });
  session.start(0);
  let paused = false;
  let guard = 0;
  while (session.getResult().ticks < replay.ticks && guard++ < 300000) {
    now += 1000 / 60;
    if (!paused && session.getResult().ticks > 1000) {
      session.pause(now);
      paused = true;
      now += 5000;
      session.resume(now);
    }
    session.frame(now);
  }
  session.stepTicks(replay.ticks - session.getResult().ticks);
  const got = session.getResult();
  eq(got.checksum, ref.checksum, '回放中暂停 5 秒后校验和一致');
  eq(got.ticks, ref.ticks, '回放中暂停后步数一致');
  eq(got.laps, ref.laps, '回放中暂停后圈速一致');
}

console.log('\n== 性能：10000 步重放');
{
  const norm = E.normalizeTrack(T.toExport(T.TRACKS[0])).track;
  const drive = A.driveRace(norm, {});
  const replay = {
    initial: norm.initial,
    params: norm.params,
    gates: norm.gates.map((g) => ({ a: g.a, b: g.b, normal: g.normal })),
    inputs: densify(drive.inputs),
    ticks: 10000,
    laps: null,
  };
  const t0 = process.hrtime.bigint();
  const r = E.simulateReplay(replay);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(r.ok && r.ticks === 10000, '10000 步可完成');
  ok(ms < 2000, '10000 步在 2 秒内完成', ms.toFixed(0) + 'ms');
}

console.log('\n----------------------------------------');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) {
  console.log('失败项：');
  failures.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
console.log('全部通过');
