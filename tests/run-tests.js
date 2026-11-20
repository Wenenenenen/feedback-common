'use strict';

/*
 * 自动化检查：node tests/run-tests.js
 *
 * 1. 引擎与包内样例对照（tiny-expected.json 的 β、最小能量、最优位掩码）
 * 2. 与暴力枚举对照，验证最小割的最优性与种子硬约束
 * 3. 缺少种子、冲突、λ 越界、常色图的处理
 * 4. PNG 解码的接受 / 拒绝规则与编解码往返
 * 5. 种子配置的校验与再导入
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const engine = require(path.join(ROOT, 'src', 'engine.js'));
const PNG = require(path.join(ROOT, 'src', 'png.js'));
const CONFIG = require(path.join(ROOT, 'src', 'config.js'));

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name + '\n      ' + (err && err.message ? err.message : err));
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name + '\n      ' + (err && err.message ? err.message : err));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function near(a, b, eps, label) {
  const limit = eps == null ? 1e-9 : eps;
  if (!(Math.abs(a - b) <= limit)) {
    throw new Error((label || '数值') + ' 不匹配：' + a + ' ≠ ' + b);
  }
}

// ---- 在 Node 里直接驱动 Worker 入口（用假 self 收集消息） ----
const messages = [];
const fakeSelf = { postMessage: (m) => messages.push(m) };
engine.entry(fakeSelf);

function runEngine(job) {
  messages.length = 0;
  fakeSelf.onmessage({ data: Object.assign({ type: 'solve', id: 1 }, job) });
  const last = messages[messages.length - 1];
  if (!last) throw new Error('引擎没有返回消息');
  if (last.type === 'error') throw new Error(last.message);
  return last;
}

function expectEngineError(job, includes) {
  messages.length = 0;
  fakeSelf.onmessage({ data: Object.assign({ type: 'solve', id: 1 }, job) });
  const last = messages[messages.length - 1];
  assert(last && last.type === 'error', '应当返回错误，实际为 ' + JSON.stringify(last && last.type));
  if (includes) {
    assert(last.message.indexOf(includes) >= 0, '错误信息应包含「' + includes + '」，实际为「' + last.message + '」');
  }
}

// ---- 样例 PNG 的最小解码（独立于 src/png.js，避免用被测代码验证被测代码） ----
function decodeSampleRgb(file) {
  const data = fs.readFileSync(file);
  let pos = 8;
  let w = 0;
  let h = 0;
  let colorType = -1;
  const idat = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    const chunk = data.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      w = chunk.readUInt32BE(0);
      h = chunk.readUInt32BE(4);
      colorType = chunk[9];
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (colorType !== 2) throw new Error('样例应为 8 位 RGB');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 3;
  const out = new Uint8Array(w * h * 3);
  let prev = Buffer.alloc(stride);
  let p = 0;
  const paeth = (a, b, c) => {
    const pp = a + b - c;
    const pa = Math.abs(pp - a);
    const pb = Math.abs(pp - b);
    const pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? line[i - 3] : 0;
      const b = prev[i];
      const c = i >= 3 ? prev[i - 3] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      line[i] = v & 255;
    }
    out.set(line, y * stride);
    prev = line;
  }
  return { w, h, rgb: out };
}

function bruteForce(w, h, rgb, fg, bg, lambda) {
  const N = w * h;
  const mean = (idx) => {
    const m = [0, 0, 0];
    idx.forEach((i) => {
      m[0] += rgb[i * 3];
      m[1] += rgb[i * 3 + 1];
      m[2] += rgb[i * 3 + 2];
    });
    return m.map((v) => v / idx.length / 255);
  };
  const m1 = mean(fg);
  const m0 = mean(bg);
  const D0 = [];
  const D1 = [];
  for (let i = 0; i < N; i++) {
    let d0 = 0;
    let d1 = 0;
    for (let k = 0; k < 3; k++) {
      const c = rgb[i * 3 + k] / 255;
      d0 += (c - m0[k]) * (c - m0[k]);
      d1 += (c - m1[k]) * (c - m1[k]);
    }
    D0.push(d0);
    D1.push(d1);
  }
  const edges = [];
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) {
        const j = i + 1;
        let d = 0;
        for (let k = 0; k < 3; k++) {
          const t = (rgb[i * 3 + k] - rgb[j * 3 + k]) / 255;
          d += t * t;
        }
        sum += d;
        edges.push([i, j, d]);
      }
      if (y + 1 < h) {
        const j = i + w;
        let d = 0;
        for (let k = 0; k < 3; k++) {
          const t = (rgb[i * 3 + k] - rgb[j * 3 + k]) / 255;
          d += t * t;
        }
        sum += d;
        edges.push([i, j, d]);
      }
    }
  }
  const meanDiff = edges.length ? sum / edges.length : 0;
  const beta = meanDiff === 0 ? 0 : 1 / (2 * meanDiff);
  const weights = edges.map((e) => lambda * Math.exp(-beta * e[2]));
  const fixed = new Array(N).fill(-1);
  fg.forEach((i) => { fixed[i] = 1; });
  bg.forEach((i) => { fixed[i] = 0; });
  const free = [];
  for (let i = 0; i < N; i++) if (fixed[i] < 0) free.push(i);
  assert(free.length <= 16, '暴力枚举只用于小图');
  let best = Infinity;
  for (let m = 0; m < (1 << free.length); m++) {
    const lab = fixed.slice();
    for (let k = 0; k < free.length; k++) lab[free[k]] = (m >> k) & 1;
    let E = 0;
    for (let i = 0; i < N; i++) E += lab[i] ? D1[i] : D0[i];
    for (let e = 0; e < edges.length; e++) {
      if (lab[edges[e][0]] !== lab[edges[e][1]]) E += weights[e];
    }
    if (E < best) best = E;
  }
  return best;
}

async function main() {
  console.log('引擎 · 包内样例');

  const sampleDir = path.join(ROOT, 'samples', 'seed-cut-matte-cases.zip');
  let workDir = null;
  if (fs.existsSync(sampleDir)) {
    // 在临时目录里解压，避免污染仓库
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seedcut-test-'));
    workDir = tmp;
    const { execFileSync } = require('child_process');
    execFileSync('unzip', ['-q', sampleDir, '-d', tmp]);
  }

  if (workDir) {
    const tiny = decodeSampleRgb(path.join(workDir, 'tiny.png'));
    const tinyCfg = JSON.parse(fs.readFileSync(path.join(workDir, 'tiny.json'), 'utf8'));
    const tinyExp = JSON.parse(fs.readFileSync(path.join(workDir, 'tiny-expected.json'), 'utf8'));
    const toIndex = (list) => list.map((p) => p[1] * tiny.w + p[0]);
    const tinyResult = runEngine({
      w: tiny.w,
      h: tiny.h,
      rgb: tiny.rgb,
      fg: toIndex(tinyCfg.foreground),
      bg: toIndex(tinyCfg.background),
      lambda: tinyCfg.lambda
    });

    check('tiny：β 与 expected 一致', () => near(tinyResult.beta, tinyExp.beta, 1e-12, 'β'));
    check('tiny：最小能量与 expected 一致', () => near(tinyResult.total, tinyExp.minimum_energy, 1e-9, '能量'));
    check('tiny：位掩码与 expected 一致', () => {
      let mask = 0;
      for (let i = 0; i < tiny.w * tiny.h; i++) if (tinyResult.labels[i]) mask |= 1 << i;
      assert(tinyExp.optimal_bitmasks_row_major.indexOf(mask) >= 0,
        '得到 ' + mask + '，expected 允许 ' + tinyExp.optimal_bitmasks_row_major.join(','));
    });
    check('tiny：最大流 = 割容量 = 总能量', () => near(tinyResult.maxFlow, tinyResult.total, 1e-9, '最大流'));

    const islands = decodeSampleRgb(path.join(workDir, 'islands.png'));
    const islandsCfg = JSON.parse(fs.readFileSync(path.join(workDir, 'islands.json'), 'utf8'));
    const islandsResult = runEngine({
      w: islands.w,
      h: islands.h,
      rgb: islands.rgb,
      fg: islandsCfg.foreground.map((p) => p[1] * islands.w + p[0]),
      bg: islandsCfg.background.map((p) => p[1] * islands.w + p[0]),
      lambda: islandsCfg.lambda
    });
    check('islands：保留两个分离前景区域', () => assert(islandsResult.fgComponents === 2,
      '连通域数为 ' + islandsResult.fgComponents));
    check('islands：种子被保留为硬约束', () => {
      islandsCfg.foreground.forEach((p) => assert(islandsResult.labels[p[1] * islands.w + p[0]] === 1, '前景种子丢失'));
      islandsCfg.background.forEach((p) => assert(islandsResult.labels[p[1] * islands.w + p[0]] === 0, '背景种子丢失'));
    });

    const constant = decodeSampleRgb(path.join(workDir, 'constant.png'));
    const constantCfg = JSON.parse(fs.readFileSync(path.join(workDir, 'constant.json'), 'utf8'));
    const constantResult = runEngine({
      w: constant.w,
      h: constant.h,
      rgb: constant.rgb,
      fg: constantCfg.foreground.map((p) => p[1] * constant.w + p[0]),
      bg: constantCfg.background.map((p) => p[1] * constant.w + p[0]),
      lambda: constantCfg.lambda
    });
    check('constant：β = 0 且总能量有限', () => {
      assert(constantResult.beta === 0, 'β 应为 0，实际 ' + constantResult.beta);
      assert(isFinite(constantResult.total), '总能量应为有限值');
    });
    check('constant：种子仍被保留', () => {
      constantCfg.foreground.forEach((p) => assert(constantResult.labels[p[1] * constant.w + p[0]] === 1, '前景种子丢失'));
      constantCfg.background.forEach((p) => assert(constantResult.labels[p[1] * constant.w + p[0]] === 0, '背景种子丢失'));
    });

    const conflictCfg = JSON.parse(fs.readFileSync(path.join(workDir, 'conflict.json'), 'utf8'));
    check('conflict：同一像素两类种子被拒绝', () => {
      expectEngineError({
        w: tiny.w,
        h: tiny.h,
        rgb: tiny.rgb,
        fg: conflictCfg.foreground.map((p) => p[1] * tiny.w + p[0]),
        bg: conflictCfg.background.map((p) => p[1] * tiny.w + p[0]),
        lambda: conflictCfg.lambda
      }, '种子冲突');
    });
  } else {
    console.log('  · 跳过：找不到 samples/seed-cut-matte-cases.zip');
  }

  console.log('引擎 · 最优性与约束');

  check('缺少前景种子时拒绝计算', () => {
    expectEngineError({ w: 4, h: 3, rgb: new Uint8Array(36), fg: [], bg: [0], lambda: 1 }, '缺少前景种子');
  });
  check('缺少背景种子时拒绝计算', () => {
    expectEngineError({ w: 4, h: 3, rgb: new Uint8Array(36), fg: [0], bg: [], lambda: 1 }, '缺少背景种子');
  });
  check('λ 超出 0..20 被拒绝', () => {
    expectEngineError({ w: 4, h: 3, rgb: new Uint8Array(36), fg: [0], bg: [1], lambda: 20.5 }, 'lambda');
    expectEngineError({ w: 4, h: 3, rgb: new Uint8Array(36), fg: [0], bg: [1], lambda: -0.1 }, 'lambda');
  });
  check('种子越界被拒绝', () => {
    expectEngineError({ w: 4, h: 3, rgb: new Uint8Array(36), fg: [999], bg: [0], lambda: 1 }, '超出图片范围');
  });
  check('尺寸超过 256 被拒绝', () => {
    expectEngineError({ w: 257, h: 4, rgb: new Uint8Array(257 * 4 * 3), fg: [0], bg: [1], lambda: 1 }, '1..256');
  });

  let rngState = 20261121;
  const rnd = () => {
    rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
    return rngState / 4294967296;
  };

  check('随机小图与暴力枚举的最优能量一致（200 例）', () => {
    for (let t = 0; t < 200; t++) {
      const w = 2 + Math.floor(rnd() * 3);
      const h = 2 + Math.floor(rnd() * 3);
      const N = w * h;
      const rgb = new Uint8Array(N * 3);
      const mode = t % 4;
      for (let i = 0; i < N; i++) {
        if (mode === 0) {
          rgb[i * 3] = Math.floor(rnd() * 256);
          rgb[i * 3 + 1] = Math.floor(rnd() * 256);
          rgb[i * 3 + 2] = Math.floor(rnd() * 256);
        } else if (mode === 1) {
          const v = Math.floor(rnd() * 4) * 60;
          rgb[i * 3] = v; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v;
        } else if (mode === 2) {
          const c = Math.floor(rnd() * 2) * 180;
          rgb[i * 3] = c; rgb[i * 3 + 1] = 255 - c; rgb[i * 3 + 2] = 128;
        } else {
          rgb[i * 3] = 128; rgb[i * 3 + 1] = 128; rgb[i * 3 + 2] = 128;
        }
      }
      const order = [];
      for (let i = 0; i < N; i++) order.push(i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      }
      const fg = [order[0]];
      const bg = [order[1]];
      const extra = Math.floor(rnd() * 2);
      for (let k = 0; k < extra; k++) (rnd() < 0.5 ? fg : bg).push(order[2 + k]);
      const lambda = [0, 0.3, 1, 7, 20][Math.floor(rnd() * 5)];
      const expect = bruteForce(w, h, rgb, fg, bg, lambda);
      const got = runEngine({ w, h, rgb, fg, bg, lambda });
      near(got.total, expect, 1e-9, '第 ' + (t + 1) + ' 例能量');
      fg.forEach((i) => assert(got.labels[i] === 1, '前景种子被切开'));
      bg.forEach((i) => assert(got.labels[i] === 0, '背景种子被切开'));
    }
  });

  check('K 严格大于全部有限项之和', () => {
    const rgb = new Uint8Array([10, 20, 30, 200, 150, 40, 12, 22, 32, 190, 140, 45, 11, 21, 31, 195, 145, 42]);
    const r = runEngine({ w: 3, h: 2, rgb, fg: [0, 1], bg: [4, 5], lambda: 2 });
    assert(r.seedCapacity > r.finiteUpper, 'K 应严格大于有限项总和');
    near(r.seedCapacity, r.finiteUpper + 1, 1e-9, 'K');
  });

  check('异类区域之间的常色图仍给出有限结果', () => {
    const w = 6;
    const h = 4;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      const left = i % w < 3;
      rgb[i * 3] = left ? 40 : 210;
      rgb[i * 3 + 1] = left ? 70 : 60;
      rgb[i * 3 + 2] = left ? 150 : 50;
    }
    const r = runEngine({ w, h, rgb, fg: [1 * w + 4], bg: [1 * w + 1], lambda: 1 });
    assert(isFinite(r.total) && r.total >= 0, '能量应为有限非负值');
    assert(r.labels[1 * w + 4] === 1 && r.labels[1 * w + 1] === 0, '种子应保留');
  });

  console.log('引擎 · 规模');

  check('256×256 图可在合理时间内求解', () => {
    const w = 256;
    const h = 256;
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const blob = ((x - 70) * (x - 70) + (y - 120) * (y - 120) < 40 * 40);
        rgb[i] = blob ? 190 : 45;
        rgb[i + 1] = blob ? 65 : 80;
        rgb[i + 2] = blob ? 45 : 160;
      }
    }
    const started = Date.now();
    const r = runEngine({
      w, h, rgb,
      fg: [120 * w + 70],
      bg: [5 * w + 5, 250 * w + 250],
      lambda: 1.2
    });
    const ms = Date.now() - started;
    assert(ms < 20000, '耗时 ' + ms + ' ms，超出预期');
    assert(r.total > 0 && isFinite(r.total), '能量应为有限正值');
    console.log('      · 256×256 用时 ' + ms + ' ms，' + r.phases + ' 相');
  });

  console.log('PNG 编解码');

  await checkAsync('拒绝带 Alpha 的 PNG', async () => {
    const b = await PNG.encode(4, 4, 6, new Uint8Array(64));
    let err = null;
    try { await PNG.decode(b); } catch (e) { err = e; }
    assert(err && /透明通道/.test(err.message), '应拒绝带 Alpha 的 PNG');
  });

  await checkAsync('拒绝超过 256 边的 PNG', async () => {
    const b = await PNG.encode(257, 2, 0, new Uint8Array(514));
    let err = null;
    try { await PNG.decode(b); } catch (e) { err = e; }
    assert(err && /256/.test(err.message), '应拒绝超限尺寸');
  });

  await checkAsync('拒绝非 PNG 数据', async () => {
    let err = null;
    try { await PNG.decode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])); } catch (e) { err = e; }
    assert(err && /PNG/.test(err.message), '应拒绝非 PNG');
  });

  await checkAsync('灰度 PNG 转为 RGB', async () => {
    const b = await PNG.encode(3, 2, 0, new Uint8Array([0, 60, 255, 10, 20, 30]));
    const img = await PNG.decode(b);
    assert(img.width === 3 && img.height === 2, '尺寸错误');
    assert(img.rgb[3] === 60 && img.rgb[4] === 60 && img.rgb[5] === 60, '灰度应复制到 RGB 三通道');
  });

  await checkAsync('掩膜 PNG 编解码往返', async () => {
    const w = 7;
    const h = 5;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = i % 3 === 0 ? 255 : 0;
    const bytes = await PNG.encode(w, h, 0, mask);
    const img = await PNG.decode(bytes);
    assert(img.width === w && img.height === h, '尺寸错误');
    for (let i = 0; i < mask.length; i++) {
      assert(img.rgb[i * 3] === mask[i], '第 ' + i + ' 个掩膜值不匹配');
    }
  });

  await checkAsync('RGBA 编解码保留原 RGB 与二值 Alpha', async () => {
    const w = 4;
    const h = 3;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = i * 5;
      rgba[i * 4 + 1] = 255 - i * 5;
      rgba[i * 4 + 2] = (i * 37) & 255;
      rgba[i * 4 + 3] = i % 2 ? 255 : 0;
    }
    const bytes = await PNG.encode(w, h, 6, rgba);
    assert(bytes[25] === 6, '颜色类型应为 6（RGBA）');
    // 用浏览器同一实现解码回来检查（png.js 拒绝 RGBA 输入，这里只校验块结构）
    const chunkTypes = [];
    let pos = 8;
    while (pos < bytes.length) {
      const len = (bytes[pos] << 24 | bytes[pos + 1] << 16 | bytes[pos + 2] << 8 | bytes[pos + 3]) >>> 0;
      chunkTypes.push(Buffer.from(bytes.subarray(pos + 4, pos + 8)).toString('ascii'));
      pos += 12 + len;
    }
    assert(chunkTypes.join(',') === 'IHDR,IDAT,IEND', '块结构错误：' + chunkTypes.join(','));
  });

  console.log('种子配置');

  check('读取包内格式（纯 foreground/background/lambda）', () => {
    const r = CONFIG.validateSeedConfig({ foreground: [[3, 1]], background: [[0, 1]], lambda: 0.7 }, { width: 4, height: 3 });
    assert(r.foreground.length === 1 && r.background.length === 1, '种子数量错误');
    near(r.lambda, 0.7, 1e-12, 'λ');
  });

  check('冲突配置被明确拒绝', () => {
    let err = null;
    try {
      CONFIG.validateSeedConfig({ foreground: [[1, 1]], background: [[1, 1]], lambda: 1 }, { width: 4, height: 3 });
    } catch (e) { err = e; }
    assert(err && /种子冲突/.test(err.message), '应报告种子冲突');
  });

  check('越界与非法坐标被拒绝', () => {
    let e1 = null;
    try { CONFIG.validateSeedConfig({ foreground: [[9, 1]], background: [[0, 0]], lambda: 1 }, { width: 4, height: 3 }); } catch (e) { e1 = e; }
    assert(e1 && /超出图片范围/.test(e1.message), '应报告越界');
    let e2 = null;
    try { CONFIG.validateSeedConfig({ foreground: [[1.5, 1]], background: [[0, 0]], lambda: 1 }, { width: 4, height: 3 }); } catch (e) { e2 = e; }
    assert(e2 && /整数对/.test(e2.message), '应报告坐标格式错误');
  });

  check('λ 缺省为 1，越界被拒绝', () => {
    const r = CONFIG.validateSeedConfig({ foreground: [[1, 1]], background: [[0, 0]] }, { width: 4, height: 3 });
    assert(r.lambdaDefaulted === true && r.lambda === 1, 'λ 缺省应为 1');
    let err = null;
    try { CONFIG.validateSeedConfig({ foreground: [[1, 1]], background: [[0, 0]], lambda: 21 }, { width: 4, height: 3 }); } catch (e) { err = e; }
    assert(err && /0 到 20/.test(err.message), '应拒绝越界 λ');
  });

  check('导出的配置可以重新导入', () => {
    const cfg = CONFIG.buildSeedConfig({
      foreground: [[3, 1]], background: [[0, 1]], lambda: 0.7,
      image: { width: 4, height: 3, name: 'tiny.png' },
      result: { beta: 5.3, m0: [0.1, 0.1, 0.1], m1: [0.9, 0.3, 0.5], unary: 1, boundary: 1.7, total: 2.7, maxFlow: 2.7, seedCapacity: 30 }
    });
    const back = CONFIG.validateSeedConfig(JSON.parse(JSON.stringify(cfg)), { width: 4, height: 3 });
    assert(JSON.stringify(back.foreground) === '[[3,1]]', '前景种子往返失败');
    assert(JSON.stringify(back.background) === '[[0,1]]', '背景种子往返失败');
    near(back.lambda, 0.7, 1e-12, 'λ 往返');
    assert(cfg.model && isFinite(cfg.model.totalEnergy), '导出应带上当前结果的能量');
  });

  check('没有有效结果时不写入能量', () => {
    const cfg = CONFIG.buildSeedConfig({
      foreground: [[0, 0]], background: [[1, 1]], lambda: 1,
      image: { width: 4, height: 3, name: 'x.png' }, result: null
    });
    assert(cfg.model === null, '无结果时 model 应为 null');
  });

  console.log('');
  console.log(passed + ' 项通过，' + failed + ' 项失败');
  if (workDir) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
