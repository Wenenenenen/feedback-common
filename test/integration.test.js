import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyze } from "../src/analyzer.js";
import { Issue } from "../src/ts-parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, "..", "samples");

async function load(name) {
  // Samples are checked-in fixtures; read as a raw ArrayBuffer.
  const b = await readFile(join(samples, name));
  return analyze(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const types = (r) => new Set(r.anomalies.map((a) => a.type));

test("framing.ts: leading offset and trailing 179-byte partial packet", async () => {
  const r = await load("framing.ts");
  assert.equal(r.firstSyncOffset, 3);
  assert.equal(r.trailingBytes, 179);
  const t = types(r);
  assert.ok(t.has(Issue.SYNC_LOST));
  assert.ok(t.has(Issue.TRUNCATED_PACKET));
  // Packet indexing counts only full 188-byte packets, from zero
  assert.equal(r.packets[0].index, 0);
  assert.equal(r.packets[0].offset, 3);
});

test("reorder.ts: duplicate and adaptation-only handling", async () => {
  const r = await load("reorder.ts");
  const t = types(r);
  assert.ok(t.has(Issue.EXACT_DUPLICATE), "packet #4 is an exact duplicate");
  assert.ok(t.has(Issue.ADAPTATION_ONLY), "packet #5 is adaptation-only");

  const dup = r.anomalies.find((a) => a.type === Issue.EXACT_DUPLICATE);
  assert.equal(dup.packetIndex, 4);

  // Adaptation-only packet must NOT itself be a CC gap, and the packet after
  // it (#6, CC F) follows the held baseline E normally.
  assert.ok(!r.packets[5].issues.includes(Issue.CC_GAP));
  assert.ok(!r.packets[6].issues.includes(Issue.CC_GAP));

  // #6 CC F -> #7 CC 0 is a legal modulo wraparound, NOT a detectable gap:
  // the spec forbids inventing a missing packet when the CC simply wraps.
  assert.ok(!r.packets[7].issues.includes(Issue.CC_GAP));
});

test("switch.ts: a non-wraparound CC jump detects the missing packet at #7", async () => {
  const r = await load("switch.ts");
  // #6 CC F, #7 CC 1 with no CC 0 in between -> exactly one payload packet lost
  const gap = r.anomalies.find((a) => a.type === Issue.CC_GAP && a.packetIndex === 7);
  assert.ok(gap);
  assert.match(gap.detail, /1 packet\(s\) missing/);
});

test("reorder.ts: wrap vs small PTS backward step are distinguished", async () => {
  const r = await load("reorder.ts");
  const t = types(r);
  // PTS near 2^33 (8589934582) then 5: crossed the modulus boundary = wrap
  const wrap = r.anomalies.find((a) => a.type === "pts_wrap");
  assert.ok(wrap, "PTS 2^33-10 -> 5 should be a wrap");
  assert.equal(wrap.packetIndex, 6);
  // ...then 20 -> 2 at packet #7: small backward step, classified regression
  const reg = r.anomalies.find((a) => a.type === "pts_regression");
  assert.ok(reg, "PTS 20 -> 2 should be a small regression");
  assert.equal(reg.packetIndex, 7);
  // Raw and unwrapped values both retained; the raw value stays modular
  const pts = r.clockPoints.filter((p) => p.kind === "PTS");
  assert.equal(pts[pts.length - 1].raw.toString(), "2");
  // After one wrap plus the regression, unwrapped value is PTS_MOD + 2
  assert.equal(pts[pts.length - 1].unwrapped.toString(), String(2 ** 33 + 2));
});

test("framing.ts / switch.ts: explicit discontinuity at packet #8", async () => {
  for (const name of ["framing.ts", "switch.ts"]) {
    const r = await load(name);
    const d = r.anomalies.find((a) => a.type === Issue.DISCONTINUITY);
    assert.ok(d, `${name} should contain a discontinuity`);
    assert.equal(d.packetIndex, 8);
  }
});

test("switch.ts: CRC-bad PMT at #9 cannot switch PID; good PMT at #10 does", async () => {
  const r = await load("switch.ts");
  const crc = r.anomalies.find((a) => a.type === "psi_crc_error");
  assert.ok(crc);
  assert.equal(crc.packetIndex, 9);

  // Map before #10 still points at PID 257
  const before = r.psi.mapAt(9);
  assert.equal(before.programs[0].pcrPid, 257);
  // Map at/after #10 switches to 258
  const after = r.psi.mapAt(10);
  assert.equal(after.programs[0].pcrPid, 258);
  assert.deepEqual(after.programs[0].streams, [{ streamType: 0x1b, elementaryPid: 258 }]);
});

test("switch.ts: clock wrap events and program-switch segments", async () => {
  const r = await load("switch.ts");
  const t = types(r);
  // PCR samples wrap 2^33*300 boundary (8589934572*300+... -> ~0)
  assert.ok(t.has("pcr_wrap"));
  // PTS starts near 2^33 then drops to 5: that is a wrap, not regression
  assert.ok(t.has("pts_wrap"));
  // PMT change at #10 removes PID 257 and introduces PID 258; each affected
  // clock series starts a program_switch segment at its next sample.
  const switchSegs = r.anomalies.filter((a) => a.type === "program_switch_segment");
  assert.ok(switchSegs.length >= 2, "both the removed and introduced PIDs get a segment");
  const pids = new Set(switchSegs.map((a) => a.pid));
  assert.ok(pids.has(257));
  assert.ok(pids.has(258));

  // PID 258's first clock point (PCR at #12) starts its own segment id 0
  const p258 = r.clockPoints.filter((p) => p.pid === 258);
  assert.ok(p258.length >= 1);
  assert.equal(p258[0].segmentId, 0);
  assert.equal(p258[0].packetIndex, 12);
});

test("all samples: every clock point keeps both raw and unwrapped values", async () => {
  for (const name of ["framing.ts", "reorder.ts", "switch.ts"]) {
    const r = await load(name);
    for (const p of r.clockPoints) {
      assert.equal(typeof p.raw, "bigint");
      assert.equal(typeof p.unwrapped, "bigint");
      assert.ok(p.unwrapped >= p.raw);
      assert.equal(typeof p.seconds, "number");
      assert.equal(typeof p.segmentId, "number");
    }
  }
});

test("all samples: anomalies are sorted by packet index", async () => {
  for (const name of ["framing.ts", "reorder.ts", "switch.ts"]) {
    const r = await load(name);
    const idxs = r.anomalies.map((a) => a.packetIndex ?? -1);
    assert.deepEqual(idxs, [...idxs].sort((a, b) => a - b));
  }
});
