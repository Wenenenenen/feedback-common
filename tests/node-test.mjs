// Node headless test: validate the JS parser/compositor against the package reference PNGs.
// Run: node --input-type=module - <<'EOF' style is awkward; invoke via: node tests/node-test.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parseApng, frameZlibStream, posterZlibStream, ApngError } from '../src/apng-parser.js';
import { decodeAllFrames, compositeAnimation, frameDurationMs } from '../src/compositor.js';
import { decodePng, encodePng, chunkBytes as chunkBytesExport } from '../src/png-codec.js';
import { exportApng } from '../src/apng-exporter.js';
import { buildZip } from '../src/zip-store.js';

const SAMPLE_DIR = '/tmp/apng-sample-extract';
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

function rgbaEqualAlphaTolerant(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0 && b[i + 3] === 0) continue; // transparent pixels: alpha-only comparison
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) return false;
  }
  return true;
}

function loadReference(tag, i) {
  const path = `${SAMPLE_DIR}/reference/${tag}-${i}.png`;
  const { width, height, rgba } = decodePng(readFileSync(path));
  return { width, height, rgba };
}

for (const name of ['included.apng', 'poster-excluded.apng']) {
  console.log(`== ${name}`);
  const bytes = new Uint8Array(readFileSync(`${SAMPLE_DIR}/${name}`));
  const parsed = parseApng(bytes);
  check('posterIsFrame matches timing.json',
    parsed.posterIsFrame === (name === 'included.apng'),
    `got ${parsed.posterIsFrame}`);
  check('frame count = 6', parsed.frames.length === 6);
  check('numPlays = 2', parsed.numPlays === 2);

  const pixels = decodeAllFrames(parsed, frameZlibStream);
  const states = compositeAnimation(parsed, pixels);
  check('one state per frame', states.length === 6);

  for (let i = 0; i < 6; i++) {
    for (const tag of ['before', 'shown', 'after']) {
      const ref = loadReference(tag, i);
      const mine = states[i][tag];
      check(`${name} ${tag}-${i}`, rgbaEqualAlphaTolerant(mine, ref.rgba));
    }
  }

  // timing.json delays
  const timing = JSON.parse(readFileSync(`${SAMPLE_DIR}/timing.json`, 'utf8'));
  for (let i = 0; i < 6; i++) {
    check(`delay ${i} num/den`, states[i].delayNum === timing.delays[i][0] && states[i].delayDen === timing.delays[i][1]);
  }
  // den=0 -> 100 convention; num=0 -> 10ms floor
  check('frame2 den=0 -> 100, 1/100 s = 10ms', states[2].frameMs === 10 && states[2].effectiveDen === 100);
  check('frame5 num=0 -> 10ms playback floor', states[5].frameMs === 10);
  check('frame1 1/7 exact-ish', Math.abs(states[1].frameMs - 1000 / 7) < 1e-10);

  // poster (default image) decodes standalone from the IDAT stream
  {
    const { width, height, rgba } = decodePng((() => {
      // build a standalone PNG from IHDR + poster IDAT stream + IEND
      const ihdr = parsed.chunks.find((c) => c.type === 'IHDR');
      const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunkBytesExport('IHDR', bytes.subarray(ihdr.bodyStart, ihdr.bodyEnd)),
      ];
      for (const c of parsed.idatChunks) {
        parts.push(chunkBytesExport('IDAT', bytes.subarray(c.bodyStart, c.bodyEnd)));
      }
      parts.push(chunkBytesExport('IEND', new Uint8Array(0)));
      let total = 0; for (const p of parts) total += p.length;
      const out = new Uint8Array(total);
      let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    })());
    check(`${name} poster decodes`, width === parsed.width && height === parsed.height && rgba.length === parsed.width * parsed.height * 4);
    // For a poster-excluded file the default image must differ from frame 0's shown canvas;
    // for an included file they must be identical (the default image IS frame 0).
    const sameAsFrame0 = rgbaEqualAlphaTolerant(rgba, states[0].shown);
    check(`${name} poster relation to frame 0 correct`,
      parsed.posterIsFrame ? sameAsFrame0 : !sameAsFrame0,
      `posterIsFrame=${parsed.posterIsFrame} same=${sameAsFrame0}`);
  }

  // round-trip export: re-import must parse identically and composite identically
  const rebuilt = exportApng(parsed, { numPlays: parsed.numPlays, frames: {} });
  writeFileSync(`/tmp/apng-analysis/rebuilt-${name}`, rebuilt);
  const reparsed = parseApng(rebuilt);
  check('re-import frame count', reparsed.frames.length === parsed.frames.length);
  check('re-import poster flag', reparsed.posterIsFrame === parsed.posterIsFrame);
  const repixels = decodeAllFrames(reparsed, frameZlibStream);
  const restates = compositeAnimation(reparsed, repixels);
  let rtOk = true;
  for (let i = 0; i < 6; i++) {
    for (const tag of ['before', 'shown', 'after']) {
      if (!rgbaEqualAlphaTolerant(states[i][tag], restates[i][tag])) rtOk = false;
    }
  }
  check('round-trip composite identical', rtOk);
}

