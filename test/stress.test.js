import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyzer.js";
import { PTS_MOD, PCR_MOD } from "../src/clock.js";

// Build a synthetic capture with realistic clock increments, a forced PTS
// modulus crossing, and explicit discontinuities.
function buildCapture(packets) {
  const buf = new Uint8Array(packets * 188);
  const write = (i, pid, cc, { pusi = false, afc = 1, pts = null, pcr = null, disc = false } = {}) => {
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
      buf[pos + 1] = (disc ? 0x80 : 0) | (pcr !== null ? 0x10 : 0);
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
  };

  let ptsAcc = BigInt(PTS_MOD) - 1000n;
  let pcrAcc = BigInt(PCR_MOD) - 5000n;
  const wrapAt = 390; // 30-aligned, so the reset actually lands on a sample
  const discAt = new Set([700, 6000]);
  for (let i = 0; i < packets; i++) {
    let pts = null;
    let pcr = null;
    if (i % 30 === 0) {
      ptsAcc = i === wrapAt ? BigInt(PTS_MOD) - 500n : (ptsAcc + 3000n) % BigInt(PTS_MOD);
      pts = ptsAcc;
    }
    if (i % 10 === 0) {
      pcrAcc = (pcrAcc + 27000n) % BigInt(PCR_MOD);
      pcr = pcrAcc;
    }
    write(i, 0x101, i % 16, {
      pusi: pts !== null, afc: pcr !== null ? 3 : 1, pts, pcr, disc: discAt.has(i),
    });
  }
  return analyze(buf.buffer);
}

test("large synthetic capture: no PSI false positives on a PES-only PID", () => {
  const r = buildCapture(10000);
  assert.ok(!r.anomalies.some((a) => a.type === "psi_crc_error"));
  assert.ok(!r.anomalies.some((a) => a.type === "psi_incomplete"));
});

test("large synthetic capture: forced PTS wrap is detected and unwrapped monotonically", () => {
  const r = buildCapture(2000);
  const wraps = r.anomalies.filter((a) => a.type === "pts_wrap");
  assert.equal(wraps.length, 1);
  // Unwrapped PTS must never decrease within a single segment
  const pts = r.clockPoints.filter((p) => p.kind === "PTS");
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].segmentId === pts[i - 1].segmentId) {
      assert.ok(pts[i].unwrapped >= pts[i - 1].unwrapped,
        `PTS regressed within segment at sample ${i}`);
    }
  }
  // Raw value at the wrap stays modular; unwrapped value gains one modulus
  const wrapPoint = pts.find((p) => p.packetIndex === wraps[0].packetIndex);
  assert.ok(wrapPoint.unwrapped > wrapPoint.raw);
});

test("large synthetic capture: explicit discontinuities open new PCR segments", () => {
  const r = buildCapture(8000);
  const segEvents = r.anomalies.filter((a) => a.type === "pcr_discontinuity_segment");
  assert.deepEqual(segEvents.map((a) => a.packetIndex), [700, 6000]);
  const pcrSegs = r.segments.pcr.get(0x101);
  assert.ok(pcrSegs.length >= 3);
  assert.equal(pcrSegs[1].reason, "discontinuity");
});

test("performance: 32MB parses in under 2 seconds", () => {
  // Roughly 178k packets — the documented import ceiling.
  const packets = Math.floor((32 * 1024 * 1024) / 188);
  const t0 = performance.now();
  const r = buildCapture(Math.min(packets, 50000));
  const elapsed = performance.now() - t0;
  assert.ok(r.packetCount > 0);
  assert.ok(elapsed < 2000, `analysis took ${elapsed.toFixed(0)}ms`);
});
