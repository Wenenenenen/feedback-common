// Synthetic matrix tests: endianness, layouts, orientations, predictors,
// missing / corrupt / out-of-bounds tiles, edge-tile padding and cache size.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { TiffReader, STATUS, CACHE_LIMIT } = require('../js/tiff.js');

const DIR = process.env.CASES_DIR || path.join(__dirname, '..', '.cache', 'synthetic');
const cases = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8'));

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + (e && e.stack || e)); process.exitCode = 1; }
}
function bytesOf(name) {
  return new Uint8Array(fs.readFileSync(path.join(DIR, name + '.tif')));
}
async function load(name) {
  return TiffReader.fromBytes(bytesOf(name), { name });
}

// --- patch helpers used to build the broken variants ---------------------

function findMainIfd(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 0x49;
  const magic = dv.getUint16(2, little);
  const big = magic === 43;
  const off = big ? Number(dv.getBigUint64(8, little)) : dv.getUint32(4, little);
  const n = big ? Number(dv.getBigUint64(off, little)) : dv.getUint16(off, little);
  const start = off + (big ? 8 : 2);
  const esz = big ? 20 : 12;
  return { dv, little, big, n, start, esz, off };
}

function tagEntryLocation(bytes, wanted) {
  const { dv, little, big, n, start, esz } = findMainIfd(bytes);
  const size = big ? 8 : 4;
  for (let i = 0; i < n; i++) {
    const p = start + i * esz;
    const tag = dv.getUint16(p, little);
    if (tag === wanted) {
      const count = big ? Number(dv.getBigUint64(p + 4, little)) : dv.getUint32(p + 4, little);
      const valueField = p + (big ? 12 : 8);
      const total = size * count;
      const arrayPos = total > size
        ? Number(big ? dv.getBigUint64(valueField, little) : dv.getUint32(valueField, little))
        : valueField;
      return { dv, little, big, size, count, arrayPos };
    }
  }
  throw new Error('tag ' + wanted + ' not found');
}

function patchTileEntry(bytes, index, offset, count) {
  const a = tagEntryLocation(bytes, 324);
  if (offset != null) {
    if (a.big) a.dv.setBigUint64(a.arrayPos + index * 8, BigInt(offset), a.little);
    else a.dv.setUint32(a.arrayPos + index * 4, offset, a.little);
  }
  if (count != null) {
    const b = tagEntryLocation(bytes, 325);
    if (b.big) b.dv.setBigUint64(b.arrayPos + index * 8, BigInt(count), b.little);
    else b.dv.setUint32(b.arrayPos + index * 4, count, b.little);
  }
}

function patchCycle(bytes) {
  const { dv, little, big, n, start, esz, off } = findMainIfd(bytes);
  const nextPos = start + n * esz;
  if (big) dv.setBigUint64(nextPos, BigInt(off), little);
  else dv.setUint32(nextPos, off, little);
}

// --- matrix --------------------------------------------------------------

