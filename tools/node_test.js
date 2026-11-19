/* Node 数值验证：JS 版 dsp.js 对照参考 pair-lags 与 Python 结果 */
"use strict";
const fs = require("fs");
const path = require("path");
const dsp = require("../app/dsp.js");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "sample-data");

function loadPair(name) {
  const audio = dsp.decodePCM(fs.readFileSync(path.join(DATA, name + ".wav")).buffer);
  const geoRaw = JSON.parse(fs.readFileSync(path.join(DATA, name + ".json"), "utf8"));
  const geo = dsp.validateGeometry(geoRaw, audio.channelsCount);
  const ref = JSON.parse(fs.readFileSync(path.join(DATA, name + "-pair-lags.json"), "utf8"));
  return { audio, geo, geoRaw, ref };
}

function approxEqual(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

let failures = 0;
const check = (cond, msg) => {
  if (cond) {
    console.log("  PASS " + msg);
  } else {
    failures++;
    console.log("  FAIL " + msg);
  }
};

for (const name of ["scene37", "scene217"]) {
  console.log("\n=== " + name + " ===");
  const { audio, geo, geoRaw, ref } = loadPair(name);
  check(audio.sampleRate === 48000, "sample rate 48000");
  check(audio.bitsPerSample === 16, "16-bit");
  check(audio.channelsCount === 5, "5 channels");
  check(audio.frameCount === 24000, "24000 frames (5s)");

  const m = dsp.measurePairs(audio, geo, 0, audio.frameCount);
  check(m.pairs.length === 10, "10 pairs for 5 mics");
  let maxLagErr = 0;
  for (const p of m.pairs) {
    const r = ref.find((d) => d.i === p.i && d.j === p.j);
    const err = Math.abs(p.lagSamples - r.lag_samples);
    maxLagErr = Math.max(maxLagErr, err);
  }
  console.log("  max |JS lag - reference| = " + maxLagErr.toFixed(5) + " samples");
  check(maxLagErr < 0.15, "lag agreement within observed parabola-interp tolerance (<0.15)");

  // 与 Python 参考输出的已知值对照（scene37: 36.9296°, rms 0.0887 samp）
  const silence = dsp.checkSilence(m);
  check(silence === null, "not silence");
  const fit = dsp.fitBearing(m.pairs, geo, audio.sampleRate);
  check(fit.valid === true, "bearing fit valid");
  console.log("  bearing = " + fit.bearingDeg.toFixed(4) + " deg (expected " +
    geoRaw.expected_bearing_deg + ")");
  const dAng = Math.abs(((fit.bearingDeg - geoRaw.expected_bearing_deg + 180) % 360) - 180);
  check(dAng < 0.2, "bearing within 0.2 deg of expected (got " + dAng.toFixed(3) + ")");
  check(fit.rmsSamples < 0.15, "rms residual < 0.15 samples (got " +
    fit.rmsSamples.toFixed(4) + ")");

  // 子区间
  const m2 = dsp.measurePairs(audio, geo, 10000, 20000);
  const fit2 = dsp.fitBearing(m2.pairs, geo, audio.sampleRate);
  check(Math.abs(fit2.bearingDeg - fit.bearingDeg) < 0.01,
    "sub-interval [10000,20000) gives same bearing");

  // 物理上限：每个滞后都在 ±maxLag 内
  const within = m.pairs.every((p) => Math.abs(p.lagSamples) <= p.maxLag + 1e-12);
  check(within, "all lags within physical max lag");
}

// 静音：必须拒绝
console.log("\n=== silence ===");
{
  const audio = dsp.decodePCM(fs.readFileSync(path.join(DATA, "silence.wav")).buffer);
  const geoRaw = JSON.parse(fs.readFileSync(path.join(DATA, "scene37.json"), "utf8"));
  const geo = dsp.validateGeometry(geoRaw, audio.channelsCount);
  const m = dsp.measurePairs(audio, geo, 0, audio.frameCount);
  const s = dsp.checkSilence(m);
  check(s !== null && s.reason === "silence", "silence segment rejected: " + (s && s.message));
  const fit = dsp.fitBearing(m.pairs, geo, audio.sampleRate);
  check(fit.valid === true || fit.reason !== undefined, "fit returns structured result");
}

// 共线阵列：秩检查必须失败
console.log("\n=== collinear ===");
{
  const audio = dsp.decodePCM(fs.readFileSync(path.join(DATA, "scene37.wav")).buffer);
  const geoRaw = JSON.parse(fs.readFileSync(path.join(DATA, "collinear.json"), "utf8"));
  const geo = dsp.validateGeometry(geoRaw, audio.channelsCount);
  const m = dsp.measurePairs(audio, geo, 0, audio.frameCount);
  const fit = dsp.fitBearing(m.pairs, geo, audio.sampleRate);
  check(fit.valid === false && fit.reason === "collinear",
    "collinear array rejected: " + fit.message);
}

// 禁用通道对到不足以定向
console.log("\n=== disable pairs ===");
{
  const { audio, geo } = loadPair("scene37");
  const m = dsp.measurePairs(audio, geo, 0, audio.frameCount);
  // 只保留 0-1 一对
  m.pairs.forEach((p) => { p.enabled = false; });
  m.pairs[0].enabled = true;
  const fit = dsp.fitBearing(m.pairs, geo, audio.sampleRate);
  check(fit.valid === false && fit.reason === "insufficient", "single active pair rejected");
}

// 输入校验
console.log("\n=== validation ===");
{
  const audio = dsp.decodePCM(fs.readFileSync(path.join(DATA, "scene37.wav")).buffer);
  let threw = false;
  try { dsp.validateGeometry({ coordinates_m: [[0, 0]], speed_m_s: 343 }, audio.channelsCount); }
  catch (e) { threw = true; }
  check(threw, "coordinate/channel mismatch rejected");
  threw = false;
  try { dsp.validateGeometry({ coordinates_m: audio.channelsCount && [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]], speed_m_s: -1 }, audio.channelsCount); }
  catch (e) { threw = true; }
  check(threw, "non-positive speed rejected");
}

console.log("\n" + (failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
