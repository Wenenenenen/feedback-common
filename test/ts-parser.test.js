import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTs, TS_PACKET_SIZE, SYNC_BYTE, Issue } from "../src/ts-parser.js";

// ---------- synthetic packet builders ----------
function tsPacket({
  pid = 0x100,
  pusi = false,
  afc = 1, // 1 payload only, 2 adaptation only, 3 both
  cc = 0,
  tei = false,
  payload = null,
  afFlags = 0,
  afBody = null, // extra adaptation bytes after flags (e.g. PCR)
}) {
  const p = new Uint8Array(TS_PACKET_SIZE).fill(0xff);
  p[0] = SYNC_BYTE;
  p[1] = ((tei ? 1 : 0) << 7) | ((pusi ? 1 : 0) << 6) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = (afc << 4) | (cc & 0x0f);
  let pos = 4;
  if (afc & 2) {
    const body = afBody ?? new Uint8Array(0);
    const afLen = 1 + body.length;
    p[4] = afLen;
    p[5] = afFlags;
    p.set(body, 6);
    pos = 5 + afLen;
  }
  if ((afc & 1) && payload) {
    p.set(payload.subarray(0, TS_PACKET_SIZE - pos), pos);
  }
  return p;
}

function pcrAfBody(pcr27) {
  const base = pcr27 / 300n;
  const ext = pcr27 % 300n;
  const b = new Uint8Array(6);
  b[0] = Number((base >> 25n) & 0xffn);
  b[1] = Number((base >> 17n) & 0xffn);
  b[2] = Number((base >> 9n) & 0xffn);
  b[3] = Number((base >> 1n) & 0xffn);
  b[4] = Number(((base & 1n) << 7n) | ((ext >> 8n) & 1n));
  b[5] = Number(ext & 0xffn);
  return b;
}

function pesPtsPacket(pid, cc, pts, { pusi = true, afc = 1 } = {}) {
  const payload = new Uint8Array(20);
  payload[0] = 0; payload[1] = 0; payload[2] = 1; payload[3] = 0xe0; // video
  payload[4] = 0; payload[5] = 14; // PES length
  payload[6] = 0x80; payload[7] = 0x80; // PTS_DTS_flags = 10
  payload[8] = 5; // header data length
  payload[9] = 0x21 | Number(((pts >> 30n) & 7n) << 1n);
  payload[10] = Number((pts >> 22n) & 0xffn);
  payload[11] = 0x01 | Number(((pts >> 15n) & 0x7fn) << 1n);
  payload[12] = Number((pts >> 7n) & 0xffn);
  payload[13] = 0x01 | Number((pts & 0x7fn) << 1n);
  payload[14] = 0;
  return tsPacket({ pid, pusi, afc, cc, payload });
}

test("parses basic packet fields", () => {
  const buf = tsPacket({ pid: 256, pusi: true, cc: 0xe, payload: new Uint8Array([1, 2, 3]) });
  const r = parseTs(buf.buffer);
  assert.equal(r.packetCount, 1);
  assert.equal(r.packets[0].pid, 256);
  assert.equal(r.packets[0].pusi, 1);
  assert.equal(r.packets[0].cc, 0xe);
  assert.equal(r.packets[0].payloadLength, 184);
});

test("leading junk before first sync is reported and skipped", () => {
  const lead = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const pkt = tsPacket({ pid: 0x100, cc: 0 });
  const all = concat(lead, pkt);
  const r = parseTs(all.buffer);
  assert.equal(r.firstSyncOffset, 3);
  assert.equal(r.packets[0].offset, 3);
  assert.ok(r.anomalies.some((a) => a.type === Issue.SYNC_LOST));
});

test("trailing partial packet is flagged", () => {
  const pkt = tsPacket({ pid: 0x100 });
  const partial = new Uint8Array(179).fill(0x47);
  const r = parseTs(concat(pkt, partial).buffer);
  assert.equal(r.packetCount, 1);
  assert.ok(r.anomalies.some((a) => a.type === Issue.TRUNCATED_PACKET));
  assert.equal(r.trailingBytes, 179);
});

test("exact duplicate packet detected", () => {
  const a = pesPtsPacket(0x101, 0xe, 12345n);
  const b = a.slice();
  const r = parseTs(concat(a, b).buffer);
  assert.ok(r.packets[1].issues.includes(Issue.EXACT_DUPLICATE));
  assert.ok(!r.packets[1].issues.includes(Issue.CC_GAP));
});

test("same CC with different content is flagged separately", () => {
  const a = pesPtsPacket(0x101, 0xe, 111n);
  const b = pesPtsPacket(0x101, 0xe, 222n);
  const r = parseTs(concat(a, b).buffer);
  assert.ok(r.packets[1].issues.includes(Issue.SAME_CC_DIFFERENT));
});

