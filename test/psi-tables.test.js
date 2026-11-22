import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32Mpeg } from "../src/crc32.js";
import { PsiAssembler } from "../src/psi-tables.js";
import { TS_PACKET_SIZE, SYNC_BYTE } from "../src/ts-parser.js";

// Build a PAT or PMT section with a correct CRC32.
function patSection(version = 0, currentNext = 1, programs = [[1, 0x100]]) {
  const body = [
    0x00, // table_id PAT
    0xb0, // section_syntax + reserved, high nibble of length (filled later)
    0x00,
    0x00, 0x01, // transport_stream_id
    (0x01 << 6) | ((version & 0x1f) << 1) | (currentNext & 1),
    0x00, // section_number
    0x00, // last_section_number
  ];
  for (const [prog, pid] of programs) {
    body.push((prog >> 8) & 0xff, prog & 0xff, 0xe0 | ((pid >> 8) & 0x1f), pid & 0xff);
  }
  const secLen = body.length - 3 + 4; // bytes after the length field incl CRC
  body[1] = 0xb0 | ((secLen >> 8) & 0x0f);
  body[2] = secLen & 0xff;
  const sec = new Uint8Array(body.length + 4);
  sec.set(body, 0);
  const crc = crc32Mpeg(sec.subarray(0, body.length));
  sec[body.length] = (crc >> 24) & 0xff;
  sec[body.length + 1] = (crc >> 16) & 0xff;
  sec[body.length + 2] = (crc >> 8) & 0xff;
  sec[body.length + 3] = crc & 0xff;
  return sec;
}

function pmtSection(version, currentNext, { programNumber = 1, pcrPid = 0x101, streams = [[0x1b, 0x101]] } = {}) {
  const body = [
    0x02,
    0xb0, 0x00,
    (programNumber >> 8) & 0xff, programNumber & 0xff,
    (0x01 << 6) | ((version & 0x1f) << 1) | (currentNext & 1),
    0x00, 0x00,
    0xe0 | ((pcrPid >> 8) & 0x1f), pcrPid & 0xff,
    0xf0, 0x00, // program_info_length 0
  ];
  for (const [stype, pid] of streams) {
    body.push(stype, 0xe0 | ((pid >> 8) & 0x1f), pid & 0xff, 0xf0, 0x00);
  }
  const secLen = body.length - 3 + 4;
  body[1] = 0xb0 | ((secLen >> 8) & 0x0f);
  body[2] = secLen & 0xff;
  const sec = new Uint8Array(body.length + 4);
  sec.set(body, 0);
  const crc = crc32Mpeg(sec.subarray(0, body.length));
  sec[body.length] = (crc >> 24) & 0xff;
  sec[body.length + 1] = (crc >> 16) & 0xff;
  sec[body.length + 2] = (crc >> 8) & 0xff;
  sec[body.length + 3] = crc & 0xff;
  return sec;
}

