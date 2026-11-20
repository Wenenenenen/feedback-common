/**
 * Minimal generic sparse iterative solver.
 *
 * The parameterizer is free to use a general-purpose sparse solver; this module
 * contains no mesh/parameterization logic, so it stays a plain linear-algebra
 * utility. It picks conjugate gradients for symmetric systems (the cotangent
 * Laplacian with fixed boundary) and BiCGSTAB otherwise, both with Jacobi
 * preconditioning, and always returns the best iterate it saw.
 */

export interface CsrMatrix {
  n: number;
  /** Row offsets, length n + 1. */
  rowPtr: Int32Array;
  /** Column indices, length nnz. */
  colIdx: Int32Array;
  /** Values, length nnz. */
  values: Float64Array;
}

export interface SparseSolveOptions {
  tolerance?: number;
  maxIterations?: number;
}

export interface SparseSolveResult {
  x: Float64Array;
  iterations: number;
  converged: boolean;
  /** ||b - A x|| / ||b|| (or absolute if ||b|| == 0). */
  relativeResidual: number;
  method: 'none' | 'cg' | 'bicgstab';
}

export function multiplyCsr(A: CsrMatrix, x: Float64Array, out?: Float64Array): Float64Array {
  const { n, rowPtr, colIdx, values } = A;
  const y = out ?? new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) sum += values[k] * x[colIdx[k]];
    y[i] = sum;
  }
  return y;
}

