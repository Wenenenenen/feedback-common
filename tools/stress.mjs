// Stress: build a ~32MB synthetic TS capture in memory and time the full analysis.
import { analyze } from "../src/analyzer.js";

const SIZE = 32 * 1024 * 1024;
const packets = Math.floor(SIZE / 188);
const buf = new Uint8Array(packets * 188);

function writePacket(i, pid, cc, { pusi = false, afc = 1, pts = null, pcr = null } = {}) {
  const off = i * 188;
  buf.fill(0xff, off, off + 188);
  buf[off] = 0x47;
  buf[off + 1] = ((pusi ? 1 : 0) << 6) | ((pid >> 8) & 0x1f);
  buf[off + 2] = pid & 0xff;
  buf[off + 3] = (afc << 4) | (cc & 0x0f);
  let pos = off + 4;
  if (afc & 2) {
    const bodyLen = pcr !== null ? 6 : 0;
    buf[pos] = 1 + bodyLen;
    buf[pos + 1] = pcr !== null ? 0x10 : 0;
    if (pcr !== null) {
      const base = pcr / 300n;
      const ext = pcr % 300n;
      buf[pos + 2] = Number((base >> 25n) & 0xffn);
      buf[pos + 3] = Number((base >> 17n) & 0xffn);
      buf[pos + 4] = Number((base >> 9n) & 0xffn);
      buf[pos + 5] = Number((base >> 1n) & 0xffn);
      buf[pos + 6] = Number(((base & 1n) << 7n) | ((ext >> 8n) & 1n));
      buf[pos + 7] = Number(ext & 0xffn);
    }
    pos = off + 5 + buf[off + 4];
  }
  if ((afc & 1) && pts !== null) {
    buf[pos] = 0; buf[pos + 1] = 0; buf[pos + 2] = 1; buf[pos + 3] = 0xe0;
    buf[pos + 4] = 0; buf[pos + 5] = 14;
    buf[pos + 6] = 0x80; buf[pos + 7] = 0x80; buf[pos + 8] = 5;
    buf[pos + 9] = 0x21 | Number(((pts >> 30n) & 7n) << 1n);
    buf[pos + 10] = Number((pts >> 22n) & 0xffn);
    buf[pos + 11] = 0x01 | Number(((pts >> 15n) & 0x7fn) << 1n);
    buf[pos + 12] = Number((pts >> 7n) & 0xffn);
    buf[pos + 13] = 0x01 | Number((pts & 0x7fn) << 1n);
  }
}

const t0 = performance.now();
for (let i = 0; i < packets; i++) {
  const cc = i % 16;
  // PID 0x101 with PCR every 10 packets, PTS every 30; sprinkle a few gaps
  const pid = 0x101;
  const pcr = i % 10 === 0 ? BigInt(i) * 27000n : null;
  const pts = i % 30 === 0 ? BigInt(i) * 3000n : null;
  writePacket(i, pid, cc, { pusi: pts !== null, afc: pcr !== null ? 3 : 1, pcr, pts });
}
const t1 = performance.now();

const r = analyze(buf.buffer);
const t2 = performance.now();

console.log(`packets: ${r.packetCount} (${(buf.byteLength / 1048576).toFixed(1)} MB)`);
console.log(`build: ${(t1 - t0).toFixed(0)} ms`);
console.log(`analyze: ${(t2 - t1).toFixed(0)} ms`);
console.log(`pcr samples: ${r.pcrSamples.length}, pts samples: ${r.ptsSamples.length}`);
console.log(`anomalies: ${r.anomalies.length}`);
console.log(`clock points: ${r.clockPoints.length}`);
// Memory: rows are plain objects, check a rough footprint
console.log(`throughput: ${(r.packetCount / ((t2 - t1) / 1000) / 1000).toFixed(0)}k packets/s`);
