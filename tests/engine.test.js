/*
 * Node 测试（不放在 samples 内，避免加载不可信目录中的模块）
 * 运行：node tests/engine.test.js
 */
'use strict';

var path = require('path');
var fs = require('fs');
var engine = require(path.join(__dirname, '..', 'js', 'engine.js'));
var broad = require(path.join(__dirname, '..', 'js', 'broadphase.js'));
var validate = require(path.join(__dirname, '..', 'js', 'validate.js'));

var SAMPLES = path.join(__dirname, '..', 'samples', 'extracted');
var cases = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'cases.json'), 'utf8'));
var stress = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'stress.json'), 'utf8'));
var invalid = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'invalid.json'), 'utf8'));

var failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log('  ✓ ' + msg);
  } else {
    failures++;
    console.error('  ✗ ' + msg);
  }
}
function approx(a, b, eps) {
  return Math.abs(a - b) <= (eps || 1e-9);
}
function byPair(recs) {
  var m = {};
  recs.forEach(function (r) { m[r.a + '|' + r.b] = r; });
  return m;
}

console.log('== 1. cases.json 期望比对 ==');
cases.forEach(function (c) {
  console.log('场景：' + c.name);
  var recs = engine.detectScene(c);
  if (c.expected) {
    check(recs.length === c.expected.length,
      '记录数 ' + recs.length + ' == 期望 ' + c.expected.length);
    var got = byPair(recs);
    c.expected.forEach(function (e) {
      var r = got[e.a + '|' + e.b];
      check(!!r, '存在接触对 ' + e.a + '/' + e.b);
      if (r) {
        check(approx(r.tEnter, e.tEnter), 'tEnter ' + r.tEnter + ' == ' + e.tEnter);
        check(approx(r.tExit, e.tExit), 'tExit ' + r.tExit + ' == ' + e.tExit);
        check(r.startOverlap === e.startOverlap,
          'startOverlap ' + r.startOverlap + ' == ' + e.startOverlap);
        check(approx(r.normal[0], e.normal[0], 1e-8) &&
              approx(r.normal[1], e.normal[1], 1e-8),
          'normal [' + r.normal + '] == [' + e.normal + ']');
        check(r.sensor === e.sensor, 'sensor ' + r.sensor + ' == ' + e.sensor);
      }
    });
  } else if (c.expected_times) {
    check(recs.length === 1, '传感器擦边产生 1 条记录，实际 ' + recs.length);
    if (recs.length === 1) {
      var r0 = recs[0];
      check(approx(r0.tEnter, c.expected_times[0]), 'tEnter ' + r0.tEnter);
      check(approx(r0.tExit, c.expected_times[1]), 'tExit ' + r0.tExit);
      check(r0.sensor === true, 'sensor 标记为 true');
      check(r0.startOverlap === false, 'startOverlap=false');
    }
  }
});

console.log('\n== 2. 宽阶段一致性与漏报/多报 ==');
cases.forEach(function (c) {
  var pipe = broad.runPipeline(c);
  var sap = broad.broadPhaseSAP(c.bodies, c.dt)
    .map(function (p) { return p.join('|'); }).sort();
  var brute = broad.broadPhaseBrute(c.bodies, c.dt)
    .map(function (p) { return p.join('|'); }).sort();
  check(JSON.stringify(sap) === JSON.stringify(brute),
    c.name + '：SAP 与朴素宽阶段候选一致（' + sap.length + ' 对）');
  check(pipe.falseNegatives.length === 0,
    c.name + '：宽阶段漏报 0，实际 ' + pipe.falseNegatives.length);
});

console.log('\n== 3. stress.json（512 物体）==');
var t0 = Date.now();
var pipe = broad.runPipeline(stress);
var ms = Date.now() - t0;
console.log('  耗时 ' + ms + 'ms，合格对 ' + pipe.eligiblePairs.length +
  '，宽阶段候选 ' + pipe.broadPairs.length +
  '，接触 ' + pipe.referenceContacts.length +
  '，漏报 ' + pipe.falseNegatives.length +
  '，宽阶段多报 ' + pipe.broadOnly.length);
check(pipe.falseNegatives.length === 0, '压力场景无漏报');
check(pipe.contacts.length === pipe.referenceContacts.length,
  '宽阶段管线与全量精测接触数一致');
