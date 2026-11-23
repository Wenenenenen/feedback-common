// tests/protocol.test.js — 线格式与编解码
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crc32, encodePackets, parsePacket, sortRecords,
  HEADER_SIZE, CRC_SIZE, MAX_PAYLOAD, RECORD_UPD_SIZE,
} from '../js/engine.js';

test('CRC32/IEEE 校验已知向量', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0x00000000);
});

test('空记录也发一片，total=1 且载荷为空', () => {
  const pkts = encodePackets(5, 7, []);
  assert.equal(pkts.length, 1);
  assert.equal(pkts[0].length, HEADER_SIZE + CRC_SIZE);
  const p = parsePacket(pkts[0]);
  assert.equal(p.ok, true);
  assert.deepEqual([p.tick, p.base, p.index, p.total], [5, 7, 0, 1]);
  assert.deepEqual(p.records, []);
});

test('全量分片：片头字段、载荷上限、记录可还原', () => {
  const n = 100; // 100*17=1700 -> ceil(1700/256)=7 片
  const recs = Array.from({ length: n }, (_, i) => ({
    tag: 1, id: i + 1, gen: 1, x: i * 3 - 50, y: -i,
  }));
  const pkts = encodePackets(9, 0, recs);
  assert.ok(pkts.length >= 7);
  for (const pkt of pkts) assert.ok(pkt.length - HEADER_SIZE - CRC_SIZE <= MAX_PAYLOAD);
  const all = [];
  pkts.forEach((pkt, i) => {
    const p = parsePacket(pkt);
    assert.equal(p.ok, true);
    assert.equal(p.tick, 9);
    assert.equal(p.base, 0);
    assert.equal(p.index, i);
    assert.equal(p.total, pkts.length);
    all.push(...p.records);
  });
  assert.equal(all.length, n);
  assert.deepEqual(all.map(r => r.id), recs.map(r => r.id)); // id 升序
  assert.deepEqual(all[3], { tag: 1, id: 4, gen: 1, x: -41, y: -3 });
});

test('256 字节边界：15 条更新恰好一片，16 条两片', () => {
  const mk = n => Array.from({ length: n }, (_, i) => ({ tag: 1, id: i + 1, gen: 1, x: 0, y: 0 }));
  assert.equal(encodePackets(1, 0, mk(15)).length, 1);
  assert.equal(encodePackets(1, 0, mk(16)).length, 2);
});

test('记录排序：同 id 删除在前，整体按 id 升序', () => {
  const recs = [
    { tag: 1, id: 9, gen: 2, x: 1, y: 1 },
    { tag: 0, id: 3, gen: 1 },
    { tag: 0, id: 9, gen: 1 },
    { tag: 1, id: 1, gen: 1, x: 0, y: 0 },
  ];
  sortRecords(recs);
  assert.deepEqual(recs.map(r => [r.id, r.tag]), [[1, 1], [3, 0], [9, 0], [9, 1]]);
});

test('损坏一字节即 CRC 失败', () => {
  const pkts = encodePackets(1, 0, [{ tag: 1, id: 1, gen: 1, x: 0, y: 0 }]);
  const bad = pkts[0].slice();
  bad[HEADER_SIZE] ^= 0x01;
  assert.equal(parsePacket(bad).ok, false);
  assert.equal(parsePacket(bad).reason, 'crc');
});

test('全量包内出现删除记录被拒收', () => {
  // 手工构造 base=0 且 tag=0 的包
  const pkt = new Uint8Array(HEADER_SIZE + 9 + CRC_SIZE);
  const v = new DataView(pkt.buffer);
  v.setUint32(0, 1, true); v.setUint32(4, 0, true);
  v.setUint16(8, 0, true); v.setUint16(10, 1, true);
  pkt[HEADER_SIZE] = 0;
  v.setUint32(HEADER_SIZE + 1, 7, true);
  v.setUint32(HEADER_SIZE + 5, 1, true);
  v.setUint32(HEADER_SIZE + 9, crc32(pkt, 0, HEADER_SIZE + 9), true);
  assert.equal(parsePacket(pkt).reason, 'full-has-delete');
});

test('截断与坏 index 被拒收', () => {
  assert.equal(parsePacket(new Uint8Array(10)).ok, false);
  const pkts = encodePackets(1, 0, [{ tag: 1, id: 1, gen: 1, x: 0, y: 0 }]);
  const bad = pkts[0].slice();
  new DataView(bad.buffer).setUint16(8, 5, true); // index=5, total=1
  assert.equal(parsePacket(bad).reason, 'bad-header');
});

test('同 id 两条更新在全量中被拒收（全量 id 必须唯一）', () => {
  const recs = [
    { tag: 1, id: 1, gen: 1, x: 0, y: 0 },
    { tag: 1, id: 1, gen: 2, x: 1, y: 1 },
  ];
  const pkts = encodePackets(1, 0, recs);
  const results = pkts.map(p => parsePacket(p).ok);
  assert.ok(results.some(ok => ok === false));
});