// Split a section (with pointer_field 0 prefix) across TS packets of a PID.
function psiPackets(pid, section, { ccStart = 0, badCrc = false } = {}) {
  const data = new Uint8Array(section.length + 1);
  data[0] = 0x00; // pointer_field
  data.set(section, 1);
  if (badCrc) data[data.length - 1] ^= 0xff;
  const packets = [];
  let pos = 0;
  let cc = ccStart;
  let first = true;
  while (pos < data.length) {
    const p = new Uint8Array(TS_PACKET_SIZE).fill(0xff);
    p[0] = SYNC_BYTE;
    p[1] = (first ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
    p[2] = pid & 0xff;
    p[3] = 0x10 | (cc & 0x0f);
    const room = TS_PACKET_SIZE - 4;
    const chunk = data.subarray(pos, Math.min(data.length, pos + room));
    p.set(chunk, 4);
    packets.push(p);
    pos += room;
    cc = (cc + 1) & 0x0f;
    first = false;
  }
  return packets;
}

function feedAll(psi, packets, pid) {
  const bytes = concat(...packets);
  packets.forEach((pkt, i) => {
    const pusi = !!(pkt[1] & 0x40);
    const cc = pkt[3] & 0x0f;
    psi.feed({
      index: i, pid, pusi, hasPayload: true,
      payloadStart: 4, payloadLength: 184, offset: i * 188,
    }, bytes);
  });
}

test("single-packet PAT accepted and applied", () => {
  const psi = new PsiAssembler();
  const pkts = psiPackets(0, patSection(0, 1, [[1, 0x100]]));
  feedAll(psi, pkts, 0);
  assert.equal(psi.sections.length, 1);
  assert.equal(psi.sections[0].crcOk, true);
  assert.deepEqual(psi.currentPat.programs.get(1), 0x100);
  const map = psi.mapAt(0);
  assert.equal(map.programs[0].programNumber, 1);
});

test("CRC-bad PMT never updates the program relationship", () => {
  const psi = new PsiAssembler();
  feedAll(psi, psiPackets(0, patSection(0, 1, [[1, 0x100]])), 0);
  // good PMT v0: pcr/stream pid 0x101
  feedAll(psi, psiPackets(0x100, pmtSection(0, 1, { pcrPid: 0x101, streams: [[0x1b, 0x101]] }), { ccStart: 0 }), 0x100);
  assert.equal(psi.mapAt(99).programs[0].pcrPid, 0x101);
  // bad CRC PMT v1 trying to switch to 0x102
  const bad = psiPackets(0x100, pmtSection(1, 1, { pcrPid: 0x102, streams: [[0x1b, 0x102]] }), { ccStart: 1, badCrc: true });
  feedAll(psi, bad, 0x100);
  assert.equal(psi.crcFailures.length, 1);
  // old good map stays in force
  assert.equal(psi.mapAt(199).programs[0].pcrPid, 0x101);
  assert.deepEqual(psi.mapAt(199).programs[0].streams, [{ streamType: 0x1b, elementaryPid: 0x101 }]);
  // good PMT v1 now applies the switch
  const good = psiPackets(0x100, pmtSection(1, 1, { pcrPid: 0x102, streams: [[0x1b, 0x102]] }), { ccStart: 2 });
  feedAll(psi, good, 0x100);
  assert.equal(psi.mapAt(299).programs[0].pcrPid, 0x102);
});

test("section spanning multiple packets reassembles", () => {
  const psi = new PsiAssembler();
  // pad the PMT with several streams so it exceeds one payload
  const streams = [];
  for (let i = 0; i < 40; i++) streams.push([0x1b, 0x200 + i]);
  const sec = pmtSection(0, 1, { pcrPid: 0x101, streams });
  const pkts = psiPackets(0x100, sec);
  assert.ok(pkts.length >= 2, "test section should span packets");
  feedAll(psi, pkts, 0x100);
  assert.equal(psi.sections.length, 1);
  assert.equal(psi.sections[0].crcOk, true);
  assert.equal(psi.currentPmts.get(0x100).streams.length, 40);
});

test("next table (current_next=0) is recorded but not applied", () => {
  const psi = new PsiAssembler();
  feedAll(psi, psiPackets(0, patSection(0, 1, [[1, 0x100]])), 0);
  feedAll(psi, psiPackets(0x100, pmtSection(1, 0, { pcrPid: 0x102, streams: [[0x1b, 0x102]] })), 0x100);
  assert.equal(psi.sections[0].currentNext, true);
  assert.equal(psi.sections[1].currentNext, false);
  assert.equal(psi.currentPmts.has(0x100), false);
});

test("PAT then PMT timeline yields full program map", () => {
  const psi = new PsiAssembler();
  feedAll(psi, psiPackets(0, patSection(0, 1, [[1, 0x100]])), 0);
  feedAll(psi, psiPackets(0x100, pmtSection(0, 1, { pcrPid: 0x101, streams: [[0x1b, 0x101], [0x0f, 0x102]] })), 0x100);
  const map = psi.mapAt(10);
  assert.equal(map.ready, true);
  assert.equal(map.programs[0].pmtPid, 0x100);
  assert.equal(map.programs[0].streams.length, 2);
});

function concat(...arrays) {
  const n = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}