var sapSet = {};
broad.broadPhaseSAP(stress.bodies, stress.dt).forEach(function (p) {
  sapSet[p.join('|')] = true;
});
var bruteSet = {};
broad.broadPhaseBrute(stress.bodies, stress.dt).forEach(function (p) {
  bruteSet[p.join('|')] = true;
});
check(Object.keys(sapSet).length === Object.keys(bruteSet).length, 'SAP/朴素候选数一致');
check(Object.keys(sapSet).every(function (k) { return bruteSet[k]; }), 'SAP 无额外或缺失候选');
check(ms < 1000, '512 物体全场景检测在 1s 内完成');
// sensor 字段全部存在且为 false
check(pipe.referenceContacts.every(function (r) { return r.sensor === false; }),
  '压力场景 sensor 均为 false');
// 输出字段完整性
check(pipe.referenceContacts.every(function (r) {
  return r.tEnter >= -1e-12 && r.tExit <= stress.dt + 1e-12 &&
         r.tEnter <= r.tExit + 1e-12 &&
         Math.hypot(r.normal[0], r.normal[1]) > 0.99 &&
         Math.hypot(r.normal[0], r.normal[1]) < 1.01;
}), '所有记录区间与法线合法');

console.log('\n== 4. 采样法独立验证 SAT 区间（stress 全量）==');
// 独立思路：在 [0,dt] 密集采样逐轴投影，判断采样点是否闭集重叠，
// 与连续 SAT 的 [tEnter,tExit] 比对边界
function overlappingAt(bA, bB, t) {
  var wA = engine.worldVertsAt(bA, t);
  var wB = engine.worldVertsAt(bB, t);
  var axes = [];
  [bA, bB].forEach(function (b) {
    for (var i = 0; i < b.vertices.length; i++) {
      var p0 = b.vertices[i], p1 = b.vertices[(i + 1) % b.vertices.length];
      axes.push(engine.edgeAxis(p0, p1));
    }
  });
  for (var k = 0; k < axes.length; k++) {
    var pa = engine.projectVerts(wA, axes[k]);
    var pb = engine.projectVerts(wB, axes[k]);
    if (pb[0] > pa[1] + 1e-9 || pb[1] < pa[0] - 1e-9) return false;
  }
  return true;
}
var byId = {};
stress.bodies.forEach(function (b) { byId[b.id] = b; });
var N = 401;
var sampleMismatch = 0;
pipe.referenceContacts.forEach(function (r) {
  var bA = byId[r.a], bB = byId[r.b];
  for (var i = 0; i < N; i++) {
    var t = stress.dt * i / (N - 1);
    var ov = overlappingAt(bA, bB, t);
    var inside = t >= r.tEnter - 1e-9 && t <= r.tExit + 1e-9;
    if (ov !== inside) {
      // 采样落在边界 1e-9 外仍不一致才算
      if (Math.abs(t - r.tEnter) > 2e-3 && Math.abs(t - r.tExit) > 2e-3) {
        sampleMismatch++;
      }
    }
  }
});
check(sampleMismatch === 0, '401 点采样与 SAT 区间全部一致（不符 ' + sampleMismatch + '）');

// 反向：抽 300 个无接触对，采样确认全程不重叠
var contactKeys = {};
pipe.referenceContacts.forEach(function (r) { contactKeys[r.a + '|' + r.b] = true; });
var nonContacts = pipe.eligiblePairs.filter(function (p) {
  return !contactKeys[p.join('|')];
});
var checked = 0, bad = 0;
for (var idx = 0; idx < nonContacts.length && checked < 300; idx += 7) {
  var p = nonContacts[idx];
  var x = byId[p[0]], y = byId[p[1]];
  checked++;
  for (var i2 = 0; i2 < 51; i2++) {
    if (overlappingAt(x, y, stress.dt * i2 / 50)) { bad++; break; }
  }
}
check(bad === 0, '无接触对采样 51 点均不重叠（抽检 ' + checked + ' 对，异常 ' + bad + '）');

console.log('\n== 5. invalid.json 校验 ==');
var v = validate.validateScene(invalid);
check(!v.ok, '非法场景被拒绝');
check(v.errors.some(function (e) { return /凸/.test(e.message); }),
  '报出严格凸/逆时针错误：' + v.errors.map(function (e) { return e.message; }).join('；'));
var vOk = validate.validateScene(stress);
check(vOk.ok, 'stress 场景通过校验');

