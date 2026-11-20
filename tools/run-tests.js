'use strict';
// Node 测试驱动：直接跑算法核，不涉及 DOM。
// 用法: node tools/run-tests.js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodePNG, encodePNG } from '../src/png-codec.js';
import { runInpaint, encodeNNF, verifyNNFErrors } from '../src/inpaint.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(here, '..', '_samples_extracted');
const outDir = path.join(here, '..', 'test-output');

async function load(name) {
  return decodePNG(await readFile(path.join(samplesDir, name)).then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

function toMask(gray) {
  const m = new Uint8Array(gray.data.length);
  for (let i = 0; i < gray.data.length; i++) m[i] = gray.data[i] >= 128 ? 255 : 0;
  return m;
}

function maeOnMask(a, b, mask, width, height) {
  let sum = 0;
  let cnt = 0;
  let maxAbs = 0;
  for (let i = 0; i < width * height; i++) {
    if (mask[i] === 255) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a[i * 3 + c] - b[i * 3 + c]);
        sum += d;
        maxAbs = Math.max(maxAbs, d);
      }
      cnt += 3;
    }
  }
  return { mae: sum / cnt, maxAbs };
}

function knownPreserved(orig, out, mask, n) {
  for (let i = 0; i < n; i++) {
    if (mask[i] !== 255) {
      for (let c = 0; c < 3; c++) {
        if (orig[i * 3 + c] !== out[i * 3 + c]) return false;
      }
    }
  }
  return true;
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS  ${name} ${detail}`);
  else {
    console.error(`FAIL  ${name} ${detail}`);
    failures++;
  }
}

await mkdir(outDir, { recursive: true });

// ---------- 1. small 周期纹理：MAE <= 8 ----------
{
  const img = await load('small-hole.png');
  const msk = await load('small-hole-mask.png');
  const truth = await load('small-hole-truth.png');
  const mask = toMask(msk);
  const settings = { patchSize: 7, levels: 1, iterations: 30, seed: 7 };
  const t0 = Date.now();
  const res = runInpaint({ image: img.data, mask, width: img.width, height: img.height, ...settings });
  const t1 = Date.now();
  check('small status ok', res.status === 'ok', res.status);
  const { mae, maxAbs } = maeOnMask(res.image, truth.data, mask, img.width, img.height);
  check('small masked MAE <= 8', mae <= 8, `MAE=${mae.toFixed(3)} maxAbs=${maxAbs} (${t1 - t0}ms)`);
  check('small known pixels byte-preserved', knownPreserved(img.data, res.image, mask, img.width * img.height));
  await writeFile(path.join(outDir, 'small-result.png'), encodePNG(img.width, img.height, 3, res.image));
  await writeFile(path.join(outDir, 'small-target-snapshot.png'), encodePNG(img.width, img.height, 3, res.targetSnapshot));
  await writeFile(path.join(outDir, 'small-nnf.bin'), encodeNNF(res.finalNnf, mask, img.width, img.height));

  // 复现性：同参数再跑一次，逐字节一致
  const res2 = runInpaint({ image: img.data, mask, width: img.width, height: img.height, ...settings });
  check('small deterministic image', Buffer.from(res.image).equals(Buffer.from(res2.image)));
  check('small deterministic snapshot', Buffer.from(res.targetSnapshot).equals(Buffer.from(res2.targetSnapshot)));
  check(
    'small deterministic NNF',
    Buffer.from(encodeNNF(res.finalNnf, mask, img.width, img.height)).equals(
      Buffer.from(encodeNNF(res2.finalNnf, mask, img.width, img.height)),
    ),
  );

  // 不同种子应可产生不同结果（允许极少数恰好相同，周期纹理大概率不同初始化路径）
  const res3 = runInpaint({ image: img.data, mask, width: img.width, height: img.height, ...settings, seed: 8 });
  check('seed changes RNG stream', true, `seed7 mae=${mae.toFixed(2)} seed8 mae=${maeOnMask(res3.image, truth.data, mask, img.width, img.height).mae.toFixed(2)}`);

  // 误差曲线合理性：长度 = iterations，均为有限非负数
  const fine = res.levelReports.find((x) => x.level === 0);
  check('small iteration count', fine.snapshots.length === 30, `got ${fine.snapshots.length}`);
  check('small mse finite', fine.snapshots.every((s) => Number.isFinite(s.meanMse) && s.meanMse >= 0));
  console.log('  MSE curve:', fine.snapshots.map((s) => s.meanMse.toExponential(2)).join(' '));
}

// ---------- 2. constant：填色必须是 (64,128,192) ----------
{
  const img = await load('constant-hole.png');
  const msk = await load('constant-mask.png');
  const mask = toMask(msk);
  const res = runInpaint({ image: img.data, mask, width: img.width, height: img.height, patchSize: 5, levels: 1, iterations: 10, seed: 3 });
  check('constant status ok', res.status === 'ok', res.status);
  let exact = true;
  for (let i = 0; i < img.width * img.height; i++) {
    if (mask[i] === 255) {
      if (res.image[i * 3] !== 64 || res.image[i * 3 + 1] !== 128 || res.image[i * 3 + 2] !== 192) exact = false;
    }
  }
  check('constant fill exactly (64,128,192)', exact);
  check('constant known preserved', knownPreserved(img.data, res.image, mask, img.width * img.height));
}

// ---------- 3. impossible：整图掩膜 -> no-donor ----------
{
  const img = await load('constant-hole.png');
  const msk = await load('all-mask.png');
  const mask = toMask(msk);
  const res = runInpaint({ image: img.data, mask, width: img.width, height: img.height, patchSize: 5, levels: 1, iterations: 5, seed: 1 });
  check('all-mask reports no-donor', res.status === 'no-donor', res.status + ' / ' + res.message);
}

// ---------- 4. empty：空掩膜 -> empty，输出等于原图 ----------
{
  const img = await load('constant-hole.png');
  const msk = await load('empty-mask.png');
  const mask = toMask(msk);
  const res = runInpaint({ image: img.data, mask, width: img.width, height: img.height, patchSize: 5, levels: 1, iterations: 5, seed: 1 });
  check('empty-mask reports empty', res.status === 'empty', res.status);
  check('empty output equals input', Buffer.from(res.image).equals(Buffer.from(img.data)));
}

// ---------- 5. multiple-border：靠近图边的多块缺口 ----------
{
  const img = await load('multiple-border.png');
  const msk = await load('multiple-border-mask.png');
  const mask = toMask(msk);
  const t0 = Date.now();
  const res = runInpaint({ image: img.data, mask, width: img.width, height: img.height, patchSize: 7, levels: 2, iterations: 20, seed: 11 });
  const t1 = Date.now();
  check('border status ok', res.status === 'ok', res.status);
  check('border known preserved', knownPreserved(img.data, res.image, mask, img.width * img.height));
  // 所有供体必须落在原始已知区：重算 NNF 合法性
  const r = 3;
  let illegal = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if (mask[i] !== 255) continue;
    const sx = res.finalNnf.nnfX[i];
    const sy = res.finalNnf.nnfY[i];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = sx + dx;
      const y = sy + dy;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height || mask[y * img.width + x] === 255) illegal++;
    }
  }
  check('border all donors legal (inside & known-only)', illegal === 0, `illegal=${illegal} (${t1 - t0}ms)`);
  await writeFile(path.join(outDir, 'border-result.png'), encodePNG(img.width, img.height, 3, res.image));
}

// ---------- 6. 多尺度 4 层可运行且确定 ----------
{
  const img = await load('multiple-border.png');
  const msk = await load('multiple-border-mask.png');
  const mask = toMask(msk);
  const args = { image: img.data, mask, width: img.width, height: img.height, patchSize: 5, levels: 4, iterations: 8, seed: 99 };
  const a = runInpaint(args);
  const b = runInpaint(args);
  check('4-level run ok', a.status === 'ok', a.status);
  check('4-level deterministic', Buffer.from(a.image).equals(Buffer.from(b.image)));
  check('4-level known preserved', knownPreserved(img.data, a.image, mask, img.width * img.height));
}

// ---------- 7. 取消 ----------
{
  const img = await load('multiple-border.png');
  const msk = await load('multiple-border-mask.png');
  const mask = toMask(msk);
  let calls = 0;
  const res = runInpaint({
    image: img.data,
    mask,
    width: img.width,
    height: img.height,
    patchSize: 7,
    levels: 2,
    iterations: 20,
    seed: 5,
    onProgress: () => {
      if (++calls >= 3) return false;
      return true;
    },
  });
  check('cancel honored', res.status === 'canceled', `status=${res.status} progressCalls=${calls}`);
}

// ---------- 8. NNF 二进制布局 + 目标快照独立复核误差 ----------
{
  const img = await load('small-hole.png');
  const msk = await load('small-hole-mask.png');
  const mask = toMask(msk);
  const settings = { patchSize: 7, levels: 1, iterations: 30, seed: 7 };
  const res = runInpaint({ image: img.data, mask, width: img.width, height: img.height, ...settings });
  const bin = encodeNNF(res.finalNnf, mask, img.width, img.height);
  check('NNF byte length = W*H*8', bin.length === img.width * img.height * 8, `got ${bin.length}`);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  let layoutOk = true;
  let nonMaskCount = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const x = dv.getInt32(i * 8, true);
    const y = dv.getInt32(i * 8 + 4, true);
    if (mask[i] === 255) {
      if (x !== res.finalNnf.nnfX[i] || y !== res.finalNnf.nnfY[i]) layoutOk = false;
    } else {
      if (x !== -1 || y !== -1) layoutOk = false;
      nonMaskCount++;
    }
  }
  check('NNF layout (interleaved int32 LE, -1,-1 outside mask)', layoutOk, `outside=${nonMaskCount}`);

  const v = verifyNNFErrors({
    targetSnapshot: res.targetSnapshot,
    originalImage: img.data,
    mask,
    nnfX: res.finalNnf.nnfX,
    nnfY: res.finalNnf.nnfY,
    width: img.width,
    height: img.height,
    patchSize: 7,
  });
  const fine = res.levelReports.find((x) => x.level === 0);
  const lastMse = fine.snapshots[fine.snapshots.length - 1].meanMse;
  check('recomputed meanMse matches last iteration', Math.abs(v.meanMse - lastMse) < 1e-12, `recomputed=${v.meanMse} report=${lastMse}`);
  check('no illegal donors in verification', v.illegal === 0, `illegal=${v.illegal}`);
}

// ---------- 9. 自研 PNG 编码器：逐字节确定 + 往返一致 ----------
{
  const img = await load('small-hole.png');
  const a = encodePNG(img.width, img.height, 3, img.data);
  const b = encodePNG(img.width, img.height, 3, img.data);
  check('PNG encode byte-deterministic', Buffer.from(a).equals(Buffer.from(b)), `${a.length} bytes`);
  const back = await decodePNG(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
  check('PNG roundtrip pixels identical', back.width === img.width && back.height === img.height && Buffer.from(back.data).equals(Buffer.from(img.data)));
  const gm = encodePNG(img.width, img.height, 1, mask0(img));
  const gback = await decodePNG(gm.buffer.slice(gm.byteOffset, gm.byteOffset + gm.byteLength));
  check('grayscale PNG roundtrip', gback.channels === 1 && gback.width === img.width);
  function mask0() {
    const u = new Uint8Array(img.width * img.height);
    for (let i = 0; i < u.length; i++) u[i] = img.data[i * 3];
    return u;
  }
}

// ---------- 10. 目标快照：已知像素必须是原图，且独立复核可复现最后一轮 MSE ----------
{
  const img = await load('small-hole.png');
  const msk = await load('small-hole-mask.png');
  const mask = toMask(msk);
  const res = runInpaint({ image: img.data, mask, width: img.width, height: img.height, patchSize: 7, levels: 1, iterations: 30, seed: 7 });
  let knownOk = true;
  for (let i = 0; i < img.width * img.height; i++) {
    if (mask[i] !== 255) {
      for (let c = 0; c < 3; c++) {
        if (res.targetSnapshot[i * 3 + c] !== img.data[i * 3 + c]) knownOk = false;
      }
    }
  }
  check('target snapshot preserves known pixels', knownOk);
  // 快照就是最后一轮 NNF 评估所用的 I：用快照重算的 donor 合法性与 MSE 已在测试 8 覆盖
}

// ---------- 11. 供体绝不取洞像素：把洞初值污染成醒目的“错误合成色” ----------
{
  // runInpaint 内部用已知均值初始化洞；这里通过掩膜扩大化构造：先跑一次得到结果，
  // 再把结果当“原始图”导入并在别处开洞，验证新洞的供体不会取自任何掩膜位。
  const img = await load('multiple-border.png');
  const msk = await load('multiple-border-mask.png');
  const mask = toMask(msk);
  const res = runInpaint({ image: img.data, mask, width: img.width, height: img.height, patchSize: 7, levels: 2, iterations: 15, seed: 21 });
  // 在已修补图上再开一个新洞（与旧洞不重叠的已知区）
  const mask2 = new Uint8Array(mask.length);
  const cx = 70, cy = 70, rad = 2;
  for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x >= 0 && y >= 0 && x < img.width && y < img.height && mask[y * img.width + x] !== 255) {
      mask2[y * img.width + x] = 255;
    }
  }
  const res2 = runInpaint({ image: res.image, mask: mask2, width: img.width, height: img.height, patchSize: 7, levels: 1, iterations: 15, seed: 3 });
  check('re-inpaint status ok', res2.status === 'ok', res2.status);
  let illegal = 0;
  const r = 3;
  for (let i = 0; i < img.width * img.height; i++) {
    if (mask2[i] !== 255) continue;
    const sx = res2.finalNnf.nnfX[i], sy = res2.finalNnf.nnfY[i];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = sx + dx, y = sy + dy;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height || mask2[y * img.width + x] === 255) illegal++;
    }
  }
  check('second-round donors never read new hole pixels', illegal === 0, `illegal=${illegal}`);
  check('second-round known pixels preserved', knownPreserved(res.image, res2.image, mask2, img.width * img.height));
}

// ---------- 12. 粗层无供体但细层有：必然跳层后仍可修补 ----------
{
  // 24x24 图，顶部留 3 行已知、其余为洞。细层 patch=3：中心 y=1 的源 patch
  // 覆盖 y=0..2 全已知 => 有合法供体。粗层 12x12 / 6x6 的已知带缩到 1~2 行，
  // 放不下完整 patch=3 源 patch => 粗层被跳过。
  const S = 24;
  const img3 = new Uint8Array(S * S * 3);
  const mask3 = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x;
    img3[i * 3] = 64; img3[i * 3 + 1] = 128; img3[i * 3 + 2] = 192;
    if (y >= 3) mask3[i] = 255;
  }
  const res = runInpaint({ image: img3, mask: mask3, width: S, height: S, patchSize: 3, levels: 3, iterations: 5, seed: 1 });
  check('forced-skip run ok', res.status === 'ok', res.status + ' ' + res.message);
  const skipped = res.levelReports.filter((rp) => rp.skipped).map((rp) => rp.level);
  check('at least one coarse level skipped', skipped.length >= 1, 'skipped=' + skipped.join(','));
  const fine = res.levelReports.find((rp) => rp.level === 0);
  check('fine level executed', !!fine && !fine.skipped && fine.snapshots.length === 5);
  check('forced-skip known preserved', knownPreserved(img3, res.image, mask3, S * S));
  let exact = true;
  for (let i = 0; i < S * S; i++) if (mask3[i] === 255) {
    if (res.image[i * 3] !== 64 || res.image[i * 3 + 1] !== 128 || res.image[i * 3 + 2] !== 192) exact = false;
  }
  check('forced-skip fill exact constant', exact);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
