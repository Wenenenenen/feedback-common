/* 引擎测试：node test/run-tests.js */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../js/graph-engine.js');

const samplesDir = path.join(__dirname, '..', 'samples');
const load = name => JSON.parse(fs.readFileSync(path.join(samplesDir, name), 'utf8'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// 1. graph.json 前 14 个样本与 first14.json 完全一致
const spec = load('graph.json');
const first14 = load('first14.json');
const compiled = E.compile(spec);
{
  const { output } = E.render(compiled, 128);
  const got = [...output.slice(0, 14)];
  check('graph.json 前14样本与 first14.json 一致',
    got.every((v, i) => v === first14[i]),
    `got [${got.join(',')}]`);
}

// 2. 路径对齐补偿：fast->mix 补 3，slow->mix 补 0
{
  const compOf = (s, d) => compiled.normalEdges.find(e => e.src === s && e.dst === d).comp;
  check('fast->mix 补偿 3 帧', compOf('fast', 'mix') === 3);
  check('slow->mix 补偿 0 帧', compOf('slow', 'mix') === 0);
  check('src->fast / src->slow 补偿 0', compOf('src', 'fast') === 0 && compOf('src', 'slow') === 0);
}

// 3. 不同 blockSize 渲染结果逐位一致
{
  const ref = E.render(compiled, 1).output;
  for (const bs of [2, 7, 64, 128, 1000, 192, 48000]) {
    const out = E.render(compiled, bs).output;
    let maxDiff = 0;
    for (let i = 0; i < out.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - ref[i]));
    check(`blockSize=${bs} 与 blockSize=1 逐位一致`, maxDiff === 0, `maxDiff=${maxDiff}`);
  }
}

// 4. cycle.json：普通边成环，报出环上节点
{
  let err = null;
  try { E.compile(load('cycle.json')); } catch (e) { err = e; }
  check('cycle.json 抛出 cycle 错误', err && err.code === 'cycle', err && err.code);
  check('环上节点包含 fast 和 mix',
    err && err.cycleNodes.includes('fast') && err.cycleNodes.includes('mix'),
    err && JSON.stringify(err.cycleNodes));
  check('给出具体环路径', err && Array.isArray(err.cyclePath) && err.cyclePath.length >= 3,
    err && JSON.stringify(err.cyclePath));
}

// 5. zero-delay.json：delay=0 的反馈被拒绝
{
  let err = null;
  try { E.compile(load('zero-delay.json')); } catch (e) { err = e; }
  check('zero-delay.json 抛出 feedback-delay 错误', err && err.code === 'feedback-delay', err && err.code);
}

// 6. 探针：mix 在 t=7 处的输入输出
{
  const { buffers } = E.render(compiled, 128, ['mix']);
  const p = E.probeAt(compiled, buffers, 'mix', 7);
  // fast(4)=g(4)*0.125=0.125（补偿3后在 t=7 到达）；slow(7)=src(4)=0.125；反馈 0.5*mix(5)=0.0625
  check('探针 mix@7 输入合计 0.3125', p.input === 0.3125, `got ${p.input}`);
  check('探针 mix@7 输出 0.3125', p.output === 0.3125, `got ${p.output}`);
  check('探针 mix@7 普通输入 2 条、反馈输入 1 条',
    p.normal.length === 2 && p.feedback.length === 1);
}

// 7. WAV 头
{
  const buf = new Uint8Array(E.encodeWavFloat32(new Float32Array([0.5, -0.5]), 48000));
  const dv = new DataView(buf.buffer);
  const str = (o, n) => String.fromCharCode(...buf.slice(o, o + n));
  check('WAV RIFF/WAVE 头', str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE');
  check('WAV format=3 (IEEE float), 单声道, 48kHz, 32bit',
    dv.getUint16(20, true) === 3 && dv.getUint16(22, true) === 1 &&
    dv.getUint32(24, true) === 48000 && dv.getUint16(34, true) === 32);
  check('WAV 数据区大小', dv.getUint32(40, true) === 8 && dv.getFloat32(44, true) === 0.5);
}

// 8. 限制：65 个节点 / 超长时长被拒绝
{
  const many = { sample_rate: 48000, frames: 8, output: 'n0',
    nodes: Array.from({ length: 65 }, (_, i) => ({ id: 'n' + i, type: 'mix' })), edges: [] };
  let err = null;
  try { E.compile(many); } catch (e) { err = e; }
  check('65 个节点被拒绝', err && err.code === 'nodes');
  const tooLong = { sample_rate: 48000, frames: 480001, output: 'a',
    nodes: [{ id: 'a', type: 'mix' }], edges: [] };
  err = null;
  try { E.compile(tooLong); } catch (e) { err = e; }
  check('超过 10 秒被拒绝', err && err.code === 'frames');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
