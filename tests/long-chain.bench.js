const SF = require('../strip-forge.js');

const faces = new Array(100000);
for (let i = 0; i < 100000; i++) {
  faces[i] = {
    v: i % 2 === 0 ? [i, i + 1, i + 2] : [i + 1, i, i + 2],
    group: 0,
    last: null
  };
}

const started = process.hrtime.bigint();
const result = SF.packDocument({ faces });
const ms = Number(process.hrtime.bigint() - started) / 1e6;
const verification = SF.verifyResult({ faces }, result);

console.log({
  ms: ms.toFixed(1),
  indices: result.length,
  expected: 100002,
  degenerates: result.stats.degenerateWindowCount,
  restarts: result.stats.restartCount,
  verified: verification.ok
});
if (!verification.ok) {
  console.error(verification.errors);
  process.exit(1);
}
if (ms > 8000) process.exit(2);
