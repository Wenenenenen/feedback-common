// Node 驱动：用 app/cube-core.js 烘焙样例，输出 JSON 供与 Python 参考对拍。
// 用法: node tools/node_bake.mjs <env.json> <out.json> <outN> [samples]
import { readFileSync, writeFileSync } from "node:fs";
import { FACE_ORDER, CubeEnv, bakeCubemap } from "../app/cube-core.js";

const [envPath, outPath, outNArg, samplesArg] = process.argv.slice(2);
const outN = parseInt(outNArg, 10);
const S = samplesArg ? parseInt(samplesArg, 10) : 256;
const data = JSON.parse(readFileSync(envPath, "utf8"));
const N = data.size;
const faces = {};
for (const f of FACE_ORDER) {
  const flat = new Float32Array(N * N * 3);
  data.faces[f].forEach((c, i) => {
    flat[i * 3] = c[0]; flat[i * 3 + 1] = c[1]; flat[i * 3 + 2] = c[2];
  });
  faces[f] = flat;
}
const env = new CubeEnv(N, faces);
const result = {};
for (const r of [0, 0.25, 0.5, 1]) {
  const baked = await bakeCubemap(env, r, S, outN);
  result[String(r)] = Object.fromEntries(
    FACE_ORDER.map((f) => [f, Array.from(baked.faces[f])])
  );
}
writeFileSync(outPath, JSON.stringify(result));
console.log("wrote", outPath);
