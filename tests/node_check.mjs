/*
 * Node 单元测试：直接测页面模块（不经过浏览器）。
 *
 * 运行：node tests/node_check.mjs [样例目录]
 * 覆盖：四元数/欧拉角、最短弧 SLERP、关键帧校验、格式换算、旋转渲染、
 *       24-bit 量化、WAV 编解码、参考文件逐样点、溢出判定、预览分段一致性。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleRoot = sysArg(2) || path.join(here, '..', 'samples', 'extracted');

function sysArg(i) {
  return process.argv[i];
}

const { parseWav, encodeWav24FromInt, quantize24 } = await import('../src/web/js/wav.js');
const {
  quatFromEulerDeg,
  quatToMatrix,
  matrixFromEulerDeg,
  eulerDegFromQuat,
  normalizeQuat,
  slerp,
  alignShortestArc,
  vectorToSpherical,
  wrapDeg,
} = await import('../src/web/js/quaternion.js');
const {
  validateKeyframes,
  parseAutomationJson,
  serializeAutomation,
  AutomationCurve,
} = await import('../src/web/js/automation.js');
const { conversionMatrix, FORMAT_SPECS } = await import('../src/web/js/ambisonic.js');
const {
  toCanonical,
  renderCanonical,
  formatPlanes,
  formatStats,
  outputChannelName,
} = await import('../src/web/js/dsp/rotation.js');
const { decodeMonitor, DEFAULT_MONITOR_ROWS, sanitizeMonitorRows } = await import('../src/web/js/player.js');
const { buildRotation, l: _l, buildStaticRotation, buildAutomationRotation } = await import('../src/web/js/rotation-mode.js');

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

function readWav(rel) {
  const buf = fs.readFileSync(path.join(sampleRoot, rel));
  return parseWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(sampleRoot, rel), 'utf8'));
}

/* ── 1. 四元数与欧拉角 ──────────────────────────────── */
console.log('\n[1] 四元数与欧拉角');
{
  const q = quatFromEulerDeg(90, 0, 0);
  const m = quatToMatrix(q);
  // 主动旋转 Rz(90°)：(1,0,0) → (0,1,0)，即前 → 左
  check('Rz(90°) 把 +X 转到 +Y', near(m[3], 1, 1e-12) && near(m[0], 0, 1e-12));
  check('Rz(90°) 保持 Z', near(m[8], 1, 1e-12));

  const qp = quatFromEulerDeg(0, 90, 0);
  const mp = quatToMatrix(qp);
  // 主动旋转 Ry(90°)：(1,0,0) → (0,0,-1)，即前 → 下
  check('Ry(90°) 把 +X 转到 −Z', near(mp[6], -1, 1e-12));

  // 次序 Rz·Ry·Rx：先 roll、再 pitch、最后 yaw
  const qc = quatFromEulerDeg(30, 20, 10);
  const e = eulerDegFromQuat(qc);
  check('欧拉角往返 yaw', near(wrapDeg(e.yaw), 30, 1e-9), `${e.yaw}`);
  check('欧拉角往返 pitch', near(e.pitch, 20, 1e-9), `${e.pitch}`);
  check('欧拉角往返 roll', near(wrapDeg(e.roll), 10, 1e-9), `${e.roll}`);

  // 次序不是可交换的：Rz(30)Ry(20) ≠ Ry(20)Rz(30)
  const a = matrixFromEulerDeg(30, 20, 0);
  const b = matrixFromEulerDeg(30, 0, 0);
  const c = matrixFromEulerDeg(0, 20, 0);
  let cmp = true;
  for (let i = 0; i < 9; i++) if (!near(a[i], b[i] + c[i])) cmp = false;
  check('Rz·Ry 不是矩阵相加（次序真实生效）', !cmp);

  check('归一化零四元数返回 null', normalizeQuat([0, 0, 0, 0]) === null);
  check('归一化 NaN 返回 null', normalizeQuat([NaN, 0, 0, 0]) === null);
  const nq = normalizeQuat([2, 0, 0, 0]);
  check('归一化 [2,0,0,0] → [1,0,0,0]', nq[0] === 1);

  // 最短弧：180° 附近翻转后仍走短弧
  const q0 = quatFromEulerDeg(0, 0, 0);
  const q180 = quatFromEulerDeg(180, 0, 0);
  const flipped = alignShortestArc([q0, q180]);
  const dot = flipped[0][0] * flipped[1][0] + flipped[0][1] * flipped[1][1]
    + flipped[0][2] * flipped[1][2] + flipped[0][3] * flipped[1][3];
  check('点积为负时已翻转（对齐后 ≥ 0）', dot >= 0, String(dot));

  // SLERP 中点对应一半角度
  const mid = slerp([1, 0, 0, 0], quatFromEulerDeg(90, 0, 0), 0.5);
  const midAngle = 2 * Math.acos(Math.min(1, mid[0])) * 180 / Math.PI;
  check('SLERP 中点 = 45°', near(midAngle, 45, 1e-6), String(midAngle));

  // SLERP 端点精确
  const s0 = slerp([1, 0, 0, 0], quatFromEulerDeg(90, 0, 0), 0);
  check('SLERP t=0 返回起点', near(s0[0], 1, 1e-12));
  const s1 = slerp([1, 0, 0, 0], quatFromEulerDeg(90, 0, 0), 1);
  check('SLERP t=1 返回终点', near(s1[3], Math.sin(Math.PI / 4), 1e-12), JSON.stringify(s1));

  const sph = vectorToSpherical([0, 1, 0]);
  check('+Y 的方位角为 90°', near(sph.az, 90, 1e-9));
  const sph2 = vectorToSpherical([1, 0, 0]);
  check('+X 的方位角为 0°', near(sph2.az, 0, 1e-9));
}

