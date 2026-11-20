// 探针：导出 JS 端 dirToFaceUV 与 sampleBilinearDir 的结果。
// 用法: node tools/probe.mjs <env.json>
import { readFileSync } from "node:fs";
import { FACE_ORDER, CubeEnv, faceUVToDir, dirToFaceUV, texelCenterUV } from "../app/cube-core.js";

const data = JSON.parse(readFileSync(process.argv[2], "utf8"));
const N = data.size;
const faces = {};
for (const f of FACE_ORDER) {
  const flat = new Float32Array(N * N * 3);
  data.faces[f].forEach((c, i) => { flat[i * 3] = c[0]; flat[i * 3 + 1] = c[1]; flat[i * 3 + 2] = c[2]; });
  faces[f] = flat;
}
const env = new CubeEnv(N, faces);

// 1) 用各面纹素中心方向做往返：dirToFaceUV(faceUVToDir(...)) 应回到原面、原 uv。
let worstUV = 0; const mism = [];
for (const f of FACE_ORDER) {
  for (let p = 0; p < N * N; p++) {
    const row = Math.floor(p / N), col = p % N;
    const [u, v] = texelCenterUV(N, col, row);
    const d = faceUVToDir(f, u, v);
    const back = dirToFaceUV(d);
    const du = Math.abs(back.u - u), dv = Math.abs(back.v - v);
    if (back.face !== f || du > 1e-9 || dv > 1e-9) {
      mism.push({ f, col, row, back: back.face, du, dv });
    }
    worstUV = Math.max(worstUV, du, dv);
  }
}
console.log("往返不一致数:", mism.length, "worstUV", worstUV);
console.log(JSON.stringify(mism.slice(0, 5)));

// 2) 导出一组方向上的双线性结果，供 Python 对拍。
const probes = [];
for (const f of FACE_ORDER) {
  for (const [col, row] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1], [N >> 1, N >> 1]]) {
    const [u, v] = texelCenterUV(N, col, row);
    const d = faceUVToDir(f, u, v);
    const val = env.sampleBilinearDir(d);
    const sel = dirToFaceUV(d);
    probes.push({ f, col, row, d, sel, val });
  }
}
console.log(JSON.stringify(probes, null, 0));
