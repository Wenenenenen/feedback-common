// 确定性 + 采样核解析真值测试。
// 用法: node tools/test_core.mjs
import { FACE_ORDER, CubeEnv, bakeCubemap, bakeTexel, sampleLobe, roughnessToExponent, faceUVToDir, radicalInverse2 } from "../app/cube-core.js";

let failures = 0;
const assert = (cond, msg) => { if (!cond) { failures++; console.error("FAIL:", msg); } else console.log("ok  :", msg); };

// 1) 确定性：两次烘焙逐位一致。
{
  const N = 8;
  const faces = {};
  let seed = 99;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (const f of FACE_ORDER) {
    const b = new Float32Array(N * N * 3);
    for (let i = 0; i < b.length; i++) b[i] = rnd() * 5;
    faces[f] = b;
  }
  const env = new CubeEnv(N, faces);
  const a = await bakeCubemap(env, 0.5, 256, 16);
  const b = await bakeCubemap(env, 0.5, 256, 16);
  let identical = true;
  for (const f of FACE_ORDER) for (let i = 0; i < a.faces[f].length; i++) {
    if (a.faces[f][i] !== b.faces[f][i]) identical = false;
  }
  assert(identical, "相同输入两次烘焙逐位一致（确定性）");
}

// 2) 采样方向都在 d 的半球内且归一化。
{
  const d = faceUVToDir("px", 0.3, -0.7);
  const n = roughnessToExponent(0.5);
  const S = 512;
  let allUpper = true, allUnit = true;
  for (let i = 0; i < S; i++) {
    const w = sampleLobe(d, n, i, S);
    const dotv = w[0] * d[0] + w[1] * d[1] + w[2] * d[2];
    const len = Math.hypot(w[0], w[1], w[2]);
    if (dotv < -1e-12) allUpper = false;
    if (Math.abs(len - 1) > 1e-9) allUnit = false;
  }
  assert(allUpper, "全部采样方向位于 d 半球 (dot>=0)");
  assert(allUnit, "全部采样方向已归一化");
}

// 3) 蒙特卡洛积分收敛：常量核积分恒等于常量；半球权重积分≈1。
{
  const N = 4;
  const c = [0.7, 1.3, 2.1];
  const faces = {};
  for (const f of FACE_ORDER) {
    const b = new Float32Array(N * N * 3);
    for (let i = 0; i < N * N; i++) { b[i * 3] = c[0]; b[i * 3 + 1] = c[1]; b[i * 3 + 2] = c[2]; }
    faces[f] = b;
  }
  const env = new CubeEnv(N, faces);
  const d = faceUVToDir("pz", 0.1, 0.2);
  for (const r of [0.25, 0.5, 1]) {
    const { value } = bakeTexel(env, d, r, 1024, false);
    const ok = value.every((v, k) => Math.abs(v - c[k]) < 1e-6);
    assert(ok, `常量环境 r=${r} 积分保持常量 ${JSON.stringify(c)}`);
  }
}

// 4) r=0 直接重采样：返回值即 d 方向双线性，不含采样循环。
{
  const N = 4;
  const faces = {};
  for (const f of FACE_ORDER) {
    const b = new Float32Array(N * N * 3);
    for (let i = 0; i < b.length; i++) b[i] = i % 7 * 0.1;
    faces[f] = b;
  }
  const env = new CubeEnv(N, faces);
  const d = faceUVToDir("ny", -0.4, 0.6);
  const r0 = bakeTexel(env, d, 0, 256, false);
  const direct = env.sampleBilinearDir(d);
  assert(r0.value.every((v, k) => Math.abs(v - direct[k]) < 1e-7), "r=0 等价于 d 方向双线性重采样");
}

// 5) 位反转序列（Van der Corput，基数 2），i 从 0 起算。
{
  // i:        0     1    2     3    4      5     6      7
  const expected = [0, 0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875];
  const got = expected.map((_, i) => radicalInverse2(i));
  assert(got.every((v, i) => v === expected[i]), "Van der Corput 位反转前 8 项正确");
}

console.log(failures === 0 ? "\n全部核心测试通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
