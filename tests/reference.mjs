// Independent dense reference implementation (no FFT) for testing the core solver.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { geometry } = require('../src/core.js');

export function buildCase({ M, P, Q, hLens, tLens, taps, delay, weights, limits, lambda, seed = 1, amplitude = 0.2 }) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const rn = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const H = [], T = [];
  const h_lengths = [], t_lengths = [];
  for (let m = 0; m < M; m++) {
    H.push([]); h_lengths.push([]);
    for (let p = 0; p < P; p++) {
      const L = hLens(m, p);
      h_lengths[m].push(L);
      const h = new Float64Array(L);
      let acc = 0;
      for (let n = 0; n < L; n++) { acc = 0.6 * acc + rn() * amplitude; h[n] = acc; }
      H[m].push(h);
    }
  }
  for (let m = 0; m < M; m++) {
    T.push([]); t_lengths.push([]);
    for (let q = 0; q < Q; q++) {
      const L = tLens(m, q);
      t_lengths[m].push(L);
      const t = new Float64Array(L);
      for (let n = 0; n < L; n++) t[n] = 0.05 * rn();
      T[m].push(t);
    }
  }
  return {
    M, P, Q, H, T, h_lengths, t_lengths,
    weights: weights || Array.from({ length: M }, () => 1),
    limits: limits || Array.from({ length: P }, () => 0.5),
    lambda, delay, taps,
  };
}

export function denseMatrices(cfg) {
  const { M, P, Q, H, T, taps, delay, weights, limits, lambda } = cfg;
  const geo = geometry(cfg);
  const N = geo.N;
  const n = P * taps;
  const B = new Float64Array(n * n);
  const cs = [];
  for (let q = 0; q < Q; q++) {
    const c = new Float64Array(n);
    for (let m = 0; m < M; m++) {
      const t = T[m][q];
      // residual contribution: conv(h_p, f_p)[k] - t[k-delay]
      for (let p = 0; p < P; p++) {
        const h = H[m][p];
        for (let k = 0; k < taps; k++) {
          let s = 0;
          // c[k] = sum_n h[n] * t_shift[n+k]
          for (let nn = 0; nn < h.length; nn++) {
            const idx = nn + k;
            if (idx >= N) continue;
            const ti = idx - delay;
            if (ti >= 0 && ti < t.length) s += h[nn] * t[ti];
          }
          c[p * taps + k] += weights[m] * s;
        }
      }
    }
    cs.push(c);
  }
  // B = sum_m w H_m^T H_m + lambda I, H_m columns per p
  for (let m = 0; m < M; m++) {
    for (let p = 0; p < P; p++) {
      const h1 = H[m][p];
      for (let q = 0; q < P; q++) {
        const h2 = H[m][q];
        const corr = new Float64Array(taps);
        // (H_p^T H_q)[k1,k2] = sum_n h1[n-k1] h2[n-k2]?? use direct: entry (k1,k2)=sum_n h1[n+k1]... 
        // conv(h1,f1) at n = sum_i h1[i] f1[n-i]. For n in [0,N):
        // d/d f1[k1] conv = h1[n-k1]; d/d f2[k2] = h2[n-k2].
        // entry = sum_n h1[n-k1] h2[n-k2], n over 0..N-1 where both defined.
        for (let k1 = 0; k1 < taps; k1++) {
          for (let k2 = 0; k2 < taps; k2++) {
            let s = 0;
            const n0 = Math.max(k1, k2);
            const n1 = Math.min(N - 1, k1 + h1.length - 1, k2 + h2.length - 1);
            for (let nn = n0; nn <= n1; nn++) s += h1[nn - k1] * h2[nn - k2];
            B[(p * taps + k1) * n + (q * taps + k2)] += weights[m] * s;
          }
        }
      }
    }
  }
  for (let i = 0; i < n; i++) B[i * n + i] += lambda;
  return { B, cs, n, geo };
}

export function directResidual(cfg, filters, q) {
  const { M, P, H, T, taps, delay, weights } = cfg;
  const N = geometry(cfg).N;
  const out = [];
  for (let m = 0; m < M; m++) {
    const y = new Float64Array(N);
    for (let p = 0; p < P; p++) {
      const h = H[m][p];
      for (let i = 0; i < h.length; i++) {
        for (let k = 0; k < taps; k++) {
          const idx = i + k;
          if (idx < N) y[idx] += h[i] * filters[p * taps + k];
        }
      }
    }
    const t = T[m][q];
    const r = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      const tv = n - delay >= 0 && n - delay < t.length ? t[n - delay] : 0;
      r[n] = y[n] - tv;
    }
    out.push(r);
  }
  return out;
}