/* ── 2. 关键帧校验 ─────────────────────────────────── */
console.log('\n[2] 关键帧校验');
{
  const limit = 1000;
  const ok = validateKeyframes([
    { frame: 0, q: [1, 0, 0, 0] },
    { frame: 500, q: [0.7071, 0, 0, 0.7071] },
    { frame: 1000, q: [-1, 0, 0, 0] },
  ], limit);
  check('合法关键帧通过', ok.frames.length === 3);
  check('返回已归一化四元数', ok.quats.every((q) => near(Math.hypot(...q), 1, 1e-12)));
  check('第三帧因点积为负被翻转（w > 0）', ok.quats[2][0] > 0, String(ok.quats[2][0]));
  check('原始归一化值保留在 rawQuats（w = −1）', near(ok.rawQuats[2][0], -1, 1e-12), String(ok.rawQuats[2][0]));
  check('给出最短弧警告', ok.warnings.some((w) => w.includes('点积')));

  const rejects = [
    ['零四元数', [{ frame: 0, q: [0, 0, 0, 0] }]],
    ['非数值分量', [{ frame: 0, q: [NaN, 0, 0, 0] }]],
    ['长度不为 4', [{ frame: 0, q: [1, 0, 0] }]],
    ['重复帧', [{ frame: 0, q: [1, 0, 0, 0] }, { frame: 0, q: [0, 1, 0, 0] }]],
    ['乱序帧', [{ frame: 100, q: [1, 0, 0, 0] }, { frame: 50, q: [1, 0, 0, 0] }]],
    ['负帧', [{ frame: -1, q: [1, 0, 0, 0] }]],
    ['小数帧', [{ frame: 1.5, q: [1, 0, 0, 0] }]],
    ['越界帧', [{ frame: 0, q: [1, 0, 0, 0] }, { frame: 1001, q: [1, 0, 0, 0] }]],
    ['空数组', []],
    ['缺 frame', [{ q: [1, 0, 0, 0] }]],
  ];
  for (const [name, raw] of rejects) {
    let threw = false;
    let msg = '';
    try {
      validateKeyframes(raw, limit);
    } catch (err) {
      threw = true;
      msg = err.message;
    }
    check(`拒绝：${name}`, threw, msg);
  }

  check('恰好 N-1 帧合法', validateKeyframes([{ frame: 999, q: [1, 0, 0, 0] }], 999).frames[0] === 999);

  // 序列化往返
  const { frames, quats } = validateKeyframes([
    { frame: 0, q: [0.6, 0.8, 0, 0] },
    { frame: 10, q: [0.1, 0.2, 0.3, 0.4] },
  ], 100);
  const text = serializeAutomation(frames, quats);
  const back = validateKeyframes(parseAutomationJson(text), 100);
  let maxDiff = 0;
  for (let i = 0; i < 2; i++) {
    for (let c = 0; c < 4; c++) maxDiff = Math.max(maxDiff, Math.abs(quats[i][c] - back.quats[i][c]));
  }
  check('JSON 序列化 → 回读，四元数不变', maxDiff < 1e-15, String(maxDiff));
  check('JSON 回读帧号不变', back.frames[0] === 0 && back.frames[1] === 10);
}