console.log('\n== 6. 边界情形构造 ==');
// 6a. 一帧内完全穿过（接触区间严格在帧内）
var tunnel = {
  dt: 1,
  bodies: [
    { id: 'A', position: [-10, 0], velocity: [20, 0],
      vertices: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
      layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [0, 0], velocity: [0, 0],
      vertices: [[-0.5, -2], [0.5, -2], [0.5, 2], [-0.5, 2]],
      layer: 0, mask: 255, sensor: false }
  ]
};
var r = engine.detectScene(tunnel)[0];
check(!!r && approx(r.tEnter, 0.45) && approx(r.tExit, 0.55),
  '完全穿过：tEnter=' + (r && r.tEnter) + ' tExit=' + (r && r.tExit));

// 6b. 零相对速度且分离 → 无记录
var sep = {
  dt: 1,
  bodies: [
    { id: 'A', position: [-5, 0], velocity: [1, 1],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [5, 0], velocity: [1, 1],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
  ]
};
check(engine.detectScene(sep).length === 0, '零相对速度且分离：无记录');

// 6c. 静止轴永不分离：一物体完全包住另一物体且都静止，tExit 必须裁到 dt
var contain = {
  dt: 1.5,
  bodies: [
    { id: 'A', position: [0, 0], velocity: [0, 0],
      vertices: [[-5, -5], [5, -5], [5, 5], [-5, 5]], layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [0, 0], velocity: [0, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
  ]
};
var rc = engine.detectScene(contain)[0];
check(!!rc && approx(rc.tEnter, 0) && approx(rc.tExit, 1.5) && rc.startOverlap &&
  rc._exitAxis === -1, '包含静止：tExit 裁到 dt 且无离开限制轴');

// 6d. 擦边滑动：A 顶点沿 B 底边滑动，区间 [0.25,0.75] 内真实重叠（几何采样验证）
var graze = {
  dt: 1,
  bodies: [
    { id: 'A', position: [0, 0], velocity: [4, 0],
      vertices: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
      layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [2, 1], velocity: [0, 0],
      vertices: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
      layer: 0, mask: 255, sensor: false }
  ]
};
var rg = engine.detectScene(graze)[0];
check(!!rg && approx(rg.tEnter, 0.25) && approx(rg.tExit, 0.75),
  '擦边滑动：[0.25, 0.75]，实际 [' + (rg && rg.tEnter) + ', ' + (rg && rg.tExit) + ']');

// 6d2. 静止顶点对顶点相切：两方块仅在公共顶点 (1,1) 闭集接触，均静止，
// 点接触关系整帧保持 → 区间 [0,dt]；startOverlap=true（t=0 存在闭集交集）
var pointTouch = {
  dt: 1,
  bodies: [
    { id: 'A', position: [0, 0], velocity: [0, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [2, 2], velocity: [0, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
  ]
};
var rp = engine.detectScene(pointTouch)[0];
check(!!rp && approx(rp.tEnter, 0) && approx(rp.tExit, 1) && rp.startOverlap === true,
  '静止顶点相切：整帧点接触 [0,1]，startOverlap=true，实际 [' + (rp && rp.tEnter) +
  ', ' + (rp && rp.tExit) + '] ' + (rp && rp.startOverlap));

// 6d3. 临界边-边共线滑动：A 顶边与 B 底边共线，x 方向扫过，接触为闭区间
var edgeSlide = {
  dt: 1,
  bodies: [
    { id: 'A', position: [0, 0], velocity: [4, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [4, 2], velocity: [0, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
  ]
};
var re = engine.detectScene(edgeSlide)[0];
check(!!re && approx(re.tEnter, 0.5) && approx(re.tExit, 1),
  '共线滑动：[0.5, 1(dt 裁剪)]，实际 [' + (re && re.tEnter) + ', ' + (re && re.tExit) + ']');

// 6e. 双向掩码：仅一方通过则不检测
var maskScene = {
  dt: 1,
  bodies: [
    { id: 'A', position: [0, 0], velocity: [0, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 1, sensor: false },
    { id: 'B', position: [0, 0], velocity: [0, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 1, mask: 1, sensor: false }
  ]
};
check(engine.detectScene(maskScene).length === 0, '单向掩码不检测');

// 6f. 初始重叠且正在分离：tEnter=0，tExit 为真实离开时刻
var split = {
  dt: 1,
  bodies: [
    { id: 'A', position: [0, 0], velocity: [-2, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [1, 0], velocity: [2, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
  ]
};
var rs = engine.detectScene(split)[0];
// A 右缘 1-2t，B 左缘 (1-1)+2t=2t，相切时 1-2t=2t → t=0.25
check(!!rs && rs.startOverlap && approx(rs.tEnter, 0) && approx(rs.tExit, 0.25),
  '初始重叠分离中：[0, 0.25]，实际 [' + (rs && rs.tEnter) + ', ' + (rs && rs.tExit) + ']');

// 6g. 法线单位长度与定向：共线运动沿 +x 撞墙，法线应指 -x
check(!!r && approx(r.normal[0], -1, 1e-8) && approx(r.normal[1], 0, 1e-8),
  '进入法线朝 A 中心方向（-x）：[' + (r && r.normal) + ']');

// 6h. id 字符串排序（小写 id 也要按字典序）
var orderScene = {
  dt: 1,
  bodies: [
    Object.assign({}, tunnel.bodies[1], { id: 'zebra' }),
    Object.assign({}, tunnel.bodies[0], { id: 'apple' })
  ]
};
var ro = engine.detectScene(orderScene)[0];
check(ro.a === 'apple' && ro.b === 'zebra', 'a/b 按 id 字符串排序');

// 6i. 进入时刻并列：斜向撞入使多轴同时达到下界，取轴序列最先者（A 边0）
var tieScene = {
  dt: 1,
  bodies: [
    { id: 'A', position: [0, 0], velocity: [3, 3],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [3, 3], velocity: [0, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
  ]
};
var rt = engine.detectScene(tieScene)[0];
check(rt._enterAxis === 0 && rt._axes[0].owner === 'A' && rt._axes[0].edge === 0,
  '并列进入取排序最先轴（A·边0），实际 idx=' + rt._enterAxis);
check(Math.abs(Math.hypot(rt.normal[0], rt.normal[1]) - 1) <= 1e-8, '并列情形法线单位长度');

// 6j. 法线点积为零的定向：水平排列对撞，进入轴竖直，靠首个非零分量/中心方向定符号
var horizScene = {
  dt: 1,
  bodies: [
    { id: 'A', position: [-2, 0], velocity: [4, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [2, 0], velocity: [0, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
  ]
};
var rh = engine.detectScene(horizScene)[0];
check(approx(rh.normal[0], -1, 1e-8) && approx(rh.normal[1], 0, 1e-8),
  '水平对撞法线朝 A（-x）：[' + rh.normal + ']');

// 6k. 接触区间超出 dt 时裁到 dt（接触持续到帧后）
var beyondScene = {
  dt: 0.5,
  bodies: [
    { id: 'A', position: [0, 0], velocity: [1, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [1.5, 0], velocity: [0, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
  ]
};
// A 右缘 1+t，B 左缘 0.5 → tEnter=-0.5（初始重叠）；A 左缘 -1+t，B 右缘 2.5 → 永不离开
var rb = engine.detectScene(beyondScene)[0];
check(rb.startOverlap === true && approx(rb.tEnter, 0) && approx(rb.tExit, 0.5),
  '区间裁剪到 dt：[0, 0.5]，实际 [' + rb.tEnter + ', ' + rb.tExit + ']');

// 6l. 三角形（3 顶点）与五边形，验证非四边形轴数与检测
var triScene = {
  dt: 1,
  bodies: [
    { id: 'A', position: [-4, 0], velocity: [6, 0],
      vertices: [[0, -1], [1, 0], [0, 1]], layer: 0, mask: 255, sensor: false },
    { id: 'B', position: [1, 0], velocity: [0, 0],
      vertices: [[-1, -1], [1, -1], [1.5, 0], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
  ]
};
var rtri = engine.detectScene(triScene)[0];
check(!!rtri && rtri._axes.length === 8, '三角形+五边形共 8 条边法线，实际 ' + (rtri && rtri._axes.length));
check(rtri.tEnter >= 0 && rtri.tExit <= 1 && rtri.tEnter <= rtri.tExit,
  '混合多边形接触区间合法：[' + rtri.tEnter + ', ' + rtri.tExit + ']');

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'));
process.exit(failures === 0 ? 0 : 1);
