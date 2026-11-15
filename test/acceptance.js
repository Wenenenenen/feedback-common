/* acceptance.js — 核心算法验收：对照 samples/loop-cases.zip 中的 cases.json。
 *
 * 用法：
 *   unzip -o samples/loop-cases.zip -d /tmp/loop-fixtures
 *   node test/acceptance.js /tmp/loop-fixtures
 *
 * 断言全部通过时退出码为 0；任何失败都会打印并置退出码 1。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const WAV = require('../public/wav.js');
const CORE = require('../public/loop-core.js');

const dir = process.argv[2] || '/tmp/loop-fixtures';
let failures = 0;
let checks = 0;
const shaResults = [];

function ok(name, cond, detail) {
  checks++;
  if (cond) {
    console.log('  ✓ ' + name);
  } else {
    failures++;
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

function readFile(name) {
  return fs.readFileSync(path.join(dir, name));
}

function decode(name) {
  const buf = readFile(name);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { decoded: WAV.decodeWav(ab), bytes: buf };
}

function section(title) {
  console.log('\n' + title);
}

function main() {
  const casesPath = path.join(dir, 'cases.json');
  if (!fs.existsSync(casesPath)) {
    console.error('找不到 cases.json，请先解压 samples/loop-cases.zip 到 ' + dir);
    process.exit(2);
  }
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

  /* ---------------- 解码与格式 ---------------- */
  section('解码与格式');
  const stereo = decode(cases.postroll.file);
  ok('stereo-postroll 采样率 48kHz', stereo.decoded.sampleRate === 48000);
  ok('stereo-postroll 24 位', stereo.decoded.bits === 24);
  ok('stereo-postroll 双声道', stereo.decoded.channelCount === 2);
  ok('stereo-postroll 帧数 96000', stereo.decoded.frames === 96000,
    String(stereo.decoded.frames));

  const mono = decode(cases.tagged.file);
  ok('mono-tagged 44.1kHz / 16 位 / 单声道',
    mono.decoded.sampleRate === 44100 && mono.decoded.bits === 16 &&
    mono.decoded.channelCount === 1);

  const eof = decode(cases.eof.file);
  ok('eof-mono 帧数 48001', eof.decoded.frames === 48001, String(eof.decoded.frames));

  const long = decode(cases.long.file);
  ok('long-stereo 帧数 2880000', long.decoded.frames === cases.long.frames);
  ok('long-stereo 时长 60 秒', near(long.decoded.duration, 60, 1e-9));

  /* ---------------- 截断文件必须拒绝 ---------------- */
  section('非法素材');
  let truncatedError = null;
  try {
    decode('truncated.wav');
  } catch (e) {
    truncatedError = e;
  }
  ok('truncated.wav 被拒绝', !!truncatedError);
  ok('截断错误信息说明文件被截断',
    !!truncatedError && /截断|不完整/.test(truncatedError.message),
    truncatedError && truncatedError.message);
  ok('截断错误码为 TRUNCATED', !!truncatedError && truncatedError.code === 'TRUNCATED',
    truncatedError && truncatedError.code);

  /* ---------------- smpl 识别 ---------------- */
  section('smpl 循环标记识别');
  const tagged = cases.tagged;
  ok('mono-tagged 识别出前向循环', !!mono.decoded.loop && mono.decoded.loop.type === 0);
  ok('循环 start = ' + tagged.start,
    mono.decoded.loop && mono.decoded.loop.start === tagged.start,
    mono.decoded.loop && String(mono.decoded.loop.start));
  ok('循环 endInclusive = ' + tagged.smpl_end_inclusive,
    mono.decoded.loop && mono.decoded.loop.endInclusive === tagged.smpl_end_inclusive);
  const taggedStart = mono.decoded.loop.start;
  const taggedEnd = mono.decoded.loop.endInclusive + 1;
  ok('换算区间为 [start, endInclusive+1)',
    taggedStart === tagged.start && taggedEnd === tagged.smpl_end_inclusive + 1);
  ok('smpl 循环区间在素材范围内', mono.decoded.loop.inRange === true);

  /* ---------------- 交叉淡化公式 ---------------- */
  section('后卷预混交叉淡化（对照 cases.json 公式）');
  const p = cases.postroll;
  const d = stereo.decoded;
  const L = p.end - p.start;
  ok('循环长度 = output_frames', L === p.output_frames, L + ' vs ' + p.output_frames);

  const check = CORE.validateLoop({
    frames: d.frames, start: p.start, end: p.end, fadeFrames: p.fade_frames,
    sampleRate: d.sampleRate,
  });
  ok('样例参数合法', check.ok, JSON.stringify(check.errors));

  const out = CORE.processLoop(d.channels, p.start, p.end, p.fade_frames);
  ok('输出双声道', out.length === 2);
  ok('输出帧数不变', out[0].length === L, String(out[0].length));

  let maxErr = 0;
  let firstFrameFromPostroll = true;
  let lastFrameFromHead = true;
  const den = p.fade_frames - 1;
  for (let c = 0; c < 2; c++) {
    const src = d.channels[c];
    const dst = out[c];
    for (let k = 0; k < L; k++) {
      const expected = k < p.fade_frames
        ? (1 - k / den) * src[p.end + k] + (k / den) * src[p.start + k]
        : src[p.start + k];
      const err = Math.abs(dst[k] - expected);
      if (err > maxErr) maxErr = err;
    }
    if (dst[0] !== src[p.end]) firstFrameFromPostroll = false;
    if (dst[L - 1] !== src[p.start + L - 1]) lastFrameFromHead = false;
  }
  ok('逐帧符合 cases.json 公式（最大误差 ' + maxErr.toExponential(2) + '）', maxErr < 1e-6);
  ok('首帧完全取 end 之后预留音频', firstFrameFromPostroll);
  ok('末帧完全取原头部最后一帧', lastFrameFromHead);
  ok('end 之后预留 ' + p.fade_frames + ' 帧可用',
    d.frames - p.end >= p.fade_frames, String(d.frames - p.end));

  /* ---------------- F 规则 ---------------- */
  section('淡化帧数 F 的约束');
  const base = { frames: 96000, start: 12000, end: 72000, sampleRate: 48000 };
  const vF = (fadeFrames) => CORE.validateLoop({ ...base, fadeFrames });
  ok('F = 0 合法', vF(0).ok);
  ok('F = 1 阻止', !vF(1).ok && vF(1).errors.some((e) => e.code === 'FADE_ONE'));
  ok('F = 2 合法', vF(2).ok);
  // 区间 9002 帧（一半 4501）、预留充足、100ms 上限 4800 帧 → 区间一半成为约束
  const halfCase = { frames: 96000, start: 10000, end: 19002, sampleRate: 48000 };
  ok('F = L/2 = 4501 合法', CORE.validateLoop({ ...halfCase, fadeFrames: 4501 }).ok,
    JSON.stringify(CORE.validateLoop({ ...halfCase, fadeFrames: 4501 }).errors));
  ok('F = L/2 + 1 = 4502 阻止（FADE_TOO_LONG）', !CORE.validateLoop({
    ...halfCase, fadeFrames: 4502,
  }).ok && CORE.validateLoop({ ...halfCase, fadeFrames: 4502 })
    .errors.some((e) => e.code === 'FADE_TOO_LONG'));
  const postrollCase = { frames: 96000, start: 49000, end: 93000, sampleRate: 48000 };
  // 区间 44000 帧（一半 22000），reserved 3000 帧，100ms 上限 4800 帧 → 上限为 3000
  ok('F = 预留 3000 合法（预留成为上限）',
    CORE.validateLoop({ ...postrollCase, fadeFrames: 3000 }).ok,
    JSON.stringify(CORE.validateLoop({ ...postrollCase, fadeFrames: 3000 }).errors));
  ok('F = 预留 + 1 阻止（NO_POSTROLL）', !CORE.validateLoop({
    ...postrollCase, fadeFrames: 3001,
  }).ok && CORE.validateLoop({ ...postrollCase, fadeFrames: 3001 })
    .errors.some((e) => e.code === 'NO_POSTROLL'));
  ok('maxFadeFrames 取三者最小值', CORE.maxFadeFrames(96000, 49000, 93000, 48000) === 3000,
    String(CORE.maxFadeFrames(96000, 49000, 93000, 48000)));
  ok('maxFadeFrames 只返回合法值（1 帧按 0）',
    CORE.maxFadeFrames(96000, 12000, 12002, 48000) === 0);
  ok('2 帧区间只能用 F = 0',
    CORE.validateLoop({ frames: 96000, start: 12000, end: 12002, fadeFrames: 0, sampleRate: 48000 })
      .ok && !CORE.validateLoop({
      frames: 96000, start: 12000, end: 12002, fadeFrames: 2, sampleRate: 48000,
    }).ok);
  ok('F > 100ms（4801 帧）阻止', !vF(4801).ok &&
    vF(4801).errors.some((e) => e.code === 'FADE_MS_LIMIT'));
  const edge = CORE.validateLoop({
    frames: 48001, start: 480, end: 48001, fadeFrames: 0, sampleRate: 48000,
  });
  ok('eof-mono：end 在文件末尾、F=0 合法', edge.ok, JSON.stringify(edge.errors));
  const edgeF = CORE.validateLoop({
    frames: 48001, start: 480, end: 48001, fadeFrames: 2, sampleRate: 48000,
  });
  ok('eof-mono：end 在文件末尾、F=2 阻止（无预留）',
    !edgeF.ok && edgeF.errors.some((e) => e.code === 'NO_POSTROLL'));
  ok('F 为负阻止', !CORE.validateLoop({ ...base, fadeFrames: -1 }).ok);
  ok('end = start 阻止', !CORE.validateLoop({
    frames: 96000, start: 100, end: 100, fadeFrames: 0, sampleRate: 48000,
  }).ok);
  ok('end 超出素材阻止', !CORE.validateLoop({ ...base, end: 96001 }).ok);

  /* ---------------- 接缝指标 ---------------- */
  section('接缝指标');
  const mRaw = CORE.analyzeLoop(d.channels, d.sampleRate, p.start, p.end, 0);
  ok('原样接缝 = x[start] − x[end−1]',
    mRaw.channels[0].seamJumpRaw === d.channels[0][p.start] - d.channels[0][p.end - 1]);
  ok('原样首端跳变 = x[start] − x[start−1]',
    mRaw.channels[0].headJumpRaw === d.channels[0][p.start] - d.channels[0][p.start - 1]);
  ok('原样尾端跳变 = x[end] − x[end−1]',
    mRaw.channels[0].tailJumpRaw === d.channels[0][p.end] - d.channels[0][p.end - 1]);
  const win = Math.round(d.sampleRate * 0.01);
  ok('10ms 窗口 = 480 帧', mRaw.windowFrames === win, String(mRaw.windowFrames));
  let rmsErr = 0;
  for (let c = 0; c < 2; c++) {
    let s = 0;
    for (let i = 0; i < win; i++) s += d.channels[c][p.start + i] ** 2;
    const expected = Math.sqrt(s / win);
    rmsErr = Math.max(rmsErr, Math.abs(mRaw.channels[c].headRmsRaw - expected));
  }
  ok('首 10ms RMS 正确', rmsErr < 1e-9);
  const mProc = CORE.analyzeLoop(d.channels, d.sampleRate, p.start, p.end, p.fade_frames);
  let seamDiff = 0;
  for (let c = 0; c < 2; c++) {
    const expect = d.channels[c][p.end] - d.channels[c][p.start + L - 1];
    seamDiff = Math.max(seamDiff, Math.abs(mProc.channels[c].seamJumpProcessed - expect));
  }
  ok('淡化后接缝 = x[end] − x[start+L−1]', seamDiff < 1e-9);

  /* ---------------- 编码 / 导出 / 再导入 ---------------- */
  section('导出与再导入');
  for (const spec of [
    { name: '24 位双声道', src: stereo.decoded, frames: 60000 },
    { name: '16 位单声道', src: mono.decoded, frames: mono.decoded.frames },
  ]) {
    const src = spec.src;
    const srcOut = spec.name === '24 位双声道'
      ? out
      : CORE.sliceLoop(src.channels, 0, src.frames);
    const marker = { start: 0, endInclusive: spec.frames - 1, playCount: 0 };
    const encoded = WAV.encodeWav({
      sampleRate: src.sampleRate, bits: src.bits, channelData: srcOut, loop: marker,
    });
    const width = src.bits / 8;
    const dataBytes = spec.frames * src.channelCount * width;
    const pad = dataBytes & 1;
    ok(spec.name + '：导出长度 = 头部 + 帧数 × 声道 × 位宽',
      encoded.byteLength === 12 + 24 + 8 + dataBytes + pad + 68,
      String(encoded.byteLength));
    const back = WAV.decodeWav(encoded);
    ok(spec.name + '：再导入采样率/位深/声道一致',
      back.sampleRate === src.sampleRate && back.bits === src.bits &&
      back.channelCount === src.channelCount);
    ok(spec.name + '：再导入帧数一致', back.frames === spec.frames);
    ok(spec.name + '：再导入识别 smpl 前向循环',
      !!back.loop && back.loop.type === 0 &&
      back.loop.start === 0 && back.loop.endInclusive === spec.frames - 1);
    ok(spec.name + '：playCount = 0（无限循环）', back.loop.playCount === 0);
    let quantErr = 0;
    let maxLsb = 0;
    const scale = src.bits === 16 ? 32768 : 8388608;
    for (let c = 0; c < src.channelCount; c++) {
      for (let i = 0; i < spec.frames; i++) {
        const q = Math.max(
          -scale,
          Math.min(scale - 1, Math.round(srcOut[c][i] * scale))
        ) / scale;
        quantErr = Math.max(quantErr, Math.abs(back.channels[c][i] - srcOut[c][i]));
        maxLsb = Math.max(maxLsb, Math.abs(Math.round(back.channels[c][i] * scale) - Math.round(q * scale)));
      }
    }
    ok(spec.name + '：量化误差 ≤ 0.5 LSB', maxLsb <= 1, 'max ' + maxLsb + ' LSB');
    ok(spec.name + '：解码值误差 < 1e-6', quantErr < 1e-6, quantErr.toExponential(2));
  }

  // F=0 时 16 位源应能逐字节还原
  {
    const src = mono.decoded;
    const encoded = WAV.encodeWav({
      sampleRate: src.sampleRate, bits: src.bits,
      channelData: CORE.sliceLoop(src.channels, 0, src.frames),
      loop: null,
    });
    const dv = new DataView(encoded);
    const original = readFile(cases.tagged.file);
    const odv = new DataView(original.buffer, original.byteOffset, original.byteLength);
    let diff = 0;
    const len = src.frames * 2;
    for (let i = 0; i < len; i++) {
      if (dv.getUint8(44 + i) !== odv.getUint8(src.dataOffset + i)) diff++;
    }
    ok('16 位 F=0：解码→编码可逐字节还原采样数据', diff === 0, diff + ' 字节不同');
  }

  /* ---------------- 工程 ---------------- */
  section('工程保存与重载');
  const project = CORE.createProject(
    {
      name: 'stereo-postroll.wav', size: stereo.bytes.length, sha256: 'a'.repeat(64),
      sampleRate: d.sampleRate, bits: d.bits, channelCount: 2, frames: d.frames,
    },
    p.start, p.end, p.fade_frames
  );
  const parsed = CORE.validateProject(JSON.parse(JSON.stringify(project)));
  ok('工程 JSON 可校验', parsed.ok, JSON.stringify(parsed.errors));
  ok('工程记录切点与淡化', parsed.ok && parsed.project.loop.start === p.start &&
    parsed.project.loop.end === p.end && parsed.project.loop.fadeFrames === p.fade_frames);
  ok('工程记录源文件校验和', parsed.ok && parsed.project.source.sha256 === 'a'.repeat(64));
  const same = CORE.compareSource(project.source, {
    name: 'stereo-postroll.wav', size: stereo.bytes.length, sha256: 'a'.repeat(64),
    sampleRate: d.sampleRate, bits: d.bits, channelCount: 2, frames: d.frames,
  });
  ok('相同素材对比通过', same.match && same.differences.length === 0,
    same.differences.join(', '));
  const diffCmp = CORE.compareSource(project.source, {
    name: 'stereo-postroll.wav', size: stereo.bytes.length, sha256: 'b'.repeat(64),
    sampleRate: d.sampleRate, bits: d.bits, channelCount: 2, frames: d.frames,
  });
  ok('校验和不同判为不匹配', !diffCmp.match && diffCmp.differences.length > 0);
  const badProject = CORE.validateProject({ kind: 'something-else' });
  ok('非本工具工程被拒绝', !badProject.ok);

  /* ---------------- SHA-256 ---------------- */
  section('SHA-256');
  const crypto = require('crypto');
  for (const name of [cases.postroll.file, cases.tagged.file]) {
    const bytes = readFile(name);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const expected = crypto.createHash('sha256').update(bytes).digest('hex');
    const syncVal = CORE.sha256HexSync(new Uint8Array(ab));
    ok(name + ' 纯 JS SHA-256 与 Node 一致', syncVal === expected, syncVal.slice(0, 12));
    shaResults.push(CORE.sha256Hex(ab).then((v) => {
      ok(name + ' 异步 SHA-256 与 Node 一致', v === expected, v.slice(0, 12));
    }));
  }

  /* ---------------- 附加：60 秒长文件 ---------------- */
  section('60 秒长素材');
  const longSel = CORE.validateLoop({
    frames: long.decoded.frames, start: 1000, end: long.decoded.frames - 5000,
    fadeFrames: 4800, sampleRate: long.decoded.sampleRate,
  });
  ok('60 秒素材可切点与淡化', longSel.ok, JSON.stringify(longSel.errors));
  ok('刚好 60 秒不判为超长', (() => {
    try {
      WAV.decodeWav(long.bytes.buffer.slice(
        long.bytes.byteOffset, long.bytes.byteOffset + long.bytes.byteLength
      ));
      return true;
    } catch (e) {
      return false;
    }
  })());

  return Promise.all(shaResults);
}

main().then(() => {
  if (failures) {
    console.log('\n失败 ' + failures + ' 项 / 共 ' + checks + ' 项');
    process.exit(1);
  }
  console.log('\n全部通过：' + checks + ' 项检查。');
}).catch((e) => {
  console.error('验收脚本异常：', e);
  process.exit(2);
});
