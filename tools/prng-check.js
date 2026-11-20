import { mulberry32, nextInt } from '../src/prng.js';
const a = mulberry32(7), b = mulberry32('7'), c = mulberry32(7);
const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
console.log('seed 7   :', sa.join(','));
console.log("seed '7' :", sb.join(','));
console.log('deterministic:', JSON.stringify(sa) === JSON.stringify(sc));
console.log('number vs string differ:', JSON.stringify(sa) !== JSON.stringify(sb));
const r = mulberry32(42);
let ok = true;
for (let i = 0; i < 10000; i++) {
  const v = nextInt(r, 3);
  if (v < 0 || v >= 3) ok = false;
}
console.log('nextInt range ok:', ok);
// 边界 n=1
const r2 = mulberry32(1);
console.log('nextInt(1) always 0:', Array.from({ length: 50 }, () => nextInt(r2, 1)).every((x) => x === 0));