(async () => {
  for (const kase of cases) {
    if (kase.name === 'le_classic_gray_corrupt' || kase.name === 'le_classic_gray_oob') continue;
    await test(kase.name + ': samples match', async () => {
      const r = await load(kase.name);
      const d = r.layers[0];
      assert.equal(r.big, kase.big, 'big');
      assert.equal(r.littleEndian, kase.little, 'little endian');
      assert.equal(d.spp, kase.spp);
      assert.equal(d.planar, kase.planar);
      assert.equal(d.predictor, kase.predictor);
      assert.deepEqual(r.displaySize(d), {
        width: kase.displaySize[0], height: kase.displaySize[1]
      });
      for (const s of kase.samples) {
        const p = await r.pixelAt(d, s.display[0], s.display[1]);
        assert.deepEqual(p.storage, { x: s.storage[0], y: s.storage[1] }, 'storage coord');
        assert.deepEqual(p.channels, s.values, 'values at ' + s.display);
      }
    });
  }

  await test('missing channel tile: pixel zeroed, mask 0, other channels intact', async () => {
    const kase = cases.find((c) => c.name === 'le_classic_rgb_planar_missing_channel');
    const r = await load(kase.name);
    const d = r.layers[0];
    const res = await r.readRoi(d, { x: 16, y: 0, width: 16, height: 16 });
    assert.deepEqual(res.missingTiles, [7]);
    assert.ok(Array.from(res.mask).every((v) => v === 0));
    assert.ok(Array.from(res.values).every((v) => v === 0), 'all channels zeroed');
    assert.ok(res.tileDetails.some((t) => t.index === 7 && t.status === STATUS.MISSING));
    // the raw buffer keeps the present channels for inspection
    assert.ok(Array.from(res.raw).some((v) => v > 0));
    const ok = await r.readRoi(d, { x: 0, y: 0, width: 4, height: 4 });
    assert.ok(Array.from(ok.mask).every((v) => v === 1));
  });

  await test('corrupt tile reported with its block number', async () => {
    const bytes = bytesOf('le_classic_gray_corrupt');
    const r0 = await TiffReader.fromBytes(bytes.slice(), {});
    const d0 = r0.layers[0];
    const off = d0.tileOffsets[1];
    const cnt = d0.tileCounts[1];
    for (let i = 0; i < cnt; i++) bytes[off + i] = 0xff;
    const r = await TiffReader.fromBytes(bytes, {});
    const d = r.layers[0];
    const res = await r.readRoi(d, { x: 16, y: 0, width: 16, height: 16 });
    assert.deepEqual(res.corruptTiles, [1]);
    assert.ok(Array.from(res.mask).every((v) => v === 0));
    const detail = res.tileDetails.find((t) => t.index === 1);
    assert.equal(detail.status, STATUS.CORRUPT);
    assert.ok(/解压|长度|inflate|invalid|unexpected/i.test(detail.error));
  });

  await test('out-of-bounds tile offset reported, never read', async () => {
    const bytes = bytesOf('le_classic_gray_oob');
    patchTileEntry(bytes, 2, 0x7ffffff0, 1000);
    const r = await TiffReader.fromBytes(bytes, {});
    const d = r.layers[0];
    const res = await r.readRoi(d, { x: 0, y: 16, width: 16, height: 16 });
    assert.deepEqual(res.oobTiles, [2]);
    assert.ok(Array.from(res.mask).every((v) => v === 0));
    assert.equal(res.decodes, 0, 'a bad tile must not be decoded');
    assert.equal(res.stats.tileBytes, 0);
  });

  await test('zero offset with nonzero count is invalid, not missing', async () => {
    const bytes = bytesOf('le_classic_gray_oob');
    patchTileEntry(bytes, 3, 0, 40);
    const r = await TiffReader.fromBytes(bytes, {});
    const d = r.layers[0];
    const res = await r.readRoi(d, { x: 16, y: 16, width: 16, height: 16 });
    assert.deepEqual(res.invalidTiles, [3]);
    assert.deepEqual(res.missingTiles, []);
    assert.ok(Array.from(res.mask).every((v) => v === 0));
  });

  await test('nonzero offset with zero count is invalid', async () => {
    const bytes = bytesOf('le_classic_gray_oob');
    patchTileEntry(bytes, 0, 40, 0);
    const r = await TiffReader.fromBytes(bytes, {});
    const d = r.layers[0];
    const res = await r.readRoi(d, { x: 0, y: 0, width: 8, height: 8 });
    assert.deepEqual(res.invalidTiles, [0]);
    assert.equal(res.decodes, 0);
  });

  await test('directory cycle reported once with the repeated offset', async () => {
    const bytes = bytesOf('le_classic_gray_edge_tiles');
    patchCycle(bytes);
    const r = await TiffReader.fromBytes(bytes, {});
    const cycles = r.errors.filter((e) => /循环/.test(e.message));
    assert.equal(cycles.length, 1);
    assert.ok(cycles[0].offset > 0);
    assert.equal(r.layers.length, 1);
  });

  await test('offset into the header is out of bounds', async () => {
    const bytes = bytesOf('le_classic_gray_oob');
    patchTileEntry(bytes, 1, 2, 40);
    const r = await TiffReader.fromBytes(bytes, {});
    const res = await r.readRoi(r.layers[0], { x: 16, y: 0, width: 8, height: 8 });
    assert.deepEqual(res.oobTiles, [1]);
  });

  await test('edge tiles decode at full size and crop correctly', async () => {
    const r = await load('le_classic_gray_edge_tiles');
    const d = r.layers[0];
    const res = await r.readRoi(d, { x: 32, y: 16, width: 5, height: 7 });
    assert.equal(res.width, 5);
    assert.equal(res.height, 7);
    assert.ok(Array.from(res.mask).every((v) => v === 1));
  });

  await test('ROI size is capped at 1024×1024', async () => {
    const r = await load('le_classic_gray_edge_tiles');
    const d = r.layers[0];
    await assert.rejects(r.readRoi(d, { x: 0, y: 0, width: 1025, height: 10 }), /1024/);
  });

  await test('subIFD overview is addressable in its own display space', async () => {
    const kase = cases.find((c) => c.name === 'be_big_rgb_orient6_subifd');
    const r = await load(kase.name);
    assert.ok(r.layers.length >= 2);
    const sub = r.layers.find((d) => d.kind === 'sub');
    assert.ok(sub, 'sub layer');
    assert.deepEqual(r.displaySize(sub), {
      width: kase.subDisplaySize[0], height: kase.subDisplaySize[1]
    });
    for (const s of kase.subSamples) {
      const p = await r.pixelAt(sub, s.display[0], s.display[1]);
      assert.deepEqual(p.storage, { x: s.storage[0], y: s.storage[1] });
      assert.deepEqual(p.channels, s.values);
    }
    const res = await r.readRoi(sub, { x: 0, y: 0, width: 11, height: 18 });
    assert.ok(res.hitTiles.length > 0);
    assert.ok(res.decodes <= 6);
  });

  await test('decoded-block cache never exceeds 32 blocks', async () => {
    const r = await load('le_classic_gray_edge_tiles');
    const d = r.layers[0];
    for (let y = 0; y < d.height; y += 3) {
      for (let x = 0; x < d.width; x += 3) await r.pixelAt(d, x, y);
    }
    assert.ok(r.cacheSize() <= CACHE_LIMIT, 'cache size ' + r.cacheSize());
  });

  await test('orientation round-trips for tags 3, 6, 8', async () => {
    for (const name of ['le_classic_rgb_orient3_chunky', 'le_big_rgb_orient6_chunky',
      'le_big_rgb_orient8_chunky']) {
      const r = await load(name);
      const d = r.layers[0];
      const ds = r.displaySize(d);
      for (let y = 0; y < ds.height; y += 5) {
        for (let x = 0; x < ds.width; x += 5) {
          const s = r.displayToStorage(d, x, y);
          assert.deepEqual(r.storageToDisplay(d, s.x, s.y), { x, y },
            name + ' at ' + x + ',' + y);
        }
      }
    }
  });

  if (process.exitCode) console.error('\n' + passed + ' passed, failures above');
  else console.log('\nall ' + passed + ' tests passed');
})();
