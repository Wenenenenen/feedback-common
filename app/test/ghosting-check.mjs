// 验证需求场景"物体移开后留影"：在物体→背景切换帧，历史位置上落在旧物体的采样点
// 必须逐个被深度拒绝，只有背景采样点参与加权且权重重新归一化，旧物体颜色零漏入。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computePixelDebug, reprojectSequence, SampleReason, Reason } from '../src/core.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const seq = JSON.parse(readFileSync(join(HERE,'..','sample-data','moving.json'),'utf8'));
const params = { tau:0.05, historyWeight:0.9, cap:8 };
const full = reprojectSequence(structuredClone(seq), params);
const w = seq.width, x=5, y=10, p=y*w+x;

let transition=-1;
for (let f=1;f<seq.frames.length;f++)
  if (seq.frames[f-1].depth[p]===2 && seq.frames[f].depth[p]===6){ transition=f; break; }
console.log('物体→背景切换帧 =', transition);

const dbg = computePixelDebug(seq, transition, x, y,
  full.frames[transition-1].color, full.frames[transition-1].count, params);
let fail=0;
const rejected = dbg.samples.filter(s=>!s.valid);
const valid = dbg.samples.filter(s=>s.valid);
console.log('被拒采样点:', rejected.map(s=>`(${s.x},${s.y})d=${s.prevDepth}->${s.sampleReason}`).join(' '));
console.log('有效采样点:', valid.map(s=>`(${s.x},${s.y})d=${s.prevDepth} nw=${s.normalizedWeight.toFixed(3)}`).join(' '));

// 1) 所有落在旧物体(depth=2)上的历史采样点必须被深度拒绝
const objectSamples = dbg.samples.filter(s=>s.prevDepth===2);
if (!objectSamples.length || objectSamples.some(s=>s.valid || s.sampleReason!==SampleReason.DEPTH_THRESHOLD)){
  console.error('✗ 旧物体采样点未全部深度拒绝'); fail++;
} else console.log('✓ 旧物体(depth=2)采样点全部深度拒绝，物体颜色零漏入');

// 2) 有效点必须全部是背景(depth=6)，且归一化权重之和为 1
if (valid.some(s=>s.prevDepth!==6)){ console.error('✗ 有效点含非背景'); fail++; }
const wsum = valid.reduce((a,s)=>a+s.normalizedWeight,0);
if (Math.abs(wsum-1)>1e-12){ console.error('✗ 有效权重未归一化到1, 和=',wsum); fail++; }
else console.log('✓ 仅背景采样点有效，归一化权重和 = 1');

// 3) 全拒场景（three-pixels 帧2 中心：4 点深度全超阈值）必须 reason=深度拒绝、计数1、输出当前色
const tseq = JSON.parse(readFileSync(join(HERE,'..','sample-data','three-pixels.json'),'utf8'));
const tfull = reprojectSequence(structuredClone(tseq), params);
const tdbg = computePixelDebug(tseq,2,1,0,tfull.frames[1].color,tfull.frames[1].count,params);
if (tdbg.reason!==Reason.NO_VALID_DEPTH_THRESHOLD || tdbg.count!==1){
  console.error('✗ 全拒场景判定错误', tdbg.reason, tdbg.count); fail++;
} else console.log('✓ 四采样点全拒 → 深度拒绝、计数重置1、直接输出当前色', tdbg.outputColor);
process.exit(fail?1:0);
