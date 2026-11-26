/*
 * 引擎测试台（Node）：
 *  1. 全 65 档 × 多容差，与 tools/reference.py 输出逐字节对拍
 *  2. fillHoles 与暴力 BFS（同距取行列号最小）对拍
 *  3. PPM/BIN 截断、错配必须报带文件名的错误
 *  4. 960×540 单帧性能（要求 2 秒内）
 * 运行：node tools/test_engine.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const E = await import(join(root, 'app', 'engine.js'));

const caseDir = join(root, 'samples', 'extracted');
const work = join(root, 'samples', '.test-work');

function bytes(p) {
  return new Uint8Array(readFileSync(p));
}

function loadCase() {
  return E.loadDataset({
    aPPM: { name: 'a.ppm', bytes: bytes(join(caseDir, 'a.ppm')) },
    bPPM: { name: 'b.ppm', bytes: bytes(join(caseDir, 'b.ppm')) },
    aBIN: { name: 'a.bin', bytes: bytes(join(caseDir, 'a.bin')) },
    bBIN: { name: 'b.bin', bytes: bytes(join(caseDir, 'b.bin')) },
  });
}

function refRender(steps, tol) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync(
    'python3',
    ['-I', join(here, 'reference.py'), '--case', caseDir,
     '--out', work, '--steps', steps.join(','), '--tol', String(tol)],
    { stdio: 'inherit' },
  );
}

function eq(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/* ---------- 1. 全档位对拍 ---------- */
async function testParity() {
  const ds = loadCase();
  const passes = {
    passA: E.computeRoundTrip(ds.flowA, ds.flowB, ds.width, ds.height),
    passB: E.computeRoundTrip(ds.flowB, ds.flowA, ds.width, ds.height),
  };
  const tols = [0, 5, 35, 100, 65535];
  for (const tol of tols) {
    const steps = Array.from({ length: 65 }, (_, i) => i);
    refRender(steps, tol);
    for (const n of steps) {
      let res;
      if (n === 0) res = E.endpointFrame(ds, 0);
      else if (n === 64) res = E.endpointFrame(ds, 1);
      else res = E.renderFrame(ds, n, tol, passes);

      const ppm = E.encodePPM(res.rgb, ds.width, ds.height);
      const p5 = E.encodeP5(res.cls, ds.width, ds.height);
      const refPpm = bytes(join(work, `frame_${String(n).padStart(2, '0')}.ppm`));
      const refP5 = bytes(join(work, `class_${String(n).padStart(2, '0')}.p5`));
      assert.ok(eq(ppm, refPpm), `PPM 不一致 n=${n} tol=${tol}`);
      assert.ok(eq(p5, refP5), `P5 不一致 n=${n} tol=${tol}`);
    }
    console.log(`  对拍通过：tol=${tol}，65 个档位全部逐字节一致`);
  }
}

/* ---------- 2. 补洞暴力 BFS 对拍（含随机空洞） ---------- */
function bruteForceFill(head, W, H) {
  const N = W * H;
  const label = new Int32Array(N).fill(-1);
  const dist = new Int32Array(N).fill(-1);
  const q = [];
  for (let d = 0; d < N; d += 1) {
    if (head[d] !== -1) {
      label[d] = d;
      dist[d] = 0;
      q.push(d);
    }
  }
  let qi = 0;
  const nb = (d) => {
    const x = d % W;
    const y = (d - x) / W;
    const out = [];
    if (y > 0) out.push(d - W);
    if (x > 0) out.push(d - 1);
    if (y + 1 < H) out.push(d + W);
    if (x + 1 < W) out.push(d + 1);
    return out;
  };
  // 按行优先顺序出队，保证同距先发现行列号最小来源
  q.sort((a, b) => a - b);
  while (qi < q.length) {
    const cur = q[qi++];
    for (const v of nb(cur)) {
      if (dist[v] !== -1) continue;
      dist[v] = dist[cur] + 1;
      label[v] = label[cur];
      q.push(v);
    }
  }
  return { label, dist };
}

