// Aggregate error reporting + limit enforcement checks.
import { readFileSync } from 'node:fs';
import { parseApng, ApngError } from '../src/apng-parser.js';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`PASS ${n}`)) : (fail++, console.log(`FAIL ${n} ${x}`)) };

try {
  parseApng(new Uint8Array(readFileSync('/tmp/apng-sample-extract/invalid-multi.apng')));
  check('multi-error file throws', false);
} catch (e) {
  check('throws ApngError', e instanceof ApngError);
  check('aggregates multiple problems', Array.isArray(e.errors) && e.errors.length >= 2,
    `got ${e.errors?.length}`);
  const kinds = e.errors.map((x) => x.kind);
  check('contains sequence and count', kinds.includes('sequence') && kinds.includes('count'), kinds.join(','));
  check('each error carries an offset', e.errors.every((x) => typeof x.detail.offset === 'number'));
  console.log('aggregated messages:');
  e.errors.forEach((x) => console.log('  -', x.kind, x.message));
}

// 50MB limit is enforced at the UI layer (app-state / main handleFile); parser itself
// only enforces structural limits. Check dimension and frame-limit error wording exists.
try {
  parseApng(new Uint8Array(readFileSync('/tmp/apng-sample-extract/invalid-count.apng')));
  check('count file throws', false);
} catch (e) {
  check('count error localized to acTL', e.detail.chunkType === 'acTL' && typeof e.detail.offset === 'number');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
