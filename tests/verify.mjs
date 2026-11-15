// 对照 samples/loudness-cases/reference.json 的独立验收脚本（Node 运行：node tests/verify.mjs）。
// 仅使用仓库自研模块，不调用 ffmpeg 或任何现成响度库。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseWav, encodeWav24 } from '../js/wav-codec.js';
import { analyze } from '../js/meter.js';
import { planGain, applyGain } from '../js/gain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, '..', 'samples', 'loudness-cases');
const reference = JSON.parse(await readFile(path.join(casesDir, 'reference.json'), 'utf8'));

const I_TOL = 0.2;
const TP_TOL = 0.3;
const SP_TOL = 0.05; // 采样峰值应几乎一致

let failures = 0;
const fmt = (v) => (v === null || v === undefined ? 'null' : v.toFixed(3));

for (const tc of reference.cases) {
  const bytes = await readFile(path.join(casesDir, tc.file));
  const wav = parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  // 头信息核对
  const headerOk =
    wav.sampleRate === tc.rate &&
    wav.channels === tc.channels &&
    wav.bitsPerSample === tc.bits &&
    wav.frames === tc.frames;

  const m = analyze(wav.planar, wav.sampleRate);
  const errs = [];
  if (!headerOk) {
    errs.push(`头信息不符: ${wav.sampleRate}/${wav.channels}ch/${wav.bitsPerSample}bit/${wav.frames}f`);
  }

  // 整轨 I
  if (tc.i_lufs === null) {
    if (m.integratedLufs !== null) errs.push(`I 应为 null，实得 ${fmt(m.integratedLufs)}`);
  } else {
    const d = Math.abs(m.integratedLufs - tc.i_lufs);
    if (d > I_TOL) errs.push(`I 偏差 ${d.toFixed(3)} LU（参考 ${tc.i_lufs}，实得 ${fmt(m.integratedLufs)}）`);
  }

  // 参考值按文件给出，取各声道最大值比较；同时逐声道数值仍在页面展示
  const maxSp = Math.max(...m.perChannel.map((x) => x.samplePeakDbfs ?? -Infinity));
  const maxTp = Math.max(...m.perChannel.map((x) => x.truePeakDbtp ?? -Infinity));
  if (tc.sample_peak_dbfs === null) {
    if (!m.perChannel.every((x) => x.samplePeakDbfs === null)) errs.push('采样峰值应为 null（静音）');
  } else if (Math.abs(maxSp - tc.sample_peak_dbfs) > SP_TOL) {
    errs.push(`采样峰值偏差 ${Math.abs(maxSp - tc.sample_peak_dbfs).toFixed(3)}（参考 ${tc.sample_peak_dbfs}，实得 ${fmt(maxSp)}）`);
  }
  if (tc.true_peak_dbtp === null) {
    if (!m.perChannel.every((x) => x.truePeakDbtp === null)) errs.push('真峰值应为 null（静音）');
  } else if (Math.abs(maxTp - tc.true_peak_dbtp) > TP_TOL) {
    errs.push(`真峰值偏差 ${Math.abs(maxTp - tc.true_peak_dbtp).toFixed(3)} dB（参考 ${tc.true_peak_dbtp}，实得 ${fmt(maxTp)}）`);
  }

  // M/S 曲线基本规则
  const expectBlocks = Math.floor((wav.frames - Math.round(0.4 * wav.sampleRate)) / Math.round(0.1 * wav.sampleRate)) + 1;
  if (m.mCurve.length !== Math.max(0, expectBlocks)) {
    errs.push(`M 点数 ${m.mCurve.length}，预期 ${Math.max(0, expectBlocks)}`);
  }
  if (m.sCurve.length !== m.mCurve.length) errs.push('S 点数与 M 不一致');
  const shortBlocks = Math.round(3 / 0.4); // 30 个块
  const nullS = m.sCurve.slice(0, shortBlocks - 1).filter((p) => p.lufs === null).length;
  if (wav.frames / wav.sampleRate >= 0.4 && nullS !== Math.min(shortBlocks - 1, m.sCurve.length)) {
    errs.push('S 曲线前 2.9s 未全部标记为不可测');
  }

  // 增益决策 + 往返
  const plan = planGain(m, tc.target_lufs, tc.ceiling_dbtp);
  if (tc.i_lufs === null) {
    if (plan.canDeliver) errs.push('不可测素材竟然允许交付');
  } else {
    if (!plan.canDeliver) errs.push(`应可交付，原因: ${plan.reason}`);
    const processed = applyGain(wav.planar, plan.gainLinear);
    const m2 = analyze(processed, wav.sampleRate);
    const i2err = Math.abs(m2.integratedLufs - (tc.i_lufs + plan.gainDb));
    if (i2err > I_TOL) errs.push(`处理后 I 复核偏差 ${i2err.toFixed(3)}`);
    const maxTp2 = Math.max(...m2.perChannel.map((x) => x.truePeakDbtp));
    if (maxTp2 > tc.ceiling_dbtp + TP_TOL) errs.push(`处理后真峰值 ${maxTp2.toFixed(3)} 越上限`);
    // 帧数/声道一致
    if (processed.length !== wav.channels || processed[0].length !== wav.frames) errs.push('处理后帧数/声道改变');
    // 24 位 WAV 往返
    const packed = encodeWav24(wav.sampleRate, wav.channels, processed, wav.frames);
    const reparsed = parseWav(packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength));
    if (reparsed.frames !== wav.frames || reparsed.channels !== wav.channels || reparsed.bitsPerSample !== 24) {
      errs.push('导出 WAV 规格不符');
    }
  }

  const status = errs.length === 0 ? 'PASS' : 'FAIL';
  if (errs.length) failures++;
  console.log(
    `[${status}] ${tc.file.padEnd(18)} I=${fmt(m.integratedLufs).padStart(8)} ` +
      `SP=${fmt(m.perChannel[0].samplePeakDbfs).padStart(8)} TP=${fmt(m.perChannel[0].truePeakDbtp).padStart(8)}` +
      (wav.channels > 1 ? `/${fmt(m.perChannel[1].truePeakDbtp).padStart(7)}` : '        '),
  );
  for (const e of errs) console.log(`         - ${e}`);
}

console.log(`\n${reference.cases.length - failures}/${reference.cases.length} 用例通过`);
process.exit(failures ? 1 : 0);