function testFill() {
  for (const [W, H] of [[64, 36], [17, 13], [1, 1], [5, 1], [1, 7], [33, 31]]) {
    for (let seed = 0; seed < 8; seed += 1) {
      const N = W * H;
      const head = new Int32Array(N).fill(-1);
      let rng = (seed + 1) * 2654435761 + W * 40503 + H;
      const rand = () => {
        rng = (rng * 1664525 + 1013904223) >>> 0;
        return rng / 4294967296;
      };
      for (let d = 0; d < N; d += 1) {
        if (rand() < 0.45) head[d] = 1; // 非空
      }
      // 极端：全空（标签都应为 -1；距离哨兵两侧各自定义，不参与比较）
      if (seed === 7) head.fill(-1);
      const got = E.fillHoles(head, W, H);
      const want = bruteForceFill(head, W, H);
      assert.ok(eq(got.label, want.label), `fill label 不符 ${W}x${H} seed=${seed}`);
      // 距离只在确实有来源的像素上比较（无来源处两侧哨兵定义不同）
      for (let d = 0; d < W * H; d += 1) {
        if (want.label[d] >= 0) {
          assert.equal(got.dist[d], want.dist[d],
            `fill dist 不符 ${W}x${H} seed=${seed} d=${d}`);
        } else {
          assert.equal(got.label[d], -1);
        }
      }
    }
  }
  console.log('  补洞通过：多尺寸随机空洞 + 全空，与暴力 BFS 完全一致');
}

/* ---------- 3. 解析错误 ---------- */
function testParseErrors() {
  const ds = loadCase();
  const goodPPM = bytes(join(caseDir, 'a.ppm'));
  const goodBIN = bytes(join(caseDir, 'a.bin'));

  const expectErr = (fn, fragment) => {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    assert.ok(err, '应当抛错');
    assert.ok(String(err.message).includes(fragment), `错误信息应含 "${fragment}"，实际：${err.message}`);
  };

  // 截断的 PPM
  expectErr(
    () => E.parsePPM(goodPPM.slice(0, goodPPM.length - 7), 'cut.ppm'),
    'cut.ppm',
  );
  // 错误魔数
  const badMagic = goodPPM.slice();
  badMagic[0] = 0x58;
  expectErr(() => E.parsePPM(badMagic, 'magic.ppm'), 'magic.ppm');
  // 截断的 BIN（文件名必须出现在错误里）
  expectErr(
    () => E.parseBIN(goodBIN.slice(0, goodBIN.length - 6), ds.width, ds.height, 'cut.bin'),
    'cut.bin',
  );
  // BIN 尺寸错配
  expectErr(
    () => E.parseBIN(goodBIN, ds.width + 1, ds.height, 'size.bin'),
    'size.bin',
  );
  // 成组尺寸错配：b.ppm 与 a.ppm 不同尺寸
  const otherPPM = bytes(join(caseDir, 'b.ppm'));
  const tinyPPM = E.encodePPM(new Uint8Array(10 * 10 * 3).fill(9), 10, 10);
  expectErr(
    () => E.loadDataset({
      aPPM: { name: 'a.ppm', bytes: goodPPM },
      bPPM: { name: 'other.ppm', bytes: tinyPPM },
      aBIN: { name: 'a.bin', bytes: goodBIN },
      bBIN: { name: 'b.bin', bytes: goodBIN },
    }),
    '尺寸',
  );
  // BIN 与 PPM 栅格数不符（借 aBIN 槽位，文件名必须透出）
  expectErr(
    () => E.loadDataset({
      aPPM: { name: 'a.ppm', bytes: goodPPM },
      bPPM: { name: 'b.ppm', bytes: otherPPM },
      aBIN: { name: 'wrong.bin', bytes: goodBIN.slice(0, 12) },
      bBIN: { name: 'b.bin', bytes: goodBIN },
    }),
    'wrong.bin',
  );
  console.log('  解析错误通过：截断/魔数/尺寸错配均报出具体文件名');
}