/* ── 3. 曲线求值与端点保持 ─────────────────────────── */
console.log('\n[3] 关键帧曲线');
{
  const { frames, quats } = validateKeyframes([
    { frame: 10, q: [1, 0, 0, 0] },
    { frame: 20, q: quatFromEulerDeg(90, 0, 0) },
  ], 100);
  const curve = new AutomationCurve(frames, quats);
  const before = curve.quatAt(0);
  const after = curve.quatAt(100);
  check('端点前保持首关键帧', before.every((v, i) => near(v, quats[0][i], 1e-12)));
  check('端点后保持末关键帧', after.every((v, i) => near(v, quats[1][i], 1e-12)));
  const at15 = curve.quatAt(15);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(at15[0]))) * 180 / Math.PI;
  check('中点插值为 45°', near(angle, 45, 1e-6), String(angle));
  const at10 = curve.quatAt(10);
  check('关键帧处取关键帧值', near(at10[0], 1));
  const at20 = curve.quatAt(20);
  check('末关键帧处取末值', near(2 * Math.acos(Math.min(1, Math.abs(at20[0]))) * 180 / Math.PI, 90, 1e-6));
}

/* ── 4. 格式换算矩阵 ───────────────────────────────── */
console.log('\n[4] 格式换算矩阵');
{
  const mm = conversionMatrix('ambix', 'ambix');
  check('AmbiX→AmbiX 为单位阵', mm.every((v, i) => near(v, i % 5 === 0 ? 1 : 0)));

  const af = conversionMatrix('ambix', 'fuma');
  check('AmbiX→FuMa：W 乘 1/√2', near(af[0], 1 / Math.SQRT2));
  check('AmbiX→FuMa：X→第 2 通道', near(af[4 + 3], 1), JSON.stringify(af));
  check('AmbiX→FuMa：Y→第 3 通道', near(af[8 + 1], 1));
  check('AmbiX→FuMa：Z→第 4 通道', near(af[12 + 2], 1));

  const fa = conversionMatrix('fuma', 'ambix');
  check('FuMa→AmbiX：W 乘 √2', near(fa[0], Math.SQRT2));
  check('FuMa→AmbiX：X 来自第 2 通道', near(fa[12 + 1], 1));
  check('FuMa→AmbiX：Y 来自第 3 通道', near(fa[4 + 2], 1));
  check('FuMa→AmbiX：Z 来自第 4 通道', near(fa[8 + 3], 1));

  const ff = conversionMatrix('fuma', 'fuma');
  check('FuMa→FuMa 为单位阵', ff.every((v, i) => near(v, i % 5 === 0 ? 1 : 0)));
}

/* ── 5. 24-bit 量化与 WAV 编解码 ────────────────────── */
console.log('\n[5] 24-bit 量化与 WAV');
{
  check('0 → 0', quantize24(0) === 0);
  check('0.5 → 4194304', quantize24(0.5) === 4194304);
  check('-0.5 → -4194304', quantize24(-0.5) === -4194304);
  check('1 − 1LSB 不越界', quantize24(1 - 1 / 8388608) === 8388607);
  check('略大于 1 被夹到最大整数', quantize24(1.2) === 8388607);
  check('略小于 −1 被夹到最小整数', quantize24(-1.2) === -8388608);

  const planes = [
    new Int32Array([0, 4194304, -4194304, 8388607, -8388608]),
    new Int32Array([121, -121, 0, 0, 0]),
    new Int32Array(5),
    new Int32Array(5),
  ];
  const buf = encodeWav24FromInt(planes, 48000);
  const parsed = parseWav(buf);
  check('导出 WAV 4 声道', parsed.channels === 4);
  check('导出 WAV 24-bit', parsed.bitsPerSample === 24);
  check('导出 WAV 48 kHz', parsed.sampleRate === 48000);
  check('帧数保持 5', parsed.frames === 5);
  check('往返后样点精确', parsed.data[0].every((v, i) => Math.abs(v * 8388608 - planes[0][i]) === 0));

  // 解析畸形的 WAV 必须拒绝
  const bad = [
    ['零字节', new ArrayBuffer(0)],
    ['非 RIFF', new ArrayBuffer(64)],
  ];
  for (const [name, ab] of bad) {
    let threw = false;
    try { parseWav(ab); } catch { threw = true; }
    check(`拒绝畸形 WAV：${name}`, threw);
  }
}

