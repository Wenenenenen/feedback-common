// 导出 JS 端对固定方向列表的双线性采样结果。
// 用法: node tools/probe_bilinear.mjs <env.json> <dirs.json>
import { readFileSync, writeFileSync } from "node:fs";
import { FACE_ORDER, CubeEnv } from "../app/cube-core.js";

const [envPath, dirsPath] = process.argv.slice(2);
const data = JSON.parse(readFileSync(envPath, "utf8"));
const N = data.size;
const faces = {};
for (const f of FACE_ORDER) {
  const flat = new Float32Array(N * N * 3);
  data.faces[f].forEach((c, i) => { flat[i * 3] = c[0]; flat[i * 3 + 1] = c[1]; flat[i * 3 + 2] = c[2]; });
  faces[f] = flat;
}
const env = new CubeEnv(N, faces);
const dirs = JSON.parse(readFileSync(dirsPath, "utf8"));
const out = dirs.map((d) => env.sampleBilinearDir(d));
writeFileSync("/tmp/lcb-verify/bilinear-js.json", JSON.stringify(out));
console.log("wrote", out.length);
