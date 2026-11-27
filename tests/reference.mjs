// 独立参考实现：直接按定义做 DFT 求和（不经 FFT），用于与 src/core.js 对拍。
// 只适合小网格（W<=16），且刻意写得直白、无共享缓冲。

function axes(proj) {
  const W = proj.W, H = proj.H, M = 2 * W, N = 2 * H;
  const fx = new Float64Array(M), fy = new Float64Array(N);
  for (let m = 0; m < M; m++) fx[m] = (m < W ? m : m - M) / (M * proj.dx);
  for (let n = 0; n < N; n++) fy[n] = (n < H ? n : n - N) / (N * proj.dy);
  return { W, H, M, N, ox: W / 2, oy: H / 2, fx, fy };
}

function forward(proj, p, wave) {
  const { W, H, M, N, ox, oy } = axes(proj);
  const Ur = new Float64Array(M * N), Ui = new Float64Array(M * N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = 2 * Math.PI * wave.cycles * p[y * W + x];
      const dst = (y + oy) * M + ox + x;
      Ur[dst] = proj.amp[y * W + x] * Math.cos(a);
      Ui[dst] = proj.amp[y * W + x] * Math.sin(a);
    }
  }
  const Ar = new Float64Array(M * N), Ai = new Float64Array(M * N);
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < M; u++) {
      let sr = 0, si = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < M; x++) {
          const ang = -2 * Math.PI * (u * x / M + v * y / N);
          const c = Math.cos(ang), s = Math.sin(ang);
          const vr = Ur[y * M + x], vi = Ui[y * M + x];
          sr += vr * c - vi * s;
          si += vr * s + vi * c;
        }
      }
      Ar[v * M + u] = sr; Ai[v * M + u] = si;
    }
  }
  return { Ar, Ai };
}

function propagateSpectrum(proj, plane, wave, Ar, Ai) {
  const { W, H, M, N, ox, oy, fx, fy } = axes(proj);
  const Vr = new Float64Array(M * N), Vi = new Float64Array(M * N);
  const lam2 = wave.lambda * wave.lambda;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < M; x++) {
      let sr = 0, si = 0;
      for (let v = 0; v < N; v++) {
        const fy2 = fy[v] * fy[v];
        for (let u = 0; u < M; u++) {
          const s = 1 / lam2 - fx[u] * fx[u] - fy2;
          let hr = 1, hi = 0;
          if (plane.z !== 0) {
            if (s >= 0) {
              const a = 2 * Math.PI * plane.z * Math.sqrt(s);
              hr = Math.cos(a); hi = Math.sin(a);
            } else {
              hr = Math.exp(-2 * Math.PI * plane.z * Math.sqrt(-s));
            }
          }
          const ar = Ar[v * M + u], ai = Ai[v * M + u];
          const tr = ar * hr - ai * hi, ti = ar * hi + ai * hr;
          const ang = 2 * Math.PI * (u * x / M + v * y / N);
          const c = Math.cos(ang), sn = Math.sin(ang);
          sr += tr * c - ti * sn;
          si += tr * sn + ti * c;
        }
      }
      Vr[y * M + x] = sr / (M * N);
      Vi[y * M + x] = si / (M * N);
    }
  }
  const vr = new Float64Array(W * H), vi = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = (y + oy) * M + ox + x;
      vr[y * W + x] = Vr[src]; vi[y * W + x] = Vi[src];
    }
  }
  return { vr, vi };
}

// 某面在场 p 下的复场与强度
export function planeField(proj, p, plane, wave) {
  const { Ar, Ai } = forward(proj, p, wave);
  const { vr, vi } = propagateSpectrum(proj, plane, wave, Ar, Ai);
  const I = new Float64Array(proj.W * proj.H);
  for (let i = 0; i < I.length; i++) I[i] = vr[i] * vr[i] + vi[i] * vi[i];
  return { vr, vi, I };
}

// 全部面的损失与逐面损失（含 0.5 系数）
export function totalLoss(proj, p) {
  let loss = 0;
  const planeLoss = [];
  for (const plane of proj.planes) {
    const wave = proj.waves[plane.wave];
    const { I } = planeField(proj, p, plane, wave);
    let pl = 0;
    for (let i = 0; i < I.length; i++) {
      const d = I[i] - plane.target[i];
      pl += 0.5 * plane.weight[i] * d * d;
    }
    planeLoss.push(pl);
    loss += pl;
  }
  return { loss, planeLoss };
}

// 用中心差分独立求梯度（慢，仅小网格）
export function finiteDiffGrad(proj, p, h = 1e-6) {
  const n = proj.W * proj.H;
  const G = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pp = Float64Array.from(p), pm = Float64Array.from(p);
    pp[i] += h; pm[i] -= h;
    G[i] = (totalLoss(proj, pp).loss - totalLoss(proj, pm).loss) / (2 * h);
  }
  return G;
}
