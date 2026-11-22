/*
 * test/validate.js — 用独立遮挡射线逐像素校验 Z-Fail 模板计数
 * 对每个场景:接收面每个像素比较 (模板计数 != 0) 与 (射线被任一 caster 遮挡),
 * 并校验 |模板计数| == 遮挡该点的 caster 数。任一不一致则退出码非零。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Z = require(path.join(__dirname, '..', 'zfail-core.js'));

const scene = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'samples', 'zfail-volume-cases.json'), 'utf8')
);
const base = {
  light: scene.light.slice(),
  eye: scene.camera.eye.slice(),
  target: scene.camera.target.slice(),
  fovy: scene.camera.fovy,
  near: scene.camera.near,
  W: scene.size[0],
  H: scene.size[1],
};

const scenarios = {
  '默认(相机在体积内)': {},
  '相机在体积外': { eye: [3, 2, 4], target: [0, 0, 9] },
  '近裁面切入体积 near=1.0': { near: 1.0 },
  'near=2.0 切入两个体': { near: 2.0 },
  'near=4.0 裁掉全部网格只剩余体积': { near: 4.0 },
  '光源偏移': { light: [0.5, -0.3, 0.2] },
  '光源偏移+相机在体内': { light: [0.5, -0.3, 0.2], eye: [0.1, 0.05, 3.2] },
  '高分辨率 192x144': { W: 192, H: 144 },
  '相机在接收面后方回看': { eye: [0.2, 0.1, 12], target: [0, 0, 0] },
  '斜视': { eye: [2, -1, 6], target: [-0.5, 0.3, 9] },
  '光源在相机后方': { light: [0.2, 0.1, 5], eye: [0.2, 0.1, 4] },
};

let totalBad = 0;
for (const [name, over] of Object.entries(scenarios)) {
  const opt = Object.assign({}, base, over);
  const r = Z.render(scene, opt);
  let recv = 0, maskBad = 0, magBad = 0, shadowed = 0;
  const badPixels = [];
  for (let y = 0; y < r.H; y++) {
    for (let x = 0; x < r.W; x++) {
      const i = y * r.W + x;
      if (r.depth[i] >= 1) continue;
      recv++;
      const P = Z.worldPos(r, x, y);
      const { occ } = Z.occlusionPerCaster(P, opt.light, scene.casters);
      const nOcc = occ.filter(Boolean).length;
      const st = r.stencil[i];
      if (nOcc > 0) shadowed++;
      if ((st !== 0) !== (nOcc > 0)) {
        maskBad++;
        if (badPixels.length < 5) badPixels.push(`(${x},${y}) st=${st} 期望遮挡=${nOcc}`);
      } else if (Math.abs(st) !== nOcc) {
        magBad++;
        if (badPixels.length < 5) badPixels.push(`(${x},${y}) |st|=${Math.abs(st)} 期望=${nOcc}`);
      }
    }
  }
  const bad = maskBad + magBad;
  totalBad += bad;
  console.log(
    `${bad === 0 ? 'PASS' : 'FAIL'}  ${name}  ` +
    `接收像素=${recv} 阴影像素=${shadowed} 掩码不一致=${maskBad} 计数幅度不一致=${magBad}`
  );
  badPixels.forEach(s => console.log('      ' + s));
  if (r.warnings.length) console.log('      警告: ' + r.warnings.join('; '));
}
console.log(totalBad === 0 ? '\n全部场景通过' : `\n共 ${totalBad} 个不一致像素`);
process.exit(totalBad === 0 ? 0 : 1);