/* ── 6. 旋转渲染与参考文件 ─────────────────────────── */
console.log('\n[6] 旋转渲染');
{
  const ambix = readWav('ambix-48000-24.wav');
  const ref = readWav('reference-automated-48000-24.wav');
  const auto = readJson('automation.json');
  const { frames, quats } = validateKeyframes(auto.keyframes, ambix.frames - 1);
  const canonical = toCanonical(ambix.data, 'ambix');
  const result = await renderCanonical(canonical, { mode: 'automation', frames, quats });

  let worst = 0;
  let worstAt = '';
  for (let c = 0; c < 4; c++) {
    const rp = ref.data[c];
    for (let i = 0; i < ref.frames; i++) {
      const d = Math.abs(result.planes[c][i] - Math.round(rp[i] * 8388608));
      if (d > worst) { worst = d; worstAt = `frame ${i} ch ${c}`; }
    }
  }
  check('与参考文件最大差 ≤ 4 整数单位', worst <= 4, `最大 ${worst} @ ${worstAt}`);
  check('W 通道逐样点不变（量化后等于输入整数）',
    result.planes[0].every((v, i) => v === Math.round(ambix.data[0][i] * 8388608)));

  const stats = result.stats.ambix;
  check('参考样例无溢出', stats.overflowCount === 0, String(stats.overflowCount));
  check('参考样例峰值 0.12', near(stats.peak, 0.12, 1e-6), String(stats.peak));

  // 帧数不变
  check('渲染帧数 = 输入帧数', result.planes[0].length === ambix.frames);
}

/* ── 7. 格式输出与溢出 ─────────────────────────────── */
console.log('\n[7] 输出格式与溢出');
{
  const overload = readWav('overload-48000-24.wav');
  const canonical = toCanonical(overload.data, 'ambix');

  const q45 = quatFromEulerDeg(45, 0, 0);
  const rot45 = { mode: 'static', matrix: quatToMatrix(q45), quat: q45 };
  const r45 = await renderCanonical(canonical, rot45);
  check('yaw=45° 峰值 ≈ 1.131', near(r45.stats.ambix.peak, 1.13137, 1e-4), String(r45.stats.ambix.peak));
  check('yaw=45° 溢出样点数 = 24000', r45.stats.ambix.overflowCount === 24000, String(r45.stats.ambix.overflowCount));
  check('yaw=45° 溢出通道为 Y（索引 1）', r45.stats.ambix.overflowChannel === 1);
  check('yaw=45° 首个溢出帧为 0', r45.stats.ambix.overflowFrame === 0);

  const q0 = quatFromEulerDeg(0, 0, 0);
  const r0 = await renderCanonical(canonical, { mode: 'static', matrix: quatToMatrix(q0), quat: q0 });
  check('yaw=0° 无溢出', r0.stats.ambix.overflowCount === 0);
  check('yaw=0° 峰值 0.8', near(r0.stats.ambix.peak, 0.8, 1e-5), String(r0.stats.ambix.peak));

  // FuMa 输出：W 减半，Y 不变
  const fuma = formatPlanes(r0.planes, canonical.W, 'fuma');
  check('FuMa 通道序 W X Y Z：第 2 通道 = X', fuma[1].every((v, i) => v === r0.planes[3][i]));
  check('FuMa 通道序 W X Y Z：第 3 通道 = Y', fuma[2].every((v, i) => v === r0.planes[1][i]));
  let maxW = 0;
  for (let i = 0; i < fuma[0].length; i++) {
    maxW = Math.max(maxW, Math.abs(fuma[0][i] - quantize24(canonical.W[i] / Math.SQRT2)));
  }
  check('FuMa 的 W 重新量化为 AmbiX W / √2', maxW === 0, String(maxW));

  check('输出通道名 ambix', outputChannelName('ambix', 2) === 'Z');
  check('输出通道名 fuma', outputChannelName('fuma', 2) === 'Y');

  // FuMa 下 W 的溢出阈值是 √2：AmbiX 溢出而 FuMa 不溢出的区间必须区分
  const one = { W: new Float32Array([1.2]), Y: new Float32Array(1), Z: new Float32Array(1), X: new Float32Array(1), frames: 1 };
  const qI = quatFromEulerDeg(0, 0, 0);
  const rOne = await renderCanonical(one, { mode: 'static', matrix: quatToMatrix(qI), quat: qI });
  check('W=1.2：AmbiX 溢出', rOne.stats.ambix.overflowCount === 1);
  check('W=1.2：FuMa 不溢出（1.2/√2 < 1）', rOne.stats.fuma.overflowCount === 0,
    String(rOne.stats.fuma.overflowCount));
  const one5 = { ...one, W: new Float32Array([1.5]) };
  const rOne5 = await renderCanonical(one5, { mode: 'static', matrix: quatToMatrix(qI), quat: qI });
  check('W=1.5：FuMa 也溢出（1.5/√2 > 1）', rOne5.stats.fuma.overflowCount === 1);
}

