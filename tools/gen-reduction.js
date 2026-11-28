'use strict';
/* 生成无冲突并行归约样例: 每组 32 线程求和 1..32, 结果写入每个线程自己的输出槽。
 * 用法: node tools/gen-reduction.js [组数] > samples/reduction-ok.json
 *
 * 归约结构: 阶段0 shared[lane]=lane+1; 之后 stride=1,2,4,8,16 树形归约,
 * 活跃线程为 lane % (2*stride) == 0。由于指令集只有 jz(判零),
 * 活跃判断用 xor+jz 等值链: lane 与每个活跃编号逐一比较。
 * 每个阶段内, 活跃线程只写 shared[lane]、只读 shared[lane] 与 shared[lane+stride],
 * 被读的 shared[lane+stride] 在本阶段无人写入, 因此无冲突。
 */
const groups = parseInt(process.argv[2] || '16', 10);
const LANES = 32;

const program = [
  ['set', 'r0', 'lane'],
  ['add', 'r0', 'r0', 1],
  ['store', 'shared', 'lane', 'r0'],
  ['barrier'],
];

for (let s = 1; s < LANES; s *= 2) {
  const fixups = [];
  for (let k = 0; k < LANES; k += 2 * s) {
    program.push(['set', 'r7', 'lane']);
    program.push(['xor', 'r7', 'r7', k]);
    fixups.push(program.length);
    program.push(['jz', 'r7', 0]); // 目标回填为 DO
  }
  const skipJump = program.length;
  program.push(['jz', 0, 0]); // 无条件跳到 SKIP, 回填
  const doPc = program.length;
  program.push(['add', 'r3', 'lane', s]);        // r3 = 伙伴地址
  program.push(['load', 'r1', 'shared', 'r3']);  // r1 = shared[lane+s]
  program.push(['load', 'r2', 'shared', 'lane']); // r2 = shared[lane]
  program.push(['add', 'r2', 'r2', 'r1']);
  program.push(['store', 'shared', 'lane', 'r2']);
  const skipPc = program.length;
  for (const p of fixups) program[p][2] = doPc;
  program[skipJump][2] = skipPc;
  program.push(['barrier']);
}
program.push(['load', 'r4', 'shared', 0]);        // 全体只读 shared[0], 无冲突
program.push(['store', 'output', 'lane', 'r4']);
program.push(['halt']);

const spec = {
  groups,
  lanes: LANES,
  sharedWords: LANES,
  outputWords: LANES,
  program,
  说明: '无冲突并行归约: 每组32线程求和1..32=528, 树形归约, 活跃线程用xor+jz等值链分派。结果写入每个线程自己的输出槽。',
};

process.stdout.write(JSON.stringify(spec));