// first-previous.apng: dispose PREVIOUS on the first frame
console.log('== first-previous.apng');
{
  const parsed = parseApng(new Uint8Array(readFileSync(`${SAMPLE_DIR}/first-previous.apng`)));
  check('2 frames', parsed.frames.length === 2);
  check('frame0 dispose PREVIOUS', parsed.frames[0].disposeOp === 2);
  const pixels = decodeAllFrames(parsed, frameZlibStream);
  const states = compositeAnimation(parsed, pixels);
  const ref1 = decodePng(readFileSync(`${SAMPLE_DIR}/reference/first-previous-1.png`));
  check('first-previous shown-1 matches reference', rgbaEqualAlphaTolerant(states[1].shown, ref1.rgba));
}

// edit propagation: change frame 0 disposal, later frames must change
console.log('== edit propagation');
{
  const parsed = parseApng(new Uint8Array(readFileSync(`${SAMPLE_DIR}/included.apng`)));
  const pixels = decodeAllFrames(parsed, frameZlibStream);
  const base = compositeAnimation(parsed, pixels);
  const edited = compositeAnimation(parsed, pixels, { 0: { disposeOp: 1 } });
  let changed = false;
  for (let i = 1; i < 6; i++) {
    if (!rgbaEqualAlphaTolerant(base[i].shown, edited[i].shown)) changed = true;
  }
  check('editing frame 0 disposal changes later frames', changed);

  // export with edits and re-import: edits preserved
  const rebuilt = exportApng(parsed, {
    numPlays: 3,
    frames: { 0: { disposeOp: 1, blendOp: 1, delayNum: 5, delayDen: 20 }, 3: { delayNum: 0, delayDen: 0 } },
  });
  const reparsed = parseApng(rebuilt);
  check('edited numPlays preserved', reparsed.numPlays === 3);
  check('edited frame0 params preserved',
    reparsed.frames[0].disposeOp === 1 && reparsed.frames[0].blendOp === 1 &&
    reparsed.frames[0].delayNum === 5 && reparsed.frames[0].delayDen === 20);
  check('zero numerator/denominator preserved on export',
    reparsed.frames[3].delayNum === 0 && reparsed.frames[3].delayDen === 0);
  check('unedited frame unchanged',
    reparsed.frames[2].disposeOp === parsed.frames[2].disposeOp &&
    reparsed.frames[2].blendOp === parsed.frames[2].blendOp);
}

// error localization
console.log('== error cases');
const expectError = (file, kind, chunkType) => {
  try {
    parseApng(new Uint8Array(readFileSync(`${SAMPLE_DIR}/${file}`)));
    check(`${file} should throw`, false);
  } catch (e) {
    if (e instanceof ApngError) {
      check(`${file} kind=${kind}`, e.kind === kind, `got ${e.kind}: ${e.message}`);
      if (chunkType !== undefined) {
        check(`${file} chunk=${chunkType}`, e.detail?.chunkType === chunkType,
          `got ${e.detail?.chunkType} @${e.detail?.offset}`);
      } else {
        check(`${file} offset-only localization (chunk header incomplete)`,
          typeof e.detail?.offset === 'number' && e.detail.chunkType === undefined);
      }
      check(`${file} has byte offset`, typeof e.detail?.offset === 'number');
      console.log(`    ↳ ${e.message}`);
    } else check(`${file} ApngError type`, false, e.message);
  }
};
expectError('invalid-crc.apng', 'crc', 'IEND');
expectError('invalid-sequence.apng', 'sequence', 'fdAT');
expectError('invalid-bounds.apng', 'bounds', 'fcTL');
expectError('invalid-count.apng', 'count', 'acTL');
expectError('invalid-truncated.apng', 'truncation', undefined);

// PNG codec self round-trip on reference images
console.log('== png codec round-trip');
for (const f of readdirSync(`${SAMPLE_DIR}/reference`).filter((x) => x.endsWith('.png'))) {
  const orig = decodePng(readFileSync(`${SAMPLE_DIR}/reference/${f}`));
  const re = decodePng(encodePng(orig.width, orig.height, orig.rgba));
  check(`png round-trip ${f}`, re.width === orig.width && re.height === orig.height &&
    rgbaEqualAlphaTolerant(re.rgba, orig.rgba));
}

// zip smoke test
console.log('== zip');
{
  const zip = buildZip([
    { name: 'a.png', data: new Uint8Array([1, 2, 3, 4]) },
    { name: 'dir/b.png', data: new Uint8Array(200).fill(7) },
  ]);
  writeFileSync('/tmp/apng-analysis/test.zip', zip);
  check('zip starts with local file header', zip[0] === 0x50 && zip[1] === 0x4b);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
