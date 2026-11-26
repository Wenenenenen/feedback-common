// KKT 最优性独立核验：凸问题 min f(x) s.t. x0>=r。
// 归一化 KKT 残差 = ||P_C(x - grad/L) - x|| / max(1,|x0|)，理论解处应为 0。
// 用法: node kkt_check.js <zip> <js_result.json>
const fs = require('fs');
const ROOT = '/home/wendy/jianzhi/feedback-tasks/polarimetric-stokes-desk';
require(ROOT + '/src/zip.js'); require(ROOT + '/src/io.js'); require(ROOT + '/src/solver.js');

const zipPath = process.argv[2];
const resPath = process.argv[3];
const buf = fs.readFileSync(zipPath);
const project = globalThis.StokesIO.buildProject(
  globalThis.StokesZip.unzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
const res = JSON.parse(fs.readFileSync(resPath, 'utf8'));
const N = project.width * project.height;

let worst = { kkt: 0, px: -1 };
let overTol = 0;
const TOL = 1e-5;
for (let px = 0; px < N; px++) {
  if (!res.solved[px]) continue;
  const x = [res.s0[px], res.s1[px], res.s2[px]];
  // 全目标梯度
  const g = [0, 0, 0];
  let L = 0;
  for (let i = 0; i < project.frames.length; i++) {
    const f = project.frames[i];
    if (f.maskData && f.maskData[px] !== 255) continue;
    const m = f.image[px];
    const c0 = f.gain / 4, c1 = c0 * f.u / 5, c2 = c0 * f.v / 5;
    const p = f.offset + c0 * x[0] + c1 * x[1] + c2 * x[2];
    let r = 0;
    if (m === 0) { if (p > 0) r = p; }
    else if (m === 65535) { if (p < 65535) r = p - 65535; }
    else r = p - m;
    if (r !== 0) {
      const c = 2 * f.weight * r;
      g[0] += c * c0; g[1] += c * c1; g[2] += c * c2;
    }
    L += 2 * f.weight * (c0 * c0 + c1 * c1 + c2 * c2);
  }
  // P_C(x - g/L)
  const y = [x[0] - g[0] / L, x[1] - g[1] / L, x[2] - g[2] / L];
  globalThis.StokesSolver.coneProject(y);
  const kkt = Math.hypot(y[0] - x[0], y[1] - x[1], y[2] - x[2]) / Math.max(1, Math.abs(x[0]));
  if (kkt > worst.kkt) worst = { kkt, px };
  if (kkt > TOL) overTol++;
}
console.log('pixels checked:', res.solved.reduce((a, b) => a + b, 0));
console.log('worst normalized KKT residual:', worst.kkt.toExponential(4), 'at px', worst.px);
console.log('pixels over tol', TOL, ':', overTol);
