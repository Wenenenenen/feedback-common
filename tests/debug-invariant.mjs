// 调试：检查正/反向 DP 的 f+g==S* 不变量在哪一格被破坏
import { parseFingerprints, hamming, BAND, W } from '../web/algo.js';

const POP = new Int32Array(65536);
for (let x = 0; x < 65536; x++) {
  let v = x;
  v = v - ((v >> 1) & 0x5555);
  v = (v & 0x3333) + ((v >> 2) & 0x3333);
  POP[x] = (((v + (v >> 4)) & 0x0f0f) * 0x0101) >> 8;
}
const ham = (a, b, c, d) => {
  const xh = (a ^ c) >>> 0;
  const xl = (b ^ d) >>> 0;
  return POP[xh >>> 16] + POP[xh & 0xffff] + POP[xl >>> 16] + POP[xl & 0xffff];
};

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function makeFp(n, seed, freezeChance = 0, dupChance = 0) {
  const r = rng(seed);
  const arr = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    if (prev !== null && r() < freezeChance) arr.push(prev);
    else if (prev !== null && r() < dupChance) {
      const v = BigInt('0x' + prev);
      const flip = 1n << BigInt(Math.floor(r() * 64));
      prev = (v ^ flip).toString(16).padStart(16, '0');
      arr.push(prev);
    } else {
      let v = 0n;
      for (let k = 0; k < 4; k++) v = (v << 16n) | BigInt(Math.floor(r() * 65536));
      prev = v.toString(16).padStart(16, '0');
      arr.push(prev);
    }
  }
  return arr;
}
function makeDelivery(aArr, seed, editRate) {
  const r = rng(seed);
  const b = [];
  for (const f of aArr) {
    if (r() < editRate) continue;
    b.push(f);
    if (r() < editRate) b.push(f);
  }
  if (b.length === 0) b.push(aArr[0]);
  return b;
}

const aArr = makeFp(40, 999, 0.3, 0.3);
const bArr = makeDelivery(aArr, 888, 0.15);
const A = parseFingerprints(aArr, 'A');
const B = parseFingerprints(bArr, 'B');
const params = { maxDistance: 4, gapOpen: 9, gapExtend: 2 };
const N = A.hi.length;
const M = B.hi.length;
const K = N + M + 1;
const openK = params.gapOpen * K + 1;
const extK = params.gapExtend * K;
const INF = Infinity;
const col = (i, j) => j - i + BAND;
const jLoAt = (i) => Math.max(0, i - BAND);
const jHiAt = (i) => Math.min(M, i + BAND);
const jLoRev = (i) => Math.max(0, i - BAND - 1);
const jHiRev = (i) => Math.min(M, i + BAND + 1);

// 完整全网格正向 f（三状态）
const fM = Array.from({ length: N + 1 }, () => new Float64Array(W).fill(INF));
const fX = Array.from({ length: N + 1 }, () => new Float64Array(W).fill(INF));
const fY = Array.from({ length: N + 1 }, () => new Float64Array(W).fill(INF));
fM[0][col(0, 0)] = 0;
const min3 = (a, b, c) => Math.min(a, b, c);
for (let i = 0; i <= N; i++) {
  for (let j = jLoAt(i); j <= jHiAt(i); j++) {
    if (i === 0 && j === 0) continue;
    const c = col(i, j);
    if (i > 0) {
      // M
      if (j > 0) {
        const d = ham(A.hi[i - 1], A.lo[i - 1], B.hi[j - 1], B.lo[j - 1]);
        if (d <= params.maxDistance) {
          const pv = min3(fM[i - 1][c], fX[i - 1][c], fY[i - 1][c]);
          if (pv !== INF) fM[i][c] = d * K + pv;
        }
      }
      // X：前驱 (i-1,j) 列 c+1
      if (c + 1 < W) {
        let best = INF;
        if (fX[i - 1][c + 1] !== INF) best = Math.min(best, fX[i - 1][c + 1] + extK);
        if (fM[i - 1][c + 1] !== INF) best = Math.min(best, fM[i - 1][c + 1] + openK);
        if (fY[i - 1][c + 1] !== INF) best = Math.min(best, fY[i - 1][c + 1] + openK);
        fX[i][c] = best;
      }
    }
    // Y：前驱 (i,j-1) 列 c-1
    if (j > 0 && c - 1 >= 0) {
      let best = INF;
      if (fY[i][c - 1] !== INF) best = Math.min(best, fY[i][c - 1] + extK);
      if (fM[i][c - 1] !== INF) best = Math.min(best, fM[i][c - 1] + openK);
      if (fX[i][c - 1] !== INF) best = Math.min(best, fX[i][c - 1] + openK);
      fY[i][c] = best;
    }
  }
}
const endCol = col(N, M);
const Sstar = min3(fM[N][endCol], fX[N][endCol], fY[N][endCol]);
console.log('N,M,Sstar =', N, M, Sstar);