function norm2(v: Float64Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function dotN(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function diagonal(A: CsrMatrix): Float64Array {
  const d = new Float64Array(A.n);
  for (let i = 0; i < A.n; i++) {
    for (let k = A.rowPtr[i]; k < A.rowPtr[i + 1]; k++) {
      if (A.colIdx[k] === i) {
        d[i] = A.values[k];
        break;
      }
    }
  }
  return d;
}

function jacobiInverse(d: Float64Array): Float64Array {
  const inv = new Float64Array(d.length);
  for (let i = 0; i < d.length; i++) {
    const value = d[i];
    inv[i] = Number.isFinite(value) && Math.abs(value) > 1e-300 ? 1 / value : 1;
  }
  return inv;
}

function residualNorm(A: CsrMatrix, x: Float64Array, b: Float64Array): number {
  const ax = multiplyCsr(A, x);
  let s = 0;
  for (let i = 0; i < b.length; i++) {
    const d = b[i] - ax[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Full symmetry check: for every stored (i, j), A[i][j] === A[j][i]. */
export function isSymmetric(A: CsrMatrix): boolean {
  const { n, rowPtr, colIdx, values } = A;
  const valueAt = (i: number, j: number): number | undefined => {
    for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) {
      if (colIdx[k] === j) return values[k];
    }
    return undefined;
  };
  for (let i = 0; i < n; i++) {
    for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) {
      const j = colIdx[k];
      if (j === i) continue;
      const mirror = valueAt(j, i);
      const scale = Math.max(1, Math.abs(values[k]));
      if (mirror === undefined || Math.abs(mirror - values[k]) > 1e-12 * scale) return false;
    }
  }
  return true;
}

export function solveSparse(
  A: CsrMatrix,
  b: Float64Array,
  options: SparseSolveOptions = {},
): SparseSolveResult {
  const { n } = A;
  const tolerance = options.tolerance ?? 1e-12;
  const maxIterations = options.maxIterations ?? Math.max(500, n * 2);
  const bNorm = norm2(b);
  const scale = bNorm > 0 ? bNorm : 1;

  if (n === 0) {
    return { x: new Float64Array(0), iterations: 0, converged: true, relativeResidual: 0, method: 'none' };
  }

  const diag = diagonal(A);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(diag[i]) || Math.abs(diag[i]) < 1e-300) {
      return {
        x: new Float64Array(n),
        iterations: 0,
        converged: false,
        relativeResidual: 1,
        method: 'none',
      };
    }
  }
  const minv = jacobiInverse(diag);

  const symmetric = isSymmetric(A);
  const first = symmetric
    ? solveCg(A, b, minv, tolerance, maxIterations, scale)
    : solveBicgstab(A, b, minv, tolerance, maxIterations, scale);

  const firstResidual = residualNorm(A, first.x, b) / scale;
  if (firstResidual <= tolerance) {
    return {
      x: first.x,
      iterations: first.iterations,
      converged: true,
      relativeResidual: firstResidual,
      method: first.method,
    };
  }

  const alt = symmetric
    ? solveBicgstab(A, b, minv, tolerance, maxIterations, scale)
    : solveCg(A, b, minv, tolerance, maxIterations, scale);
  const altResidual = residualNorm(A, alt.x, b) / scale;
  if (altResidual < firstResidual) {
    return {
      x: alt.x,
      iterations: alt.iterations,
      converged: altResidual <= tolerance,
      relativeResidual: altResidual,
      method: alt.method,
    };
  }
  return {
    x: first.x,
    iterations: first.iterations,
    converged: false,
    relativeResidual: firstResidual,
    method: first.method,
  };
}

interface Iterate {
  x: Float64Array;
  iterations: number;
  relativeResidual: number;
  method: 'cg' | 'bicgstab';
}

function solveCg(
  A: CsrMatrix,
  b: Float64Array,
  minv: Float64Array,
  tolerance: number,
  maxIterations: number,
  scale: number,
): Iterate {
  const n = A.n;
  const x = new Float64Array(n);
  const r = b.slice();
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = minv[i] * r[i];
  const p = z.slice();
  const ap = new Float64Array(n);
  let rz = dotN(r, z);
  let residual = norm2(r) / scale;
  const result = (iterations: number): Iterate => ({
    x,
    iterations,
    relativeResidual: residual,
    method: 'cg',
  });
  if (residual <= tolerance) return result(0);
  if (!Number.isFinite(rz) || rz <= 0) return result(0);

  for (let iter = 1; iter <= maxIterations; iter++) {
    multiplyCsr(A, p, ap);
    const pAp = dotN(p, ap);
    if (!Number.isFinite(pAp) || pAp <= 0) break;
    const alpha = rz / pAp;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    residual = norm2(r) / scale;
    if (!Number.isFinite(residual)) break;
    if (residual <= tolerance) return result(iter);
    for (let i = 0; i < n; i++) z[i] = minv[i] * r[i];
    const rzNew = dotN(r, z);
    if (!Number.isFinite(rzNew) || rzNew <= 0) return result(iter);
    const beta = rzNew / rz;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    rz = rzNew;
  }
  return result(maxIterations);
}

/**
 * BiCGSTAB allowing one restart when the shadow residual breaks down; returns
 * the best iterate seen.
 */
function solveBicgstab(
  A: CsrMatrix,
  b: Float64Array,
  minv: Float64Array,
  tolerance: number,
  maxIterations: number,
  scale: number,
): Iterate {
  const n = A.n;
  const x = new Float64Array(n);
  const r = b.slice();
  let best = norm2(r) / scale;
  if (best <= tolerance) {
    return { x, iterations: 0, relativeResidual: best, method: 'bicgstab' };
  }
  let iterations = 0;
  const rhoFloor = 1e-300;

  for (let restart = 0; restart < 2; restart++) {
    const rhat = r.slice();
    let rho = 1;
    let alpha = 1;
    let omega = 1;
    const v = new Float64Array(n);
    const p = new Float64Array(n);
    const s = new Float64Array(n);
    const t = new Float64Array(n);
    const ph = new Float64Array(n);

    for (let iter = 0; iter < maxIterations; iter++) {
      iterations++;
      const rhoNew = dotN(rhat, r);
      if (!Number.isFinite(rhoNew) || Math.abs(rhoNew) < rhoFloor) break;
      const beta = (rhoNew / rho) * (alpha / omega);
      rho = rhoNew;
      for (let i = 0; i < n; i++) p[i] = r[i] + beta * (p[i] - omega * v[i]);

      multiplyCsr(A, p, v);
      const sigma = dotN(rhat, v);
      if (!Number.isFinite(sigma) || Math.abs(sigma) < rhoFloor) break;
      alpha = rho / sigma;

      for (let i = 0; i < n; i++) s[i] = r[i] - alpha * v[i];
      const sNorm = norm2(s) / scale;
      if (sNorm <= tolerance) {
        for (let i = 0; i < n; i++) x[i] += alpha * p[i];
        return { x, iterations, relativeResidual: sNorm, method: 'bicgstab' };
      }

      for (let i = 0; i < n; i++) ph[i] = minv[i] * s[i];
      multiplyCsr(A, ph, t);
      const tNormSq = dotN(t, t);
      if (!Number.isFinite(tNormSq) || tNormSq < 1e-300) break;
      omega = dotN(t, s) / tNormSq;
      if (!Number.isFinite(omega) || omega === 0) break;

      for (let i = 0; i < n; i++) x[i] += alpha * p[i] + omega * ph[i];
      for (let i = 0; i < n; i++) r[i] = s[i] - omega * t[i];

      const residual = norm2(r) / scale;
      if (residual < best) best = residual;
      if (!Number.isFinite(residual)) break;
      if (residual <= tolerance) return { x, iterations, relativeResidual: residual, method: 'bicgstab' };
      if (Math.abs(omega) < 1e-14) break;
    }
  }
  return { x, iterations, relativeResidual: best, method: 'bicgstab' };
}

/** Dense Gaussian elimination; used by tests and tiny debug cases. */
export function denseSolve(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-300) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const pv = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / pv;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = M[r][n];
    for (let c = r + 1; c < n; c++) sum -= M[r][c] * x[c];
    x[r] = sum / M[r][r];
  }
  return x;
}