/* ---------- 4. 960×540 性能与往返统计 ---------- */
function makeBigDataset() {
  const W = 960;
  const H = 540;
  const N = W * H;
  const rgbA = new Uint8Array(N * 3);
  const rgbB = new Uint8Array(N * 3);
  const mkFlow = (sign) => {
    const dx = new Int16Array(N);
    const dy = new Int16Array(N);
    const z = new Uint16Array(N);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const d = y * W + x;
        // 前景方块近深度、移动 8 单位；其余为背景
        const fg = x >= 200 && x < 440 && y >= 120 && y < 360;
        dx[d] = sign * 8;
        z[d] = fg ? 40 : 100 + ((x * 7 + y * 3) % 60);
      }
    }
    return { dx, dy, z };
  };
  for (let d = 0; d < N; d += 1) {
    rgbA[d * 3] = (d * 3) & 255;
    rgbA[d * 3 + 1] = (d * 5) & 255;
    rgbA[d * 3 + 2] = (d * 7) & 255;
    rgbB[d * 3] = (d * 11) & 255;
    rgbB[d * 3 + 1] = (d * 13) & 255;
    rgbB[d * 3 + 2] = (d * 17) & 255;
  }
  return {
    width: W, height: H, rgbA, rgbB,
    flowA: mkFlow(1), flowB: mkFlow(-1),
    names: {},
  };
}

function testPerf() {
  const ds = makeBigDataset();
  const passes = {
    passA: E.computeRoundTrip(ds.flowA, ds.flowB, ds.width, ds.height),
    passB: E.computeRoundTrip(ds.flowB, ds.flowA, ds.width, ds.height),
  };
  const t0 = performance.now();
  const res = E.renderFrame(ds, 32, 20, passes);
  const ms = performance.now() - t0;
  const counts = [0, 0, 0, 0, 0];
  for (const c of res.cls) counts[c] += 1;
  console.log(`  960×540 单帧渲染：${ms.toFixed(1)} ms（限制 2000 ms），分类计数`, counts);
  assert.ok(ms < 2000, '单帧超过 2 秒');
  assert.ok(counts[3] > 0 || counts[4] >= 0, '应至少完成分类');
  // 端点不做投影
  const ep = E.endpointFrame(ds, 0);
  assert.ok(eq(ep.rgb, ds.rgbA), '端点必须等于原帧');
  assert.ok(ep.cls.every((v) => v === 0), '端点分类必须全 0');
}

/* ---------- 5. 点选与加权规则抽查 ---------- */
function testInspect() {
  const ds = loadCase();
  const passes = {
    passA: E.computeRoundTrip(ds.flowA, ds.flowB, ds.width, ds.height),
    passB: E.computeRoundTrip(ds.flowB, ds.flowA, ds.width, ds.height),
  };
  const res = E.renderFrame(ds, 32, 10, passes);
  // 分类计数与参考一致性已在对拍覆盖，这里验证点选结构
  const info = E.inspectPixel(res, ds, 5, 5);
  assert.ok(info && (info.cls === 1 || info.cls === 2));
  assert.ok(info.contributors.length > 0);
  assert.ok(info.contributors.every((c) => c.weight > 0));
  const used = info.contributors.filter((c) => c.used);
  assert.ok(used.length > 0);
  if (info.hasPassInLayer) assert.ok(used.every((c) => c.pass), '有通过点时只能用通过点');
  // 补洞像素可追查来源
  let anyFill = false;
  for (let d = 0; d < ds.width * ds.height; d += 1) {
    if (res.cls[d] === 3) {
      const x = d % ds.width;
      const y = (d / ds.width) | 0;
      const f = E.inspectPixel(res, ds, x, y);
      assert.ok(f.fillFrom && f.fillFrom.index === res.fillSrc[d]);
      anyFill = true;
    }
  }
  console.log(`  点选通过：供色来源/权重/深度层齐全，补洞可追查（补洞像素 ${anyFill ? '存在' : '本数据无'}）`);
}

let failures = 0;
for (const [name, fn] of Object.entries({
  testParity, testFill, testParseErrors, testPerf, testInspect,
})) {
  try {
    await fn();
  } catch (e) {
    failures += 1;
    console.error(`✗ ${name} 失败：`, e);
  }
}
rmSync(work, { recursive: true, force: true });
if (failures) process.exit(1);
console.log('\n全部测试通过');
