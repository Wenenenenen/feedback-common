/*
 * 合成场景对拍：z=0 空洞、遮挡缺口、全空帧、双向非零 dy。
 * 直接在 Node 内调用 JS 引擎，并把同一组数据写成临时文件交给 reference.py，
 * 比较全部 65 档 × 多容差的 PPM/P5 字节。
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as E from '../app/engine.js';

function makeCase(kind) {
  const W = 24;
  const H = 18;
  const N = W * H;
  const rgbA = new Uint8Array(N * 3);
  const rgbB = new Uint8Array(N * 3);
  const dxA = new Int16Array(N);
  const dyA = new Int16Array(N);
  const zA = new Uint16Array(N);
  const dxB = new Int16Array(N);
  const dyB = new Int16Array(N);
  const zB = new Uint16Array(N);

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const d = y * W + x;
      rgbA[d * 3] = (x * 11 + y * 7) & 255;
      rgbA[d * 3 + 1] = (x * 5 + y * 13) & 255;
      rgbA[d * 3 + 2] = (x * 17 + y * 3) & 255;
      rgbB[d * 3] = (x * 3 + y * 19) & 255;
      rgbB[d * 3 + 1] = (x * 23 + y * 5) & 255;
      rgbB[d * 3 + 2] = (x * 7 + y * 29) & 255;

      const fg = x >= 6 && x < 14 && y >= 4 && y < 12;
      zA[d] = fg ? 30 : 90 + ((x + y) % 20);
      zB[d] = fg ? 30 : 90 + ((x * 2 + y) % 20);
      dxA[d] = fg ? 24 : 8;      // 前景右移 3px，背景右移 1px
      dxB[d] = fg ? -24 : -8;
      dyA[d] = fg ? 0 : ((x % 3) - 1) * 2; // 背景带垂直亚像素位移
      dyB[d] = -dyA[d];
    }
  }

  if (kind === 'zhole') {
    // a 中挖一块无深度区；b 中另挖一块，制造补洞与越界
    for (let y = 2; y < 6; y += 1) {
      for (let x = 18; x < 22; x += 1) zA[y * W + x] = 0;
    }
    for (let y = 10; y < 14; y += 1) {
      for (let x = 2; x < 6; x += 1) zB[y * W + x] = 0;
    }
  } else if (kind === 'gap') {
    // 让中间一列附近只出不进：把右侧来源整体推得更远，形成缺口
    for (let d = 0; d < N; d += 1) {
      dxA[d] = 40;
      dxB[d] = -40;
    }
  } else if (kind === 'allempty') {
    zA.fill(0);
    zB.fill(0);
  } else if (kind === 'sparse') {
    // 绝大多数像素无深度，仅留稀疏源，强制大面积补洞（分类 3）
    zA.fill(0);
    zB.fill(0);
    const seeds = [[3, 4], [12, 6], [20, 15], [8, 16]];
    for (const [sx, sy] of seeds) {
      const d = sy * W + sx;
      zA[d] = 50;
      zB[d] = 50;
      dxA[d] = 8;
      dxB[d] = -8;
      dyA[d] = 0;
      dyB[d] = 0;
    }
  }

  const bin = (dx, dy, z) => {
    const buf = new Uint8Array(N * 6);
    const dv = new DataView(buf.buffer);
    for (let d = 0, o = 0; d < N; d += 1, o += 6) {
      dv.setInt16(o, dx[d], true);
      dv.setInt16(o + 2, dy[d], true);
      dv.setUint16(o + 4, z[d], true);
    }
    return buf;
  };
  const ppm = (rgb) => E.encodePPM(rgb, W, H);

  return {
    W, H,
    ds: {
      width: W, height: H, rgbA, rgbB,
      flowA: { dx: dxA, dy: dyA, z: zA },
      flowB: { dx: dxB, dy: dyB, z: zB },
      names: {},
    },
    files: {
      'a.ppm': ppm(rgbA), 'b.ppm': ppm(rgbB),
      'a.bin': bin(dxA, dyA, zA), 'b.bin': bin(dxB, dyB, zB),
    },
  };
}

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const dir = mkdtempSync(join(tmpdir(), 'flow-synth-'));
let failures = 0;

for (const kind of ['zhole', 'gap', 'allempty', 'sparse']) {
  const made = makeCase(kind);
  for (const [name, data] of Object.entries(made.files)) {
    writeFileSync(join(dir, name), data);
  }
  const out = join(dir, 'out');
  const passes = {
    passA: E.computeRoundTrip(made.ds.flowA, made.ds.flowB, made.W, made.H),
    passB: E.computeRoundTrip(made.ds.flowB, made.ds.flowA, made.W, made.H),
  };
  for (const tol of [0, 25, 65535]) {
    execFileSync('python3', [
      '-I', 'tools/reference.py', '--case', dir, '--out', out,
      '--steps', Array.from({ length: 65 }, (_, i) => i).join(','),
      '--tol', String(tol),
    ]);
    const classSeen = new Set();
    for (let n = 0; n <= 64; n += 1) {
      const res = n === 0 ? E.endpointFrame(made.ds, 0)
        : n === 64 ? E.endpointFrame(made.ds, 1)
          : E.renderFrame(made.ds, n, tol, passes);
      for (const c of res.cls) classSeen.add(c);
      const tag = String(n).padStart(2, '0');
      const refPpm = new Uint8Array(readFileSync(join(out, `frame_${tag}.ppm`)));
      const refP5 = new Uint8Array(readFileSync(join(out, `class_${tag}.p5`)));
      assert.ok(eq(E.encodePPM(res.rgb, made.W, made.H), refPpm),
        `${kind} tol=${tol} n=${n} PPM 不一致`);
      assert.ok(eq(E.encodeP5(res.cls, made.W, made.H), refP5),
        `${kind} tol=${tol} n=${n} P5 不一致`);
    }
    console.log(`  合成场景 ${kind} tol=${tol}：65 档逐字节一致，出现分类 ${[...classSeen].sort().join(',')}`);
  }
}

rmSync(dir, { recursive: true, force: true });
if (failures) process.exit(1);
console.log('合成场景全部通过');