/* ── 8. 监听矩阵与解码 ─────────────────────────────── */
console.log('\n[8] 监听矩阵');
{
  check('内置矩阵 2×4', DEFAULT_MONITOR_ROWS.length === 2 && DEFAULT_MONITOR_ROWS.every((r) => r.length === 4));
  check('矩阵数值与 conventions.json 一致（样例核对在 Python 侧）',
    near(DEFAULT_MONITOR_ROWS[0][0], 0.5) && near(DEFAULT_MONITOR_ROWS[0][3], 0.4330127018922193));

  const bad1 = [[0, 0, 0], [1, 2, 3]];
  const bad2 = [[0, 1, 2, NaN], [0, 0, 0, 0]];
  const bad3 = 'nope';
  check('拒绝错误形状的矩阵', sanitizeMonitorRows(bad1) === null);
  check('拒绝含非有限值的矩阵', sanitizeMonitorRows(bad2) === null);
  check('拒绝非数组', sanitizeMonitorRows(bad3) === null);

  // 只要 Y 的声场，L/R 应反号
  const frames = 4;
  const planes = {
    W: new Float32Array(frames),
    Y: new Float32Array([1, 1, 1, 1]),
    Z: new Float32Array(frames),
    X: new Float32Array(frames),
  };
  const dec = decodeMonitor(planes, DEFAULT_MONITOR_ROWS, 0, frames);
  check('监听 L = +0.25·Y', near(dec.left[0], 0.25));
  check('监听 R = −0.25·Y', near(dec.right[0], -0.25));
  const planesX = {
    W: new Float32Array(frames),
    Y: new Float32Array(frames),
    Z: new Float32Array(frames),
    X: new Float32Array([1, 1, 1, 1]),
  };
  const decX = decodeMonitor(planesX, DEFAULT_MONITOR_ROWS, 0, frames);
  // 监听矩阵里 0.433... 以 Float32 参与运算，容差放到 1e-7
  check('监听 L 含 0.433·X', near(decX.left[0], 0.4330127018922193, 1e-7), String(decX.left[0]));
  check('监听 L/R 的 X 项相同', near(decX.left[0], decX.right[0], 1e-9));
  check('纯 W 时 L/R 各取 0.5', near(
    decodeMonitor({ W: new Float32Array([1]), Y: new Float32Array(1), Z: new Float32Array(1), X: new Float32Array(1) },
      DEFAULT_MONITOR_ROWS, 0, 1).left[0], 0.5, 1e-9,
  ));
}

