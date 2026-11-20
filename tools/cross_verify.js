// Headless harness: mirrors the exact math in web/index.html (kept in sync manually).
// Cross-checks every pixel against the Python reference renderer output.
const fs = require("fs");

const M = {
  mul4(a, b) {
    const o = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++) o[r*4+c] += a[r*4+k] * b[k*4+c];
    return o;
  },
  lin3(m) { return [m[0],m[1],m[2], m[4],m[5],m[6], m[8],m[9],m[10]]; },
  trans3(a) { return [a[0],a[3],a[6], a[1],a[4],a[7], a[2],a[5],a[8]]; },
  mul3(a, b) {
    const o = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) o[r*3+c] += a[r*3+k] * b[k*3+c];
    return o;
  },
  isSPD(c, eps = 1e-10) {
    const d2 = c[0]*c[4] - c[1]*c[3];
    const d3 = c[0]*(c[4]*c[8]-c[5]*c[7])
             - c[1]*(c[3]*c[8]-c[5]*c[6])
             + c[2]*(c[3]*c[7]-c[4]*c[6]);
    return c[0] > eps && d2 > eps && d3 > eps;
  },
  eig2(a, b, d) {
    const tr = a + d, disc = Math.sqrt(Math.max(0, (a-d)*(a-d)/4 + b*b));
    const l1 = tr/2 + disc, l2 = tr/2 - disc;
    const theta = Math.abs(b) < 1e-15 ? 0 : Math.atan2(l1 - a, b);
    return { l1: Math.max(0, l1), l2: Math.max(0, l2), theta };
  },
};

function renderPage(data, enabled) {
  const view = data.camera.view;
  const Rv = M.lin3(view);
  const splats = [];
  let invalid = 0, culled = 0;
  for (const inst of data.instances) {
    if (enabled && !enabled.get(inst.id)) continue;
    const VM = M.mul4(view, inst.matrix);
    const A = M.lin3(VM), At = M.trans3(A);
    const tv = [VM[3], VM[7], VM[11]];
    for (const pt of inst.points) {
      const covLocal = pt.covariance.slice();
      if (!M.isSPD(covLocal)) { invalid++; continue; }
      const meanCam = [
        A[0]*pt.mean[0]+A[1]*pt.mean[1]+A[2]*pt.mean[2]+tv[0],
        A[3]*pt.mean[0]+A[4]*pt.mean[1]+A[5]*pt.mean[2]+tv[1],
        A[6]*pt.mean[0]+A[7]*pt.mean[1]+A[8]*pt.mean[2]+tv[2],
      ];
      const covCam = M.mul3(M.mul3(A, covLocal), At);
      const s = { instId: inst.id, pointId: pt.id, meanCam, covCam,
                  color: pt.color.slice(), opacity: pt.opacity };
      const z = meanCam[2];
      if (!(data.camera.near <= z && z <= data.camera.far)) { culled++; continue; }
      const [x, y] = meanCam;
      const { fx, fy, cx, cy } = data.camera;
      s.z = z; s.u = fx*x/z + cx; s.v = cy - fy*y/z;
      const j00 = fx/z, j02 = -fx*x/(z*z), j11 = -fy/z, j12 = fy*y/(z*z);
      const S = covCam;
      const jc00 = j00*S[0] + j02*S[6], jc01 = j00*S[1] + j02*S[7], jc02 = j00*S[2] + j02*S[8];
      const jc10 = j11*S[3] + j12*S[6], jc11 = j11*S[4] + j12*S[7], jc12 = j11*S[5] + j12*S[8];
      const c00 = jc00*j00 + jc02*j02 + 0.25;
      const c01 = jc01*j11 + jc02*j12;
      const c11 = jc11*j11 + jc12*j12 + 0.25;
      s.C = [c00, c01, c11];
      s.detC = c00*c11 - c01*c01;
      s.invC = [c11/s.detC, -c01/s.detC, c00/s.detC];
      s.rx = 3*Math.sqrt(c00); s.ry = 3*Math.sqrt(c11);
      s.eig = M.eig2(c00, c01, c11);
      splats.push(s);
    }
  }
  const W = data.width, H = data.height, n = W*H;
  const rgb = new Array(n*3).fill(0), Tbuf = new Array(n).fill(0);
  const depth = new Array(n).fill(NaN);
  const buckets = new Array(n);
  for (const s of splats) {
    const x0 = Math.max(0, Math.floor(s.u - 0.5 - s.rx));
    const x1 = Math.min(W-1, Math.ceil(s.u - 0.5 + s.rx));
    const y0 = Math.max(0, Math.floor(s.v - 0.5 - s.ry));
    const y1 = Math.min(H-1, Math.ceil(s.v - 0.5 + s.ry));
    const [i00, i01, i11] = s.invC;
    for (let py = y0; py <= y1; py++) {
      const dv = py + 0.5 - s.v;
      for (let px = x0; px <= x1; px++) {
        const du = px + 0.5 - s.u;
        const q = i00*du*du + 2*i01*du*dv + i11*dv*dv;
        if (q <= 9) {
          const idx = py*W+px;
          (buckets[idx] ||= []).push({ s, q });
        }
      }
    }
  }
  let totalHits = 0;
  for (let idx = 0; idx < n; idx++) {
    const hits = buckets[idx];
    let T = 1, r=0, g=0, b=0, wsum=0, dsum=0;
    if (hits) {
      totalHits += hits.length;
      hits.sort((a,b) => (a.s.z-b.s.z) || (a.s.pointId < b.s.pointId ? -1 : a.s.pointId > b.s.pointId ? 1 : 0));
      for (const h of hits) {
        const alpha = Math.min(0.99, h.s.opacity * Math.exp(-h.q/2));
        const w = T*alpha;
        h.alpha = alpha; h.Tbefore = T; h.w = w;
        r += w*h.s.color[0]; g += w*h.s.color[1]; b += w*h.s.color[2];
        wsum += w; dsum += w*h.s.z;
        T *= 1-alpha;
        h.Tafter = T;
      }
      if (wsum > 0) depth[idx] = dsum/wsum;
    }
    Tbuf[idx] = T;
    rgb[idx*3] = r + T*data.background[0];
    rgb[idx*3+1] = g + T*data.background[1];
    rgb[idx*3+2] = b + T*data.background[2];
  }
  return { splats, rgb, T: Tbuf, depth, buckets, invalid, culled, totalHits };
}

