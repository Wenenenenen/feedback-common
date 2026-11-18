// 对照样例包 reference.json 与格式说明验证引擎。用法: node test.js <样例目录>
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const dir = process.argv[2];
if (!dir) { console.error('usage: node test.js <samples dir>'); process.exit(2); }
const load = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS  ' + name);
  else { failures++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function near(a, b, eps, what) {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > eps) {
      check(what, false, JSON.stringify(a) + ' != ' + JSON.stringify(b));
      return;
    }
  }
  check(what, true);
}

const ref = load('reference.json');

// ---------- two-bone: 根累计位移 ----------
{
  const model = E.validate(load('two-bone.json'));
  const cfg = model.config; // start_frame=10000 -> 纯 A
  for (const k of [0, 60, 120]) {
    const expect = ref['two-bone']['frame_' + k + '_root'];
    near(E.rootAccumAt(model, cfg, k), expect, 1e-9, 'two-bone root @frame ' + k);
  }
  // 循环跨界不回跳：根位移应单调不减（A 根 t 从 0 匀速到 2）
  const acc = E.makeRootAccumulator(model, cfg);
  let prev = -Infinity, mono = true;
  for (let k = 0; k <= 300; k++) {
    const r = acc.accum(k)[0];
    if (r < prev - 1e-9) mono = false;
    prev = r;
  }
  check('two-bone root 单调连续（循环跨界无回跳）', mono);
  // 拖动 == 连续播放：增量式累计器与全新计算一致
  const acc2 = E.makeRootAccumulator(model, cfg);
  for (let k = 0; k <= 250; k++) acc2.accum(k);
  near(acc2.accum(250), E.rootAccumAt(model, cfg, 250), 1e-12, 'root 拖动/播放一致性 @250');
  // 姿态确定性：同一帧两次求值一致
  const p1 = E.poseAt(model, cfg, 137), p2 = E.poseAt(model, cfg, 137);
  near(p1.worlds[1], p2.worlds[1], 0, 'pose 确定性 @137');
  // 帧 60：A 在 t=1s，child r 键为 [0,0,1,0]（180°），根 stripped
  const w = E.poseAt(model, cfg, 60).worlds[1];
  near([w[0], w[1], w[2]], [-1, 0, 0], 1e-9, 'two-bone frame60 child 旋转 R 第一行');
}

// ---------- antipodal: 对极点四元数最短弧 ----------
{
  const model = E.validate(load('antipodal.json'));
  const cfg = model.config;
  let ok = true;
  for (let k = 0; k <= 240; k += 7) {
    const w = E.poseAt(model, cfg, k).worlds[1];
    // 旋转部分应恒为单位阵（q 与 -q 表示同一旋转）
    const ident = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const rot = [w[0], w[1], w[2], w[4], w[5], w[6], w[8], w[9], w[10]];
    for (let i = 0; i < 9; i++) if (Math.abs(rot[i] - ident[i]) > 1e-9) ok = false;
  }
  check('antipodal 所有帧 child 旋转等价于 [0,0,0,1]', ok);
}

// ---------- blend: 淡化/速度/遮罩 合理性 ----------
{
  const model = E.validate(load('blend.json'));
  const cfg = model.config; // start=60 fade=45 speedA=1.25 speedB=0.75 mask=[0.5,1]
  check('blend alpha(60)=0', E.alphaAt(cfg, 60) === 0);
  check('blend alpha(105)=1', E.alphaAt(cfg, 105) === 1);
  check('blend alpha(82.5)=0.5', Math.abs(E.alphaAt(cfg, 82.5) - 0.5) < 1e-12);
  let finite = true;
  for (let k = 0; k <= 400; k += 3) {
    const p = E.poseAt(model, cfg, k);
    for (const m of p.worlds) for (const v of m) if (!isFinite(v)) finite = false;
    const r = E.rootAccumAt(model, cfg, k);
    if (!r.every(isFinite)) finite = false;
  }
  check('blend 全帧无 NaN/Inf', finite);
  // 淡化期间根位移仍连续（相邻帧增量有界）
  const acc = E.makeRootAccumulator(model, cfg);
  let prev = acc.accum(0), cont = true;
  for (let k = 1; k <= 200; k++) {
    const cur = acc.accum(k);
    if (Math.hypot(cur[0] - prev[0], cur[2] - prev[2]) > 0.2) cont = false;
    prev = cur;
  }
  check('blend 淡化期间根位移连续无跳变', cont);
  // mask[0]=0.5：淡化完成后根增量 = 0.5*ΔA + 0.5*ΔB
  // A: 速度1.25, 周期2s, 端点差2 -> 水平速度 1.25*2/2=1.25/s
  // B: 速度0.75, 周期1s, 端点差[0,2](Z向) -> 0.75*2/1=1.5/s (Z)
  const r1 = E.rootAccumAt(model, cfg, 300), r2 = E.rootAccumAt(model, cfg, 360);
  const dx = r2[0] - r1[0], dz = r2[2] - r1[2];
  check('blend 淡化后根速度 X=0.625/s', Math.abs(dx - 0.5 * 1.25) < 1e-9, 'dx=' + dx);
  check('blend 淡化后根速度 Z=0.75/s', Math.abs(dz - 0.5 * 1.5) < 1e-9, 'dz=' + dz);
}

// ---------- 非法输入 ----------
{
  let threw = false;
  try { E.validate(load('invalid-cycle.json')); } catch (e) { threw = /环/.test(e.message); }
  check('invalid-cycle 报环错误', threw);
  threw = false;
  try { E.validate(load('invalid-weight.json')); } catch (e) { threw = /负/.test(e.message); }
  check('invalid-weight 报负权重错误', threw);
}

// ---------- STEP 模式 / 精确落键 / 缺轨 ----------
{
  const model = E.validate(load('two-bone.json'));
  const clipB = model.clips[1];
  const sTrack = clipB.map.get('1:s');
  near(Array.from(E.sampleTrack(sTrack, 0.25)), [1, 1, 1], 0, 'STEP 保持前一键');
  near(Array.from(E.sampleTrack(sTrack, 0.5)), [2, 1, 0.5], 0, '精确落键取该键');
  near(Array.from(E.sampleTrack(sTrack, 0.75)), [2, 1, 0.5], 0, 'STEP 后半段保持');
  // 缺轨用绑定值：clipB 无 bone0 的 r 轨
  const l = E.poseAt(model, { start_frame: 1e9, fade_frames: 1, speed_a: 0, speed_b: 1, mask: [1, 1] }, 30);
  near(l.locals[0].r, [0, 0, 0, 1], 1e-12, '缺轨使用绑定旋转');
}

// ---------- 蒙皮 ----------
{
  const model = E.validate(load('two-bone.json'));
  const cfg = model.config;
  const pose = E.poseAt(model, cfg, 0);
  const verts = E.skinVertices(model, pose.worlds, [0, 0, 0]);
  // frame0 = 绑定姿态（根 stripped 后 t=[0,0,0]，child r=identity）=> 顶点应等于原位置
  let ok = true;
  for (let v = 0; v < model.vertCount; v++) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs(verts[v * 3 + c] - model.mesh.positions[v][c]) > 1e-9) ok = false;
    }
  }
  check('绑定姿态蒙皮还原原顶点', ok);
}

console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败');
process.exit(failures === 0 ? 0 : 1);