/* ── 9. 预览与导出同源 ─────────────────────────────── */
console.log('\n[9] 预览与导出一致性');
{
  const ambix = readWav('ambix-48000-24.wav');
  const canonical = toCanonical(ambix.data, 'ambix');
  const q = quatFromEulerDeg(37, -12, 5);
  const rot = { mode: 'static', matrix: quatToMatrix(q), quat: q };

  const full = await renderCanonical(canonical, rot);
  // 模拟试听读取：从同一量化平面还原浮点
  const intro = full.planes.map((p) => Float32Array.from(p.subarray(0, 64), (v) => v / 8388608));
  check('预览读取与量化平面一致', intro[0].every((v, i) => Math.abs(v * 8388608 - full.planes[0][i]) < 1e-9));

  // 分段渲染的曲线与整段一致：比较第 100000 帧的旋转矩阵
  const { createMatrixProvider } = await import('../src/web/js/dsp/rotation.js');
  const a = new Float64Array(13);
  const b = new Float64Array(13);
  createMatrixProvider(rot)(100000, a);
  createMatrixProvider(rot)(100000, b);
  check('同一 rotation 的矩阵确定', a.every((v, i) => v === b[i]));

  const auto = readJson('automation.json');
  const { frames, quats } = validateKeyframes(auto.keyframes, ambix.frames - 1);
  const rot2 = { mode: 'automation', frames, quats };
  const ra = new Float64Array(13);
  const rb = new Float64Array(13);
  createMatrixProvider(rot2)(123456, ra);
  createMatrixProvider(rot2)(123456, rb);
  check('关键帧中点求值确定', ra.every((v, i) => v === rb[i]));

  // 与 AutomationCurve 求值一致
  const curve = new AutomationCurve(frames, quats);
  const qq = curve.quatAt(123456);
  check('provider 与曲线求值一致', [9, 10, 11, 12].every((idx, k) => near(ra[idx], qq[k], 1e-12)));
}

/* ── 10. 模式互斥 ──────────────────────────────────── */
console.log('\n[10] 静态角 / 关键帧互斥');
{
  const rot = buildStaticRotation(30, 10, 0);
  check('静态模式返回矩阵与四元数', Array.isArray(rot.matrix) && rot.matrix.length === 9);
  check('静态模式 mode = static', rot.mode === 'static');

  const limit = 100;
  const { frames, quats } = validateKeyframes([
    { frame: 0, q: [1, 0, 0, 0] },
    { frame: 50, q: quatFromEulerDeg(90, 0, 0) },
  ], limit);
  const auto = buildAutomationRotation([{ frame: 0, q: [1, 0, 0, 0] }, { frame: 50, q: quatFromEulerDeg(90, 0, 0) }], limit);
  check('关键帧模式 mode = automation', auto.mode === 'automation');
  check('关键帧模式带已对齐的四元数', auto.quats.length === 2);

  // 混合输入必须被拒绝
  let threw = false;
  try {
    buildRotation({ mode: 'static', yaw: 0, pitch: 0, roll: 0, keyframes: [{ frame: 0, q: [1, 0, 0, 0] }] }, limit);
  } catch { threw = true; }
  check('静态模式带关键帧被拒绝', threw);

  threw = false;
  try {
    buildRotation({ mode: 'automation', yaw: 0, pitch: 0, roll: 0, keyframes: [] }, limit);
  } catch { threw = true; }
  check('关键帧模式带静态角被拒绝', threw);

  threw = false;
  try { buildRotation({ mode: 'bogus' }, limit); } catch { threw = true; }
  check('未知模式被拒绝', threw);
}

/* ── 11. 采样率 / 位深限制 ─────────────────────────── */
console.log('\n[11] 输入限制');
{
  const a44 = readWav('ambix-44100-16.wav');
  check('44.1 kHz / 16-bit 可解析', a44.sampleRate === 44100 && a44.bitsPerSample === 16);
  check('44.1 kHz 帧数 264600', a44.frames === 264600);

  // 构造错误的 WAV 头，验证拒绝
  const make = (channels, rate, bits) => {
    const frames = 4;
    const align = channels * (bits / 8);
    const buf = new ArrayBuffer(44 + frames * align);
    const v = new DataView(buf);
    const fourcc = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    fourcc(0, 'RIFF'); v.setUint32(4, 36 + frames * align, true); fourcc(8, 'WAVE');
    fourcc(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, channels, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * align, true); v.setUint16(32, align, true); v.setUint16(34, bits, true);
    fourcc(36, 'data'); v.setUint32(40, frames * align, true);
    return buf;
  };
  const cases = [
    ['2 声道', make(2, 48000, 16)],
    ['44.1k? no: 32 kHz', make(4, 32000, 16)],
    ['8-bit', make(4, 48000, 8)],
    ['32-bit', make(4, 48000, 32)],
  ];
  for (const [name, ab] of cases) {
    let threw = false;
    try { parseWav(ab); } catch { threw = true; }
    check(`拒绝 ${name}`, threw);
  }
}

/* ── 汇总 ─────────────────────────────────────────── */
console.log(`\n${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
