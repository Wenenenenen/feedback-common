// 从 index.html 提取核心算法（==CORE-BEGIN/END== 之间），对样例数据做端到端验证。
// 运行：node test/core.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const core = html.split('// ==CORE-BEGIN==')[1].split('// ==CORE-END==')[0];
const api = new Function(`${core}; return { buildDesign, solveNormal, jacobiEigen4, distortPixel,
  pointResiduals, fitModel, jacobianDet, computeFolds, undistortImage };`)();

const SAMPLES = '/tmp/lens-samples';
const load = n => JSON.parse(readFileSync(join(SAMPLES, n), 'utf8'));
const truth = load('truth.json').coefficients; // [0.12, -0.035, 0.004, -0.003]

let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failed++;
}
const close = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// 1. clean：OLS 应精确还原真值
{
  const d = load('clean.json');
  const f = api.fitModel(d.intrinsics, d.points, 'ols', 1.5);
  check('clean OLS 还原真值', f.ok && close(f.coef, truth, 1e-6),
    `coef=[${f.coef.map(c => c.toFixed(6))}]`);
  check('clean 非退化', f.sigmaRatio > 1e-8, `σ比=${f.sigmaRatio.toExponential(2)}`);
  check('clean 残差≈0', f.rms < 1e-6, `rms=${f.rms}`);
}

// 2. noisy：OLS 被拉偏，Huber 显著更接近真值
{
  const d = load('noisy.json');
  const ols = api.fitModel(d.intrinsics, d.points, 'ols', 1.5);
  const hub = api.fitModel(d.intrinsics, d.points, 'huber', 1.5);
  const errOls = Math.hypot(...ols.coef.map((c, i) => c - truth[i]));
  const errHub = Math.hypot(...hub.coef.map((c, i) => c - truth[i]));
  check('noisy OLS 被异常点拉偏', errOls > 0.05, `err=${errOls.toFixed(4)}`);
  check('noisy Huber 稳健恢复', errHub < 0.05 && errHub < errOls / 5,
    `err=${errHub.toFixed(4)} (OLS ${errOls.toFixed(4)})`);
  check('Huber IRLS 收敛', hub.converged && hub.iters <= 100, `iters=${hub.iters}`);
  const nOut = hub.residuals.filter(r => r.r > 1.5).length;
  check('Huber 检出异常点', nOut > 0, `${nOut} 个 r>δ`);
}

// 3. degenerate：应报退化（σmin/σmax < 1e-8）
{
  const d = load('degenerate.json');
  const f = api.fitModel(d.intrinsics, d.points, 'ols', 1.5);
  check('degenerate 检出退化', !f.ok || f.sigmaRatio < 1e-8,
    f.ok ? `σ比=${f.sigmaRatio.toExponential(2)}` : f.reason);
}

// 4. 折叠检测：极端桶形系数应在画面边缘产生 det≤0
{
  const intr = { fx: 110, fy: 108, cx: 79.5, cy: 59.5 };
  const bad = [-0.5, 0, 0, 0];
  const folds = api.computeFolds(intr, bad, 160, 120);
  check('极端系数检出折叠', folds.count > 0, `${folds.count} 像素`);
  const good = api.computeFolds(intr, truth, 160, 120);
  check('真值系数无折叠', good.count === 0, `${good.count} 像素`);
  // 恒等映射 det=1
  check('恒等映射 det=1', Math.abs(api.jacobianDet(intr, [0, 0, 0, 0], 30, 40) - 1) < 1e-12);
}

// 5. 重采样：恒等映射应原样还原；越界透明；bbox 左闭右开
{
  const w = 8, h = 6;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { src[i * 4] = i % 256; src[i * 4 + 1] = 200; src[i * 4 + 2] = 50; src[i * 4 + 3] = 255; }
  const intr = { fx: 100, fy: 100, cx: 3.5, cy: 2.5 };
  const { data, bbox } = api.undistortImage(src, w, h, intr, [0, 0, 0, 0]);
  let same = true;
  for (let i = 0; i < w * h * 4; i++) if (data[i] !== src[i]) { same = false; break; }
  check('恒等映射逐像素还原', same);
  check('恒等映射 bbox 全图', bbox && bbox.x0 === 0 && bbox.y0 === 0 && bbox.x1 === w && bbox.y1 === h,
    JSON.stringify(bbox));
  // 强枕形把中心源坐标推出界 → 出现透明像素且 bbox 收缩
  const r2 = api.undistortImage(src, w, h, intr, [50, 0, 0, 0]);
  let transparent = 0;
  for (let i = 0; i < w * h; i++) if (r2.data[i * 4 + 3] === 0) transparent++;
  check('越界区域透明且 bbox 收缩', transparent > 0 && r2.bbox && r2.bbox.x1 <= w,
    `透明 ${transparent} 像素, bbox=${JSON.stringify(r2.bbox)}`);
}

// 6. 双线性插值正确性：令像素 (0,0) 的源坐标为 (1.5, 0)，应取两列均值并 floor(v+0.5) 取整
{
  const w = 4, h = 2;
  const src = new Uint8ClampedArray(w * h * 4);
  // 第 0 行：列值 [10, 20, 40, 80]
  [10, 20, 40, 80].forEach((v, x) => { src[x * 4] = v; src[x * 4 + 3] = 255; });
  for (let i = w; i < w * h; i++) { src[i * 4] = 0; src[i * 4 + 3] = 255; }
  // cx=50, fx=100 → x=-0.5, r2=0.25；k1=-0.12 → xd=-0.5*0.97=-0.485 → su=1.5
  const intr = { fx: 100, fy: 100, cx: 50, cy: 0 };
  const { data } = api.undistortImage(src, w, h, intr, [-0.12, 0, 0, 0]);
  check('双线性均值+取整', data[0] === 30, `got ${data[0]} (期望 (20+40)/2=30)`);
}

process.exit(failed ? 1 : 0);
