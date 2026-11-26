const fs = require('fs');
const path = require('path');
const E = require('../app/engine.js');

const roomRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'extracted', 'room.json'), 'utf8'));
const room = E.validateRoom(roomRaw);
const seqs = E.enumerateSequences(room.order);
console.log('sequences up to order', room.order, ':', seqs.length);

const t0 = Date.now();
const all = [];
for (let si = 0; si < room.sources.length; si++)
  for (let ri = 0; ri < room.receivers.length; ri++) {
    const paths = E.solvePair(room, si, ri, seqs);
    all.push({ si, ri, paths });
    const reach = paths.filter(p => p.reachable).length;
    console.log(`S${si}->R${ri}: ${paths.length} geometric paths, ${reach} reachable, ${paths.length - reach} blocked`);
  }
console.log('solve all pairs ms:', Date.now() - t0);

for (const { si, ri, paths } of all) {
  console.log(`\n== S${si} -> R${ri} ==`);
  for (const p of paths) {
    const v0 = p.vertices.map(v => v.map(E.rtof).map(x => x.toFixed(1)).join(',')).join(' | ');
    const blk = p.reachable ? '' : ` BLOCKED seg=${p.blockedSegment} box=${p.blockedBox}`;
    console.log(`  [${p.wallNames.join(',') || 'direct'}] L=${p.lengthMm.toFixed(2)}mm ${p.reachable ? 'OK' : 'BLOCK'}${blk}`);
    console.log(`    ${v0}`);
  }
  const resp = E.buildResponse(room, all.find(a => a.si === si && a.ri === ri).paths);
  const nz = [];
  for (let i = 0; i < resp.length; i++) if (resp[i] !== 0) nz.push([i, resp[i]]);
  console.log('  nonzero frames:', nz.length, 'first 8:', nz.slice(0, 8).map(([i, v]) => i + ':' + v.toExponential(3)).join(' '));
}

// timing: full spec room, order 4, 6 sources x 32 receivers, 24 boxes
function rnd(n) { return Math.floor(Math.random() * n); }
const size = [20000, 15000, 9000];
const boxes = [];
while (boxes.length < 24) {
  const sx = 800 + rnd(1200), sy = 800 + rnd(1200), sz = 500 + rnd(800);
  const mn = [200 + rnd(size[0] - sx - 400), 200 + rnd(size[1] - sy - 400), 200 + rnd(size[2] - sz - 400)];
  boxes.push({ min: mn, max: [mn[0] + sx, mn[1] + sy, mn[2] + sz] });
}
const outside = (p) => boxes.every(b => p.some((v, a) => v < b.min[a] || v > b.max[a]));
const pts = [];
while (pts.length < 38) {
  const p = [100 + rnd(size[0] - 200), 100 + rnd(size[1] - 200), 100 + rnd(size[2] - 200)];
  if (outside(p) && pts.every(q => q.some((v, a) => v !== p[a]))) pts.push(p);
}
const big = E.validateRoom({
  size, sources: pts.slice(0, 6), receivers: pts.slice(6, 38), boxes, order: 4,
  walls: roomRaw.walls,
});
const seqs4 = E.enumerateSequences(4);
console.log('\norder-4 sequences:', seqs4.length);
let start = Date.now();
for (let ri = 0; ri < big.receivers.length; ri++)
  E.solvePair(big, 0, ri, seqs4);
console.log('FULL SPEC one source -> 32 mics, 24 boxes, order 4, ms:', Date.now() - start);
start = Date.now();
const ps = E.solvePair(big, 0, 0, seqs4);
E.buildResponse(big, ps);
console.log('plus response ms:', Date.now() - start);
