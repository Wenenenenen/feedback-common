/* 随机合法布局的不变量 + 路径往返 + 自迁移恒等：node tools/test-property.cjs */
const L = require('../web/js/layout.js');
const E = require('../web/js/engine.js');

let checks = 0;
function assert(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; throw new Error(m); } checks++; }

let seed = 1234567;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }
const SCALARS = ['i32', 'u32', 'f32'];

function genType(depth) {
  const r = rnd();
  if (depth >= 4 || r < 0.35) return SCALARS[ri(3)];
  if (r < 0.5) return { vec: 2 + ri(3), of: SCALARS[ri(3)] };
  if (r < 0.62) return { mat: [2 + ri(3), 2 + ri(3)] };
  if (r < 0.82) return { array: 1 + ri(4), of: genType(depth + 1) };
  const n = 1 + ri(3);
  const ms = [];
  for (let i = 0; i < n; i++) ms.push({ name: 'f' + i, type: genType(depth + 1) });
  return { struct: ms };
}

/** 枚举编译树叶子 scalar：[{path,rel,size}] */
function leaves(node, rel, path, out) {
  switch (node.kind) {
    case 'scalar': out.push({ path: path || '', rel, scalar: node.scalar }); break;
    case 'vec':
      for (let i = 0; i < node.n; i++) out.push({ path: `${path}.v[${i}]`, rel: rel + 4 * i, scalar: node.scalar });
      break;
    case 'mat':
      for (let r = 0; r < node.rows; r++) for (let c = 0; c < node.cols; c++)
        out.push({ path: `${path}.m[${r}][${c}]`, rel: rel + L.matCompOffset(node, r, c), scalar: 'f32' });
      break;
    case 'array': {
      const n = L.arrayCount(node) || 0;
      for (let i = 0; i < n; i++) leaves(node.elem, rel + i * node.stride, `${path}[${i}]`, out);
      break;
    }
    case 'struct':
      for (const m of node.members) leaves(m.type, rel + m.rel, path ? `${path}.${m.name}` : m.name, out);
      break;
  }
}

for (let iter = 0; iter < 300; iter++) {
  const std = rnd() < 0.5 ? 'std140' : 'std430';
  const major = rnd() < 0.5 ? 'row' : 'column';
  const endian = rnd() < 0.5 ? 'little' : 'big';
  const nMembers = 1 + ri(4);
  const members = [];
  const usedNames = new Set();
  for (let i = 0; i < nMembers; i++) {
    let name = 'm' + i;
    while (usedNames.has(name)) name += '_';
    usedNames.add(name);
    const m = { name, type: genType(0) };
    members.push(m);
  }
  // 先用 compileType 求根结构大小
  const probeCtx = { std, major, view: 'v' };
  const rootNode = L.compileType({ struct: members }, probeCtx, 1);
  const length = rootNode.size;
  const off = ri(3) * 256;
  const viewJson = { name: 'v', offset: off, length, layout: std, major, endian, members };
  let view;
  try { view = L.compileView(viewJson); }
  catch (e) { console.error('compile failed on iter', iter, e.message); throw e; }
  assert(view.length === length, 'length matches root size');

  const ls = [];
  leaves(view.root, 0, '', ls);
  // 区间不重叠
  const intervals = ls.map((x) => [off + x.rel, off + x.rel + 4, x.path]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < intervals.length; i++) {
    assert(intervals[i][0] >= intervals[i - 1][1], `scalar intervals disjoint at iter ${iter}: ${intervals[i - 1][2]} vs ${intervals[i][2]}`);
  }
  // 路径往返 + 每字节 byteIndex
  for (const lf of ls) {
    const r = L.resolvePath(view, lf.path);
    assert(r.ok && r.abs === off + lf.rel, `resolve roundtrip ${lf.path} iter${iter} got ${r.abs} want ${off + lf.rel} ${r.error || ''}`);
    for (let b = 0; b < 4; b++) {
      const loc = L.locateRel(view, lf.rel + b);
      assert(!loc.padding && loc.path === lf.path && loc.byteIndex === b,
        `locate roundtrip ${lf.path}+${b} iter${iter} got ${loc.padding ? 'pad' : loc.path + '#' + loc.byteIndex}`);
    }
  }

  // 自迁移恒等
  const dump = new Uint8Array(off + length + 8).fill(0x5a);
  for (let i = 0; i < dump.length; i += 4) dump[i] = (i * 7) & 0xff;
  const snap = Buffer.from(dump);
  const store = E.createStore();
  E.importProject(store, { views: [viewJson] }, dump);
  const wr = E.runBatch(store, [['v', 'v']]);
  assert(wr.writes === ls.length, `self pair writes ${wr.writes} == leaves ${ls.length}`);
  assert(Buffer.from(store.dump).equals(snap), 'self migration identity bytes');
}

console.log(`PROPERTY TESTS PASSED: ${checks} invariants across 300 layouts`);
