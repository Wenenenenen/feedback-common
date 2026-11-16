// zip.test.mjs — archive writer/reader round trips and interoperability.
// Run with: node --test tests/zip.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeZip, readZip, crc32 } from '../app/js/zip.js';

const enc = (s) => new TextEncoder().encode(s);

test('zip: round trip preserves names and bytes', async () => {
  const entries = [
    { name: 'README.txt', data: enc('hello 世界') },
    { name: 'dir/left.png', data: new Uint8Array(1000).map((_, i) => i & 255) },
    { name: 'empty.bin', data: new Uint8Array(0) },
  ];
  const zip = await makeZip(entries);
  const back = await readZip(zip);
  assert.deepEqual(back.map((e) => e.name), ['README.txt', 'dir/left.png', 'empty.bin']);
  assert.equal(new TextDecoder().decode(back[0].data), 'hello 世界');
  assert.deepEqual([...back[1].data], [...entries[1].data]);
  assert.equal(back[2].data.length, 0);
});

test('zip: store mode is used verbatim and deflate shrinks repetitive data', async () => {
  const patterns = new Uint8Array(50000);
  for (let i = 0; i < patterns.length; i++) patterns[i] = i % 7;
  const zip = await makeZip([{ name: 'p.bin', data: patterns }]);
  assert.ok(zip.length < patterns.length, `expected compression, got ${zip.length}`);
  const back = await readZip(zip);
  assert.deepEqual([...back[0].data], [...patterns]);

  const store = await makeZip([{ name: 'p.bin', data: patterns, compress: 'store' }]);
  assert.ok(store.length > patterns.length, 'store keeps raw bytes');
  assert.deepEqual([...(await readZip(store))[0].data], [...patterns]);
});

test('zip: system unzip accepts the archive', async () => {
  const zip = await makeZip([
    { name: 'a.txt', data: enc('alpha') },
    { name: 'b/c.txt', data: enc('beta') },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'sdf-zip-'));
  const file = join(dir, 'out.zip');
  writeFileSync(file, zip);
  execFileSync('unzip', ['-t', file], { stdio: 'ignore' });
  execFileSync('unzip', ['-q', file, '-d', join(dir, 'x')]);
  assert.equal(readFileSync(join(dir, 'x', 'a.txt'), 'utf8'), 'alpha');
  assert.equal(readFileSync(join(dir, 'x', 'b', 'c.txt'), 'utf8'), 'beta');
});

test('zip: truncation and corruption are reported', async () => {
  const zip = await makeZip([{ name: 'a.txt', data: enc('alpha'.repeat(200)) }]);
  await assert.rejects(() => readZip(zip.subarray(0, zip.length - 30)), /截断|中央目录/);
  const bad = zip.slice();
  bad[40] ^= 0xff;
  await assert.rejects(() => readZip(bad), /CRC|解压|长度|损坏/);
});

test('zip: duplicate and traversal entry names are refused', async () => {
  await assert.rejects(() => makeZip([{ name: 'a', data: enc('1') }, { name: 'a', data: enc('2') }]), /重复/);
  await assert.rejects(() => makeZip([{ name: '../evil', data: enc('1') }]), /无效/);
  await assert.rejects(() => makeZip([{ name: '/abs', data: enc('1') }]), /无效/);
  await assert.rejects(() => makeZip([]), /至少/);
});

test('zip: crc32 matches the standard test value', () => {
  assert.equal(crc32(enc('123456789')), 0xcbf43926);
});