// ---- python reference dump ----
function pyDump(casePath) {
  const { execFileSync } = require("child_process");
  const py = `
import json, sys, math
sys.path.insert(0, "tools")
import reference_render as R
case = json.load(open(${JSON.stringify(casePath)}))
splats, errors, buf = R.render(case)
out = {"errors": errors, "pixels": []}
for py in range(case["height"]):
    for px in range(case["width"]):
        t = buf[py][px]
        out["pixels"].append({"px":px,"py":py,"rgb":t["linearRGB"],"T":t["T_final"],
            "depth":t["expectedDepth"],"pick":t["pick"],
            "ws":[(e["label"],e["w"]) for e in t["entries"]]})
out["splats"] = [{"label": s["label"], "C": s.get("C"), "u": s.get("u"), "v": s.get("v")} for s in splats]
print(json.dumps(out))
`;
  return JSON.parse(execFileSync("python3", ["-I", "-c", py], { cwd: process.cwd(), maxBuffer: 1<<28 }));
}

let failures = 0;
for (const name of ["overlap", "affine", "invalid", "capacity"]) {
  const data = JSON.parse(fs.readFileSync(`samples/data/${name}.json`, "utf8"));
  const t0 = performance.now();
  const got = renderPage(data);
  const ms = (performance.now() - t0).toFixed(1);
  const ref = pyDump(`samples/data/${name}.json`);
  let bad = 0;
  const n = data.width * data.height;
  for (let i = 0; i < n; i++) {
    const p = ref.pixels[i];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(got.rgb[i*3+k] - p.rgb[k]) > 1e-12 * (1 + Math.abs(p.rgb[k]))) { bad++; if (bad < 4) console.log(`  RGB mismatch ${name} (${p.px},${p.py})[${k}] ${got.rgb[i*3+k]} vs ${p.rgb[k]}`); }
    }
    if (Math.abs(got.T[i] - p.T) > 1e-12) { bad++; if (bad < 4) console.log(`  T mismatch ${name} (${p.px},${p.py})`); }
    const gd = got.depth[i];
    if (p.depth === null) { if (!Number.isNaN(gd)) { bad++; console.log(`  depth should be null ${name} (${p.px},${p.py}) got ${gd}`); } }
    else if (Math.abs(gd - p.depth) > 1e-11 * (1 + Math.abs(p.depth))) { bad++; if (bad < 4) console.log(`  depth mismatch ${name} (${p.px},${p.py}) ${gd} vs ${p.depth}`); }
  }
  // splat screen covariance comparison
  let cbad = 0;
  for (const rs of ref.splats) {
    const gs = got.splats.find(s => `${s.instId}/${s.pointId}` === rs.label);
    if (rs.C === null) { if (gs && gs.C) cbad++; continue; }
    if (!gs || !gs.C) { cbad++; continue; }
    const gC = [gs.C[0], gs.C[1], gs.C[1], gs.C[2]]; // JS stores [c00,c01,c11]; python is full symmetric 2x2
    for (let k = 0; k < 4; k++) if (Math.abs(gC[k] - rs.C[k]) > 1e-12) cbad++;
  }
  // pick check on pixels with contributions
  let pbad = 0;
  for (let i = 0; i < n; i++) {
    const hits = got.buckets[i];
    if (!hits || !hits.length) { if (ref.pixels[i].pick !== null) pbad++; continue; }
    const pick = hits.reduce((a,b) => (b.w > a.w || (b.w === a.w && b.s.pointId < a.s.pointId)) ? b : a);
    if (`${pick.s.instId}/${pick.s.pointId}` !== ref.pixels[i].pick) pbad++;
  }
  console.log(`${name.padEnd(9)} ${String(data.width+"x"+data.height).padEnd(9)} js=${ms}ms  pixelMismatch=${bad}  covMismatch=${cbad}  pickMismatch=${pbad}  invalid=${got.invalid} culled=${got.culled} pyErrors=${ref.errors.length}`);
  failures += bad + cbad + pbad;
}
process.exit(failures ? 1 : 0);