test("same-cc-different advances the baseline so the next packet is not a false gap", () => {
  const a = pesPtsPacket(0x101, 0xe, 111n);
  const b = pesPtsPacket(0x101, 0xe, 222n); // same CC, different content
  const c = pesPtsPacket(0x101, 0xf, 333n); // legal next CC
  const r = parseTs(concat(a, b, c).buffer);
  assert.ok(r.packets[1].issues.includes(Issue.SAME_CC_DIFFERENT));
  assert.ok(!r.packets[2].issues.includes(Issue.CC_GAP));
});

test("a duplicate hiding a later gap still exposes the gap", () => {
  // E (orig), E (exact dup), F, 0 -> F->0 is a legal wrap, no gap.
  // Build E, E(dup), F, 1 instead: the gap after F must be detected despite
  // the duplicate earlier in the sequence.
  const a = pesPtsPacket(0x101, 0xe, 1n);
  const dup = a.slice();
  const f = pesPtsPacket(0x101, 0xf, 2n);
  const one = pesPtsPacket(0x101, 0x1, 3n); // skips CC 0
  const r = parseTs(concat(a, dup, f, one).buffer);
  assert.ok(r.packets[1].issues.includes(Issue.EXACT_DUPLICATE));
  assert.ok(r.packets[3].issues.includes(Issue.CC_GAP));
});

test("adaptation-only packet keeps CC without a gap, but is marked", () => {
  const a = pesPtsPacket(0x101, 0xe, 1n);
  const only = tsPacket({ pid: 0x101, afc: 2, cc: 0xe, afFlags: 0x00 });
  const c = pesPtsPacket(0x101, 0xf, 2n);
  const r = parseTs(concat(a, only, c).buffer);
  assert.ok(r.packets[1].issues.includes(Issue.ADAPTATION_ONLY));
  assert.ok(!r.packets[1].issues.includes(Issue.CC_GAP));
  assert.ok(!r.packets[2].issues.includes(Issue.CC_GAP)); // F follows E normally
});

test("missing one packet inferred from CC jump", () => {
  const a = pesPtsPacket(0x101, 0xe, 1n);
  const b = pesPtsPacket(0x101, 0x0, 2n); // skips CC F
  const r = parseTs(concat(a, b).buffer);
  assert.ok(r.packets[1].issues.includes(Issue.CC_GAP));
  const an = r.anomalies.find((x) => x.type === Issue.CC_GAP);
  assert.match(an.detail, /1 packet\(s\) missing/);
});

test("CC wrap from F to 0 with no gap", () => {
  const a = pesPtsPacket(0x101, 0xf, 1n);
  const b = pesPtsPacket(0x101, 0x0, 2n);
  const r = parseTs(concat(a, b).buffer);
  assert.ok(!r.packets[1].issues.includes(Issue.CC_GAP));
});

test("explicit discontinuity indicator flagged", () => {
  const pkt = tsPacket({
    pid: 0x101, afc: 2, cc: 0, afFlags: 0x80,
    afBody: new Uint8Array(0),
  });
  const r = parseTs(pkt.buffer);
  assert.ok(r.packets[0].issues.includes(Issue.DISCONTINUITY));
});

test("PCR parsed from adaptation field", () => {
  const pkt = tsPacket({
    pid: 0x101, afc: 2, cc: 0, afFlags: 0x10,
    afBody: pcrAfBody(2576980371609n),
  });
  const r = parseTs(pkt.buffer);
  assert.equal(r.pcrSamples.length, 1);
  assert.equal(r.pcrSamples[0].value, 2576980371609n);
});

test("PES PTS parsed and DTS absent", () => {
  const pkt = pesPtsPacket(0x101, 0, 8589934582n);
  const r = parseTs(pkt.buffer);
  assert.equal(r.ptsSamples.length, 1);
  assert.equal(r.ptsSamples[0].value, 8589934582n);
  assert.equal(r.ptsSamples[0].kind, "PTS");
});

test("TEI is surfaced", () => {
  const pkt = tsPacket({ pid: 0x101, cc: 0, tei: true, payload: new Uint8Array(10) });
  const r = parseTs(pkt.buffer);
  assert.ok(r.packets[0].tei);
  assert.ok(r.anomalies.some((a) => a.type === Issue.TEI_SET));
});

test("resync after a lost sync byte", () => {
  const a = tsPacket({ pid: 0x101, cc: 0, payload: new Uint8Array(10) });
  const garbage = new Uint8Array(188).fill(0x00); // no sync anywhere
  const b = tsPacket({ pid: 0x102, cc: 0, payload: new Uint8Array(10) });
  const r = parseTs(concat(a, garbage, b).buffer);
  assert.ok(r.anomalies.some((x) => x.type === Issue.SYNC_LOST));
  assert.equal(r.packetCount, 2);
  assert.equal(r.packets[1].pid, 0x102);
});

function concat(...arrays) {
  const n = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}