export function objectiveFromFilters(cfg, perChannelFilters) {
  const { Q, weights, lambda, M, taps } = cfg;
  const N = geometry(cfg).N;
  const perChannel = [];
  let total = 0;
  for (let q = 0; q < Q; q++) {
    const res = directResidual(cfg, perChannelFilters[q], q);
    let s = 0;
    for (let m = 0; m < M; m++) {
      let ss = 0;
      for (let n = 0; n < N; n++) ss += res[m][n] * res[m][n];
      s += weights[m] * ss;
    }
    let ts = 0;
    const f = perChannelFilters[q];
    for (let i = 0; i < f.length; i++) ts += f[i] * f[i];
    perChannel.push(s + lambda * ts);
    total += s + lambda * ts;
  }
  return { total, perChannel };
}

// Reference box-QP solve: primal active-set with a ratio test (finite termination).
export function solveDenseQP(B, c, G, n, opts = {}) {
  const f = new Float64Array(n);
  const fixed = new Uint8Array(n); // 1 = at a bound (in working set)
  const maxOuter = opts.maxOuter || 20000;
  const tol = opts.tol || 1e-13;
  const Gv = new Float64Array(n);
  for (let i = 0; i < n; i++) Gv[i] = G[i];
  const grad = () => {
    const g = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = -c[i];
      for (let j = 0; j < n; j++) s += B[i * n + j] * f[j];
      g[i] = s;
    }
    return g;
  };
  let converged = false;
  for (let outer = 0; outer < maxOuter; outer++) {
    const idx = [];
    for (let i = 0; i < n; i++) if (!fixed[i]) idx.push(i);
    const k = idx.length;
    const dir = new Float64Array(n);
    if (k > 0) {
      const A = new Float64Array(k * k), rhs = new Float64Array(k);
      for (let i = 0; i < k; i++) {
        let b = c[idx[i]];
        for (let j = 0; j < n; j++) if (fixed[j]) b -= B[idx[i] * n + j] * f[j];
        rhs[i] = b;
        for (let j = 0; j < k; j++) A[i * k + j] = B[idx[i] * n + idx[j]];
      }
      const sol = cholSolve(A, rhs, k);
      for (let i = 0; i < k; i++) dir[idx[i]] = sol[i] - f[idx[i]];
    }
    let dmax = 0;
    for (let i = 0; i < n; i++) {
      const v = fixed[i] ? 0 : dir[i];
      if (Math.abs(v) > dmax) dmax = Math.abs(v);
    }
    if (dmax <= 1e-15 * (1 + Math.max(1, Float64Array.from(c).reduce((a, v) => Math.max(a, Math.abs(v)), 0)))) {
      // stationary on the working set: check KKT multipliers
      const g = grad();
      let released = 0;
      for (let i = 0; i < n; i++) {
        if (!fixed[i]) continue;
        const atUpper = f[i] > 0;
        const mult = atUpper ? g[i] : -g[i];
        // g at a bound must not point into the feasible interior
        if (mult < -tol) { fixed[i] = 0; released++; }
      }
      if (released === 0) { converged = true; break; }
      continue;
    }
    // ratio test along dir
    let alpha = 1;
    let block = -1;
    for (let i = 0; i < n; i++) {
      if (fixed[i] || dir[i] === 0) continue;
      const hi = Gv[i], lo = -Gv[i];
      if (dir[i] > 0 && f[i] + dir[i] * alpha > hi) {
        const a = (hi - f[i]) / dir[i];
        if (a < alpha) { alpha = a; block = i; }
      } else if (dir[i] < 0 && f[i] + dir[i] * alpha < lo) {
        const a = (lo - f[i]) / dir[i];
        if (a < alpha) { alpha = a; block = i; }
      }
    }
    for (let i = 0; i < n; i++) if (!fixed[i]) f[i] += alpha * dir[i];
    if (block >= 0) {
      f[block] = f[block] > 0 ? Gv[block] : -Gv[block];
      fixed[block] = 1;
    } else {
      // full step: clamp tiny roundoff
      for (let i = 0; i < n; i++) {
        if (fixed[i]) continue;
        if (f[i] > Gv[i]) f[i] = Gv[i];
        else if (f[i] < -Gv[i]) f[i] = -Gv[i];
        if (Math.abs(f[i]) >= Gv[i] * (1 - 1e-15)) fixed[i] = 1;
      }
    }
  }
  const g = grad();
  let pg = 0;
  for (let i = 0; i < n; i++) {
    let t = f[i] - g[i];
    if (t < -Gv[i]) t = -Gv[i]; else if (t > Gv[i]) t = Gv[i];
    pg = Math.max(pg, Math.abs(f[i] - t));
  }
  return { f, g, pg, converged };
}

function cholSolve(A, b, n) {
  const L = A.slice();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = L[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) L[i * n + j] = Math.sqrt(Math.max(s, 1e-300));
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}
