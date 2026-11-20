// One-off exploration of the sample cases. Run from tools/ with absolute paths.
import { readFileSync } from 'node:fs';
import { decodePNG } from './png.js';

const dir = process.argv[2];
const readGray = (name) => decodePNG(readFileSync(dir + '/' + name));

const a = readGray('a.png');
console.log('a.png', a.width, 'x', a.height);

for (const caseName of ['integer', 'subpixel', 'occluded', 'piecewise']) {
  const meta = JSON.parse(readFileSync(`${dir}/${caseName}.json`, 'utf8'));
  const W = a.width, H = a.height;
  const truth = new Float32Array(new Uint8Array(readFileSync(`${dir}/${caseName}-truth.raw`)).buffer);
  const validPng = readGray(`${caseName}-truth-valid.png`);
  const valid = validPng.data.map(v => v > 127);
  const pairs = new Map();
  let nValid = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!valid[i]) continue;
    nValid++;
    const key = `${truth[2*i].toFixed(3)},${truth[2*i+1].toFixed(3)}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
  const ys = [], xs = [];
  for (let i = 0; i < valid.length; i++) if (valid[i]) { xs.push(i % W); ys.push((i / W) | 0); }
  console.log(`\n== ${caseName} ==`, meta);
  console.log('  valid:', nValid, 'bbox x:', Math.min(...xs), Math.max(...xs), 'y:', Math.min(...ys), Math.max(...ys));
  console.log('  uv histogram:', [...pairs.entries()].sort((p, q) => q[1] - p[1]).slice(0, 6));
}

const fa = readGray('flat-a.png'), fb = readGray('flat-b.png');
console.log('\nflat sizes:', fa.width, fa.height, 'unique A:', new Set(fa.data).size, 'unique B:', new Set(fb.data).size);
console.log('flat A values:', [...new Set(fa.data)].slice(0, 8));
console.log('flat B values:', [...new Set(fb.data)].slice(0, 8));

// texture stats of a.png: gradient magnitude distribution
{
  const { width: W, height: H, data: g } = a;
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    gx[i] = x > 0 && x < W - 1 ? (g[i + 1] - g[i - 1]) / 2 : 0;
    gy[i] = y > 0 && y < H - 1 ? (g[i + W] - g[i - W]) / 2 : 0;
  }
  const mags = [];
  for (let i = 0; i < gx.length; i++) mags.push(Math.hypot(gx[i], gy[i]));
  mags.sort((p, q) => p - q);
  console.log('\na.png gradient mag percentiles 10/25/50/75/90:',
    [0.1, 0.25, 0.5, 0.75, 0.9].map(p => mags[(p * mags.length) | 0].map ? '' : mags[(p * mags.length) | 0].toFixed(2)));
}
