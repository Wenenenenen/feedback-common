'use strict';
// 性能基准：1024×1024 格、两层各一种半径 16 格的植被。
const path = require('path');
const VegetationModule = require(path.join(__dirname, '..', 'src', 'core.js'));
const V = VegetationModule();

function makeCfg(seed, radius, win) {
  return V.normalizeConfig({
    seed: seed,
    species: [
      [{ id: 'tree', radius: radius }],
      [{ id: 'grass', radius: radius }]
    ],
    base: [[1], [1]],
    patches: [],
    window: win
  });
}

const side = 1024;
const win = [-512, -512, side, side];

const runs = [];
for (let t = 0; t < 3; t++) {
  const cfg = makeCfg(12345 + t, 16 * 256, win);
  // 预热
  V.bake(cfg, win);
  const t0 = process.hrtime.bigint();
  const res = V.bake(cfg, win);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  runs.push(ms);
  console.log(`run ${t}: ${ms.toFixed(0)} ms  surviving=${res.survivors.length} ` +
    `candT=${res.stats.treeCandidates} candG=${res.stats.grassCandidates} ` +
    `keptT=${res.stats.treeKeptTotal} keptG=${res.stats.grassKeptTotal} ` +
    `padT=${res.stats.pad.tree} padG=${res.stats.pad.grass}`);
}
const best = Math.min.apply(null, runs);
console.log('最快 ' + best.toFixed(0) + ' ms，预算 10000 ms，' + (best < 10000 ? '通过' : '超出'));
process.exit(best < 10000 ? 0 : 1);
