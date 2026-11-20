import { describe, expect, it } from 'vitest';
import { denseSolve, isSymmetric, multiplyCsr, solveSparse, type CsrMatrix } from '../src/core/solver.js';

function fromDense(A: number[][]): CsrMatrix {
  const n = A.length;
  const rowPtr = new Int32Array(n + 1);
  const colIdx: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (A[i][j] !== 0) {
        colIdx.push(j);
        values.push(A[i][j]);
      }
    }
    rowPtr[i + 1] = colIdx.length;
  }
  return { n, rowPtr, colIdx: Int32Array.from(colIdx), values: Float64Array.from(values) };
}

const residual = (A: CsrMatrix, x: Float64Array, b: Float64Array): number => {
  const ax = multiplyCsr(A, x);
  let n = 0;
  let d = 0;
  for (let i = 0; i < b.length; i++) {
    n += (ax[i] - b[i]) ** 2;
    d += b[i] ** 2;
  }
  return Math.sqrt(n / (d || 1));
};

describe('denseSolve', () => {
  it('solves a small system exactly', () => {
    const x = denseSolve(
      [
        [2, -1],
        [-1, 2],
      ],
      [1, 0],
    );
    expect(x![0]).toBeCloseTo(2 / 3, 12);
    expect(x![1]).toBeCloseTo(1 / 3, 12);
  });

  it('returns null for a singular system', () => {
    expect(
      denseSolve(
        [
          [1, 1],
          [1, 1],
        ],
        [1, 2],
      ),
    ).toBeNull();
  });
});

describe('solveSparse', () => {
  const tridiagonal = (n: number): CsrMatrix => {
    const A: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 2 : Math.abs(i - j) === 1 ? -1 : 0)),
    );
    return fromDense(A);
  };

  it('solves a symmetric tridiagonal system', () => {
    const n = 40;
    const A = tridiagonal(n);
    expect(isSymmetric(A)).toBe(true);
    // x* = ones => b = A * ones, with b[0] = 1, b[n-1] = 1, interior 0.
    const b = new Float64Array(n);
    b[0] = 1;
    b[n - 1] = 1;
    const result = solveSparse(A, b, { tolerance: 1e-12 });
    expect(result.converged).toBe(true);
    expect(residual(A, result.x, b)).toBeLessThan(1e-10);
    // Cross-check against a dense solve.
    const dense = denseSolve(
      Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 2 : Math.abs(i - j) === 1 ? -1 : 0)),
      ),
      Array.from(b),
    )!;
    for (let i = 0; i < n; i++) {
      expect(result.x[i]).toBeCloseTo(dense[i], 8);
    }
  });

  it('solves an asymmetric system with BiCGSTAB', () => {
    const A = fromDense([
      [4, 1, 0],
      [1, 3, 1],
      [0, 2, 5],
    ]);
    expect(isSymmetric(A)).toBe(false);
    const b = Float64Array.from([5, 5, 7]);
    const result = solveSparse(A, b);
    expect(result.converged).toBe(true);
    expect(residual(A, result.x, b)).toBeLessThan(1e-10);
  });

  it('reports a singular matrix instead of returning garbage', () => {
    const A = fromDense([
      [0, 1],
      [1, 0],
    ]);
    // Zero diagonal -> Jacobi has nothing to work with.
    const result = solveSparse(A, Float64Array.from([1, 1]));
    expect(result.converged).toBe(false);
  });

  it('handles the empty system', () => {
    const result = solveSparse({ n: 0, rowPtr: Int32Array.from([0]), colIdx: new Int32Array(0), values: new Float64Array(0) }, new Float64Array(0));
    expect(result.converged).toBe(true);
    expect(result.method).toBe('none');
  });
});
