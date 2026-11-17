// Node 自检：对照样例包核对 CSM 纯计算（无需浏览器）。
// 运行：node test/csm.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const CSM = require('../js/csm.js');

const here = dirname(fileURLToPath(import.meta.url));
const scene = JSON.parse(readFileSync(join(here, 'fixtures/scene.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(here, 'fixtures/expected.json'), 'utf8'));
const path = JSON.parse(readFileSync(join(here, 'fixtures/translation-path.json'), 'utf8'));

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? '通过' : '失败'} | ${name}${detail ? ' | ' + detail : ''}`);
  if (!cond) failures++;
}
const approx = (a, b, eps) => Math.abs(a - b) <= eps;

const boxAABBs = scene.boxes.map((b) => ({
  min: b.center.map((c, i) => c - b.size[i] / 2),
  max: b.center.map((c, i) => c + b.size[i] / 2),
}));
const casters = boxAABBs.concat([{ min: scene.ground.min, max: scene.ground.max }]);

// 1. 分段公式 vs expected.json（λ = 0 / 0.5 / 1）
{
  let ok = true, det = '';
  for (const [lam, exp] of Object.entries(expected.splits)) {
    const got = CSM.computeSplits(expected.near, expected.far, parseFloat(lam));
    for (let i = 0; i < 4; i++) {
      if (!approx(got[i], exp[i], 1e-9)) { ok = false; det = `λ=${lam} i=${i}: ${got[i]} != ${exp[i]}`; }
    }
  }
  check('分段公式与 expected.json 一致', ok, det);
}

// 2. 解析探针：[-4,0,-12] 被视锥外遮挡物 offscreen-caster 投影；[4,0,-12] 受光
{
  const s = CSM.analyticShadow(expected.shadow_probe, expected.probe_to_light, boxAABBs);
  check('解析探针 [-4,0,-12] 处于阴影', s === 0, `解析值=${s}`);
  const lit = CSM.analyticShadow([4, 0, -12], expected.probe_to_light, boxAABBs);
  check('对照点 [4,0,-12] 受光', lit === 1, `解析值=${lit}`);
}

// 3. 级联深度范围包含视锥外遮挡物（offscreen-caster 在视锥外但投影覆盖探针）
{
  const cam = { ...scene.camera };
  const splits = CSM.computeSplits(cam.near, cam.far, scene.defaults.lambda);
  const set = CSM.computeCascadeSet({
    cam, splits, toLight: scene.light.to_light, casters,
    resolution: scene.defaults.resolution, stabilize: false,
  });
  const casterZ = CSM.occluderZMin(set.basis, boxAABBs);
  const cb = CSM.cameraBasis(cam);
  const depth = CSM.vec.dot(CSM.vec.sub(expected.shadow_probe, cam.position), cb.f);
  const bands = CSM.computeBands(splits, scene.defaults.transition);
  const sel = CSM.selectCascade(depth, splits, bands);
  const zmin = set.cascades[sel.from].bounds.minZ;
  check('级联深度范围包含视锥外遮挡物', zmin <= casterZ,
    `探针深度=${depth.toFixed(2)} 级${sel.from + 1} zMin=${zmin.toFixed(2)} 遮挡物zMin=${casterZ.toFixed(2)}`);
}

// 4. 稳定模式：保持朝向纯平移时投影宽高不变，xy 中心按各级纹素尺寸取整
{
  const cam0 = { ...scene.camera };
  const splits = CSM.computeSplits(cam0.near, cam0.far, scene.defaults.lambda);
  const res = scene.defaults.resolution;
  const baseS = CSM.computeCascadeSet({ cam: cam0, splits, toLight: scene.light.to_light, casters, resolution: res, stabilize: true });
  const baseU = CSM.computeCascadeSet({ cam: cam0, splits, toLight: scene.light.to_light, casters, resolution: res, stabilize: false });
  let ok = true, det = '';
  for (let ci = 0; ci < 3 && ok; ci++) {
    const texel = baseS.cascades[ci].texel[0];
    const unsnapped = baseU.cascades[ci].center[0];
    const w0 = baseS.cascades[ci].bounds.maxX - baseS.cascades[ci].bounds.minX;
    const h0 = baseS.cascades[ci].bounds.maxY - baseS.cascades[ci].bounds.minY;
    for (const o of path.offsets_in_texels) {
      const off = CSM.vec.scale(baseS.basis.x, o * texel);
      const camT = { ...cam0, position: CSM.vec.add(cam0.position, off), target: CSM.vec.add(cam0.target, off) };
      const sT = CSM.computeCascadeSet({ cam: camT, splits, toLight: scene.light.to_light, casters, resolution: res, stabilize: true });
      const cas = sT.cascades[ci];
      const w = cas.bounds.maxX - cas.bounds.minX;
      const h = cas.bounds.maxY - cas.bounds.minY;
      if (!approx(w, w0, 1e-9) || !approx(h, h0, 1e-9)) {
        ok = false; det = `级${ci + 1} 偏移${o}：投影尺寸变化`; break;
      }
      const snappedTex = cas.center[0] / texel;
      if (!approx(snappedTex, Math.round(snappedTex), 1e-6)) {
        ok = false; det = `级${ci + 1} 偏移${o}：中心未对齐纹素`; break;
      }
      const expect = Math.round(unsnapped / texel + o) - Math.round(unsnapped / texel);
      const gotTex = (cas.center[0] - baseS.cascades[ci].center[0]) / texel;
      if (!approx(gotTex, expect, 1e-6)) {
        ok = false; det = `级${ci + 1} 偏移${o}：跳动 ${gotTex} 纹素 != 期望 ${expect}`; break;
      }
    }
  }
  check('稳定模式平移取整边界（translation-path.json）', ok, det);
}

// 5. 过渡带：宽度 = transition × min(相邻跨度)，selectCascade 在分界处 t=0.5
{
  const splits = CSM.computeSplits(expected.near, expected.far, 0.5);
  const bands = CSM.computeBands(splits, 0.1);
  const w1 = 0.1 * Math.min(splits[1] - splits[0], splits[2] - splits[1]);
  const w2 = 0.1 * Math.min(splits[2] - splits[1], splits[3] - splits[2]);
  check('过渡带宽度公式', approx(bands[0], w1, 1e-12) && approx(bands[1], w2, 1e-12),
    `w1=${bands[0].toFixed(4)} w2=${bands[1].toFixed(4)}`);
  const mid = CSM.selectCascade(splits[1], splits, bands);
  const below = CSM.selectCascade(splits[1] - bands[0] / 2 - 1e-6, splits, bands);
  const above = CSM.selectCascade(splits[1] + bands[0] / 2 + 1e-6, splits, bands);
  check('分界处 t=0.5 且两侧各属相邻级',
    mid.from === 0 && mid.to === 1 && approx(mid.t, 0.5, 1e-9) &&
    below.from === 0 && below.to === 0 && above.from === 1 && above.to === 1,
    `mid.t=${mid.t}`);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
