'use strict';
// 满额性能基准：512x512、12 万改格、3 万查询，测耗时与内存（不含画图）
const engine = require('../src/engine.js');

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 512, H = 512;
const EDITS = 120000;
const QUERIES = 30000;
const ALPHABET = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function buildFull(seed, opts = {}) {
  const rng = mulberry32(seed);
  const rows = [];
  for (let y = 0; y < H; y++) {
    let s = '';
    for (let x = 0; x < W; x++) {
      s += rng() < (opts.emptyRate ?? 0.3) ? '.' : ALPHABET[Math.floor(rng() * ALPHABET.length)];
    }
    rows.push(s);
  }
  const edits = [];
  for (let i = 0; i < EDITS; i++) {
    // 混合：多数接在近期版本上制造深链，偶尔接老版本制造宽树
    const parent = rng() < 0.7 ? i : Math.floor(rng() * (i + 1));
    edits.push({
      parent,
      x: Math.floor(rng() * W),
      y: Math.floor(rng() * H),
      value: rng() < 0.4 ? '.' : ALPHABET[Math.floor(rng() * ALPHABET.length)],
    });
  }
  const V = EDITS + 1;
  const queries = [];
  for (let i = 0; i < QUERIES; i++) {
    queries.push({
      version: Math.floor(rng() * V),
      x: Math.floor(rng() * W),
      y: Math.floor(rng() * H),
    });
  }
  return { rows, edits, queries };
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MiB'; }

const scenarios = [
  ['满额-混合(30%空地)', {}],
  ['满额-稀疏空地(10%)', { emptyRate: 0.1 }],
  ['满额-密集空地(55%)', { emptyRate: 0.55 }],
];

for (const [name, opts] of scenarios) {
  const input = buildFull(42, opts);
  const v = engine.validateProject(input);
  if (!v.ok) { console.error(name, '校验失败', v.errors); process.exit(1); }
  global.gc && global.gc();
  const rssBefore = process.memoryUsage().rss;
  const t0 = process.hrtime.bigint();
  const results = engine.runBatch(v.project);
  const t1 = process.hrtime.bigint();
  global.gc && global.gc();
  const rssPeak = process.memoryUsage().rss; // runBatch 返回后其内部临时结构已可回收
  const ms = Number(t1 - t0) / 1e6;
  console.log(`${name}: ${ms.toFixed(0)} ms, 结果 ${results.length} 条, 运行前 RSS ${mb(rssBefore)}, 运行后 RSS ${mb(rssPeak)}`);
  if (results.length !== QUERIES) { console.error('结果数不符'); process.exit(1); }
}

// RSS 峰值（独立一轮，便于观察总内存）
{
  const input = buildFull(99, {});
  const v = engine.validateProject(input);
  engine.runBatch(v.project);
  console.log(`进程峰值 RSS: ${mb(process.memoryUsage().rss)}，堆已用 ${mb(process.memoryUsage().heapUsed)}`);
}