// 完整全网格反向 g
const gM = Array.from({ length: N + 1 }, () => new Float64Array(W).fill(INF));
const gX = Array.from({ length: N + 1 }, () => new Float64Array(W).fill(INF));
const gY = Array.from({ length: N + 1 }, () => new Float64Array(W).fill(INF));
gM[N][endCol] = 0; gX[N][endCol] = 0; gY[N][endCol] = 0;
for (let i = N; i >= 0; i--) {
  // 到达态语义反向：Y 依赖同行 j+1（j 升序），X/M 依赖 i+1 行
  for (let j = jLoAt(i); j <= jHiAt(i); j++) {
    if (i === N && j === M) continue;
    const c = col(i, j);
    const nc = c - 1; // (i+1,j)
    let mBest = INF;
    if (i < N && j < M) {
      const d = ham(A.hi[i], A.lo[i], B.hi[j], B.lo[j]);
      if (d <= params.maxDistance) {
        const tail = min3(gM[i + 1][c], gX[i + 1][c], gY[i + 1][c]);
        if (tail !== INF) mBest = d * K + tail;
      }
    }
    let xBest = INF;
    if (i < N && nc >= 0) {
      if (gX[i + 1][nc] !== INF) xBest = extK + gX[i + 1][nc];
      const tail = min3(gM[i + 1][nc], gX[i + 1][nc], gY[i + 1][nc]);
      if (tail !== INF) { const v = openK + tail; if (v < xBest) xBest = v; }
    }
    let yBest = INF;
    if (j < M && c + 1 < W) {
      if (gY[i][c + 1] !== INF) yBest = extK + gY[i][c + 1];
      const tail = min3(gM[i][c + 1], gX[i][c + 1], gY[i][c + 1]);
      if (tail !== INF) { const v = openK + tail; if (v < yBest) yBest = v; }
    }
    gM[i][c] = mBest;
    gX[i][c] = xBest;
    gY[i][c] = yBest;
    if (i === N && j >= 36) {
      console.log(`DBG rowN j=${j} c=${c} yBest=${yBest} mBest=${mBest}`);
    }
  }
}
console.log('gM origin =', gM[0][col(0, 0)], ' 应等于 Sstar');
console.log('终点行 i=N 非INF格子数：',
  gM[N].filter((v) => v !== INF).length,
  gX[N].filter((v) => v !== INF).length,
  gY[N].filter((v) => v !== INF).length);
console.log('N-1 行非INF：',
  gM[N - 1].filter((v) => v !== INF).length,
  gX[N - 1].filter((v) => v !== INF).length,
  gY[N - 1].filter((v) => v !== INF).length);
console.log('jLoAt(N)=', jLoAt(N), 'jHiAt(N)=', jHiAt(N), 'endCol=', endCol);
for (let j = 34; j <= 39; j++) {
  const c = col(N, j);
  console.log('rowN j=', j, 'col=', c, 'gM=', gM[N][c], 'gX=', gX[N][c], 'gY=', gY[N][c]);
}
console.log('反向循环结束后 i 行抽样 i=0:', gM[0][col(0, 0)]);

// 不变量：任何最优路径上的格/状态都有 f+g==Sstar；检查每格是否至少存在一个状态满足
let badCells = 0;
for (let i = 0; i <= N; i++) {
  for (let j = jLoAt(i); j <= jHiAt(i); j++) {
    const c = col(i, j);
    const fs = [fM[i][c], fX[i][c], fY[i][c]];
    const gs = [gM[i][c], gX[i][c], gY[i][c]];
    let ok = false;
    for (let s = 0; s < 3; s++) if (fs[s] !== INF && gs[s] !== INF && fs[s] + gs[s] === Sstar) ok = true;
    const reachable = fs.some((v) => v !== INF);
    if (reachable && !ok) {
      badCells++;
      if (badCells <= 10) console.log('坏格', i, j, 'f=', fs, 'g=', gs);
    }
  }
}
console.log('坏格数：', badCells);

// 模拟贪心行走（全网格），看在哪一步失败
let ci = 0;
let cj = 0;
let cs = 0; // 0=M
let prefix = 0;
const path = [];
while (!(ci === N && cj === M)) {
  const c = col(ci, cj);
  let moved = false;
  if (ci < N && cj < M) {
    const d = ham(A.hi[ci], A.lo[ci], B.hi[cj], B.lo[cj]);
    if (d <= params.maxDistance) {
      const nc = col(ci + 1, cj + 1);
      if (prefix + d * K + gM[ci + 1][nc] === Sstar) {
        path.push('m'); prefix += d * K; ci++; cj++; cs = 0; moved = true;
      }
    }
  }
  if (!moved && ci < N) {
    const nc = col(ci + 1, cj);
    const stepK = cs === 1 ? extK : openK;
    if (nc >= 0 && nc < W && prefix + stepK + gX[ci + 1][nc] === Sstar) {
      path.push('x'); prefix += stepK; ci++; cs = 1; moved = true;
    }
  }
  if (!moved && cj < M) {
    const nc = col(ci, cj + 1);
    const stepK = cs === 2 ? extK : openK;
    if (nc >= 0 && nc < W && prefix + stepK + gY[ci][nc] === Sstar) {
      path.push('y'); prefix += stepK; cj++; cs = 2; moved = true;
    }
  }
  if (!moved) {
    console.log('行走失败于', ci, cj, 'state', cs, 'prefix', prefix);
    break;
  }
}
console.log('贪心路径:', path.join(''), '长度', path.length);
