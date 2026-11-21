// Node tests for the TIFF core, driven by the provided sample archive.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { TiffReader, STATUS } = require('../js/tiff.js');

const SAMPLE_DIR = process.env.SAMPLE_DIR || path.join(__dirname, '..', '.untrusted-samples');
const truth = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'truth.json'), 'utf8'));

async function load(name) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(SAMPLE_DIR, name)));
  return TiffReader.fromBytes(bytes, { name });
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + (e && e.stack || e)); process.exitCode = 1; }
}

(async () => {
  await test('plain: classic little-endian, orientation 1', async () => {
    const r = await load('plain.tif');
    assert.equal(r.big, false);
    assert.equal(r.littleEndian, true);
    const d = r.layers[0];
    assert.equal(d.width, 35);
    assert.equal(d.height, 21);
    assert.equal(d.orientation, 1);
    const p = await r.pixelAt(d, 1, 0);
    assert.deepEqual(p.channels, [50731]);
    const p2 = await r.pixelAt(d, 34, 20);
    assert.deepEqual(p2.channels, [55034]);
  });

  await test('rotated: BigTIFF big-endian, orientation 6, planar, subIFD', async () => {
    const r = await load('rotated.tif');
    assert.equal(r.big, true);
    assert.equal(r.littleEndian, false);
    const d = r.layers[0];
    assert.equal(d.orientation, 6);
    assert.equal(d.planar, 2);
    assert.equal(d.spp, 3);
    const t = truth.rotated;
    assert.deepEqual(r.displaySize(d), { width: t.size[0], height: t.size[1] });
    const p = await r.pixelAt(d, t.at[0], t.at[1]);
    assert.deepEqual(p.channels, t.rgb);
    const m = await r.pixelAt(d, t.missing_at[0], t.missing_at[1]);
    assert.equal(m.channels[0], null);
    assert.deepEqual(m.tiles.map((x) => x.index), [5, 11, 17]);
    assert.ok(m.tiles.every((x) => x.status === STATUS.MISSING));
    assert.ok(r.layers.length >= 2);
    const ov = r.layers[1];
    assert.deepEqual(r.displaySize(ov), { width: t.overview_size[0], height: t.overview_size[1] });
    assert.equal(ov.kind, 'sub');
  });

  await test('huge: 32768² sparse BigTIFF, exactly one tile decoded', async () => {
    const r = await load('huge.tif');
    const d = r.layers[0];
    assert.equal(d.width, 32768);
    assert.equal(d.height, 32768);
    assert.equal(d.tileWidth, 256);
    const t = truth.huge;
    const roi = t.roi;
    const res = await r.readRoi(d, { x: roi[0], y: roi[1], width: roi[2], height: roi[3] });
    assert.deepEqual(res.hitTiles, [129]);
    assert.equal(res.decodes, t.decoded_tiles);
    assert.equal(res.width, 4);
    assert.equal(res.height, 5);
    assert.deepEqual(Array.from(res.values.slice(0, 4)), [46945, 47676, 48407, 49138]);
    assert.deepEqual(Array.from(res.values.slice(4, 8)), [45954, 46685, 47416, 48147]);
    assert.ok(Array.from(res.mask).every((v) => v === 1));
    // only the tile range was read, not the 32K² image
    assert.ok(r.stats.tileBytes < 4096, 'tile bytes ' + r.stats.tileBytes);
  });

  await test('cycle: directory loop reported with the repeated offset', async () => {
    const r = await load('cycle.tif');
    const e = r.errors.find((x) => x.scope === 'directory' && /循环/.test(x.message));
    assert.ok(e, 'cycle error expected');
    assert.equal(e.offset, 536);
    assert.equal(r.directories.length, 1);
  });

  await test('huge: ROI away from the only present tile is all-missing', async () => {
    const r = await load('huge.tif');
    const d = r.layers[0];
    const res = await r.readRoi(d, { x: 0, y: 0, width: 4, height: 4 });
    assert.deepEqual(res.hitTiles, [0]);
    assert.ok(Array.from(res.mask).every((v) => v === 0));
    assert.ok(Array.from(res.values).every((v) => v === 0));
    assert.deepEqual(res.missingTiles, [0]);
    assert.equal(res.decodes, 0);
  });

  await test('cache: repeated ROI decoding hits the 32-block cache', async () => {
    const r = await load('plain.tif');
    const d = r.layers[0];
    const a = await r.readRoi(d, { x: 0, y: 0, width: 32, height: 21 });
    assert.ok(a.decodes > 0);
    const b = await r.readRoi(d, { x: 0, y: 0, width: 32, height: 21 });
    assert.equal(b.decodes, 0);
    assert.ok(b.cacheHits > 0);
    assert.ok(r.cacheSize() <= 32);
  });

  await test('orientation 6 maps every display pixel back to storage', async () => {
    const r = await load('rotated.tif');
    const d = r.layers[0];
    for (let y = 0; y < d.height; y += 7) {
      for (let x = 0; x < d.width; x += 7) {
        const p = r.displayToStorage(d, x, y);
        assert.deepEqual(r.storageToDisplay(d, p.x, p.y), { x, y });
      }
    }
  });

  await test('blob source reads only the requested tile range', async () => {
    const blob = new Blob([fs.readFileSync(path.join(SAMPLE_DIR, 'huge.tif'))]);
    const { BlobSource } = require('../js/tiff.js');
    const r = await TiffReader.open(new BlobSource(blob, 'huge.tif'));
    const d = r.layers[0];
    const res = await r.readRoi(d, { x: 260, y: 261, width: 4, height: 5 });
    assert.equal(res.decodes, 1);
    // the 16384-entry offset array is metadata (256 KiB) and must be read,
    // but no pixel data outside the one needed tile may be touched:
    assert.ok(r.stats.tileBytes < 4096, 'tile bytes ' + r.stats.tileBytes);
  });

  if (process.exitCode) console.error('\n' + passed + ' passed, failures above');
  else console.log('\nall ' + passed + ' tests passed');
})();
