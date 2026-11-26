#!/usr/bin/env node
/* Full-scale generator + engine benchmark.
 * Builds a ~64 MiB / 120_000 record / 4 channel / D=64 / 30 s PDQ1 file in
 * tmp/full-d64.pdq and times the pure engine decode in Node as a proxy for
 * browser cost. The real <=20 s acceptance is measured in Playwright.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../js/engine.js');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const OUT = path.join(TMP, 'full-d64.pdq');

const D = 64, C = 4;
const FRAMES = 1_440_000;          // 30 s * 48 kHz
const TICKS = FRAMES * D;           // 92_160_000
const NREC = 120_000;
const COUNT = 1096;                 // *4ch -> 548 payload bytes, 559 / record
const MASK = 0x0f;
const REC_LEN = 7 + Math.ceil((COUNT * 4) / 8) + 4; // 559
const TOTAL = 14 + NREC * REC_LEN;  // ~67.08 MB = 63.97 MiB
const ANCHOR = 0xfffffff0 >>> 0;

function build() {
  const buf = Buffer.allocUnsafe(TOTAL);
  let o = 0;
  buf.write('PDQ1', o, 'ascii'); o += 4;
  buf.writeUInt32LE(ANCHOR, o); o += 4;
  buf.writeUInt32LE(TICKS, o); o += 4;
  buf[o++] = C;
  buf[o++] = D;

  let seed = 123456789;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };

  for (let i = 0; i < NREC; i++) {
    // First portion tiles the timeline sequentially; remainder are in-range
    // retransmissions at pseudo-random starts (heavy but legal overlap).
    let rel;
    const seqRecords = Math.ceil(TICKS / COUNT); // ~84088
    if (i < seqRecords) rel = Math.min(i * COUNT, TICKS - COUNT);
    else rel = rnd() % (TICKS - COUNT);
    if (rel + COUNT > TICKS) rel = TICKS - COUNT;

    const recStart = o;
    buf.writeUInt32LE((ANCHOR + rel) >>> 0, o); o += 4;
    buf.writeUInt16LE(COUNT, o); o += 2;
    buf[o++] = MASK;
    const payloadStart = o;
    for (let k = 0; k < REC_LEN - 11; k++) buf[o++] = (rnd() >>> ((k & 3) * 8)) & 0xff;
    const crc = E.crc32Range(buf, recStart, payloadStart + (REC_LEN - 11)) >>> 0;
    buf.writeUInt32LE(crc, o); o += 4;
  }
  if (o !== TOTAL) throw new Error('length mismatch ' + o + ' vs ' + TOTAL);
  fs.writeFileSync(OUT, buf);
  return OUT;
}

if (!fs.existsSync(OUT) || fs.statSync(OUT).size !== TOTAL || process.argv.includes('--gen')) {
  const t0 = Date.now();
  build();
  console.log('generated', OUT, (TOTAL / 1048576).toFixed(2), 'MiB in', Date.now() - t0, 'ms');
} else {
  console.log('reusing', OUT);
}

const ab = fs.readFileSync(OUT);
const t0 = performance.now();
const r = E.decode(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength));
const ms = performance.now() - t0;
const mem = process.memoryUsage();
console.log('decode ok=', r.ok, 'records=', r.parsed.records.length,
  'badCrc=', r.parsed.records.filter(x => !x.crcOk).length,
  'trunc=', !!r.parsed.truncated);
console.log('frames=', r.frames, 'intervals/ch=', r.channelData.map(c => c.intervals.length).join(','));
console.log('timings(ms)=', JSON.stringify({
  parse: Math.round(r.timings.parseMs),
  channels: Math.round(r.timings.channelsMs),
  interleave: Math.round(r.timings.interleaveMs),
  total: Math.round(r.timings.totalMs)
}));
console.log('wall=', Math.round(ms), 'ms  (budget 20000)');
console.log('rss=', (mem.rss / 1048576).toFixed(0), 'MiB heapUsed=', (mem.heapUsed / 1048576).toFixed(0), 'MiB');
if (process.argv.includes('--assert')) {
  if (!(ms < 20000)) { console.error('PERF BUDGET EXCEEDED'); process.exit(1); }
  console.log('PERF OK');
}
