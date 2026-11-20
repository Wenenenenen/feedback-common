// lobe-cubemap-baker 核心：方向表、跨面双线性、确定性球面采样与积分。
// 纯计算模块，不依赖 DOM，浏览器与 Node 均可 import。
// 所有约定严格遵循 samples 包内 说明.txt。

export const FACE_ORDER = ["px", "nx", "py", "ny", "pz", "nz"];

// ---------- 基础向量运算 ----------
export const v3 = (x, y, z) => [x, y, z];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const normalize = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// ---------- 说明.txt 方向表 ----------
// 面内 u、v 由左上 (-1,-1) 到右下 (1,1)。
export function faceUVToDir(face, u, v) {
  let d;
  switch (face) {
    case "px": d = [1, -v, -u]; break;
    case "nx": d = [-1, -v, u]; break;
    case "py": d = [u, 1, v]; break;
    case "ny": d = [u, -1, -v]; break;
    case "pz": d = [u, -v, 1]; break;
    case "nz": d = [-u, -v, -1]; break;
    default: throw new Error(`未知面: ${face}`);
  }
  return normalize(d);
}

// 方向 -> 面、面内 u/v（u、v 落在 [-1,1]）。
// 方向表中的方向是归一化后的结果，反算面内坐标必须除以主导分量，
// 还原到 x/y/z = ±1 的单位平面上。
export function dirToFaceUV(d) {
  const [x, y, z] = d;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  // 按绝对值最大坐标选面，并列按 px,nx,py,ny,pz,nz 顺序。
  // 显式枚举六个候选，>= 保证先枚举的面在并列时胜出。
  const candidates = [
    ["px", ax, x >= 0],
    ["nx", ax, x < 0],
    ["py", ay, y >= 0],
    ["ny", ay, y < 0],
    ["pz", az, z >= 0],
    ["nz", az, z < 0],
  ];
  let face = null;
  let best = -1;
  for (const [name, mag, signOk] of candidates) {
    if (signOk && mag >= best) {
      best = mag;
      face = name;
    }
  }
  let u, v;
  // 严格由方向表反解。d = 面方向 / L，先求 L 再还原 u、v：
  //  px ( 1,-v,-u), L=1/x : u=-z/x  v=-y/x
  //  nx (-1,-v, u), L=-1/x: u=-z/x  v= y/x
  //  py ( u, 1, v), L=1/y : u= x/y  v= z/y
  //  ny ( u,-1,-v), L=-1/y: u=-x/y  v= z/y
  //  pz ( u,-v, 1), L=1/z : u= x/z  v=-y/z
  //  nz (-u,-v,-1), L=-1/z: u= x/z  v= y/z
  switch (face) {
    case "px": u = -z / x; v = -y / x; break;
    case "nx": u = -z / x; v = y / x; break;
    case "py": u = x / y; v = z / y; break;
    case "ny": u = -x / y; v = z / y; break;
    case "pz": u = x / z; v = -y / z; break;
    case "nz": u = x / z; v = y / z; break;
  }
  // 浮点误差保护：选面保证 |u|,|v| <= 1，仅可能超出极小量。
  u = Math.min(1, Math.max(-1, u));
  v = Math.min(1, Math.max(-1, v));
  return { face, u, v };
}

// 纹素中心 (col,row) -> u,v。
export function texelCenterUV(N, col, row) {
  return [-1 + (2 * (col + 0.5)) / N, -1 + (2 * (row + 0.5)) / N];
}

// 预计算某尺寸立方体面每个纹素中心的方向表。
export function buildTexelDirs(N) {
  const dirs = {};
  for (const face of FACE_ORDER) {
    const arr = new Float64Array(N * N * 3);
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const [u, v] = texelCenterUV(N, col, row);
        const d = faceUVToDir(face, u, v);
        const o = (row * N + col) * 3;
        arr[o] = d[0]; arr[o + 1] = d[1]; arr[o + 2] = d[2];
      }
    }
    dirs[face] = arr;
  }
  return dirs;
}

// ---------- 立方体贴图环境 ----------
// faces: { face: Float32Array(N*N*3) }，行优先 RGB。
export class CubeEnv {
  constructor(N, faces) {
    this.N = N;
    this.faces = faces;
    this.texelDirs = buildTexelDirs(N);
  }

  // 取某面某纹素（最近邻，越界由调用方保证）。
  texel(face, row, col) {
    const o = (row * this.N + col) * 3;
    const a = this.faces[face];
    return [a[o], a[o + 1], a[o + 2]];
  }

  // 纹素中心方向（用于越界邻点“重选面”）。
  texelCenterDir(face, row, col) {
    const o = (row * this.N + col) * 3;
    const a = this.texelDirs[face];
    return [a[o], a[o + 1], a[o + 2]];
  }

  // 方向上的最近邻取值。
  sampleNearestDir(d) {
    const { face, u, v } = dirToFaceUV(d);
    let col = Math.round(((u + 1) * this.N) / 2 - 0.5);
    let row = Math.round(((v + 1) * this.N) / 2 - 0.5);
    col = Math.min(this.N - 1, Math.max(0, col));
    row = Math.min(this.N - 1, Math.max(0, row));
    return this.texel(face, row, col);
  }

  // 说明.txt 跨面双线性：
  // 像素坐标 ((u+1)*N/2-0.5, (v+1)*N/2-0.5)；越界邻点用原面该纹素中心
  // 对应方向重选面，再取邻面最近纹素；四个原双线性权重不变。
  sampleBilinearDir(d) {
    const { face, u, v } = dirToFaceUV(d);
    const px = ((u + 1) * this.N) / 2 - 0.5;
    const py = ((v + 1) * this.N) / 2 - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const tx = px - x0, ty = py - y0;
    const w = [
      (1 - tx) * (1 - ty),
      tx * (1 - ty),
      (1 - tx) * ty,
      tx * ty,
    ];
    const corners = [
      { col: x0, row: y0 },
      { col: x0 + 1, row: y0 },
      { col: x0, row: y0 + 1 },
      { col: x0 + 1, row: y0 + 1 },
    ];
    const acc = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      let { col, row } = corners[k];
      let value;
      if (col >= 0 && col < this.N && row >= 0 && row < this.N) {
        value = this.texel(face, row, col);
      } else {
        // 越界：仅夹越界坐标，另一坐标保持原行/列，取原面该纹素中心方向
        // 重选面，再取邻面最近纹素（四个原双线性权重不变）。
        const cc = Math.min(this.N - 1, Math.max(0, col));
        const rr = Math.min(this.N - 1, Math.max(0, row));
        // col 越界时用 (cc, row 对应纹素行)；row 越界时用 (col 对应纹素列, rr)。
        const edgeCol = col < 0 || col >= this.N ? cc : col;
        const edgeRow = row < 0 || row >= this.N ? rr : row;
        const nd = this.texelCenterDir(face, edgeRow, edgeCol);
        value = this.sampleNearestDir(nd);
      }
      acc[0] += w[k] * value[0];
      acc[1] += w[k] * value[1];
      acc[2] += w[k] * value[2];
    }
    return acc;
  }
}

// ---------- 确定性球面采样 ----------
// i 的二进制位反转小数（Van der Corput，基数 2）。
export function radicalInverse2(i) {
  let x = i;
  let result = 0;
  let bit = 0.5;
  while (x > 0) {
    if (x & 1) result += bit;
    x >>>= 1;
    bit *= 0.5;
  }
  return result;
}

// 余弦幂核指数。
export function roughnessToExponent(r) {
  return Math.max(0, 2 / (r * r) - 2);
}

// 以 d 为极轴的局部帧（说明.txt 规则）。
export function localFrame(d) {
  const a = Math.abs(d[2]) < 0.999 ? [0, 0, 1] : [0, 1, 0];
  const t = normalize(cross(a, d));
  const b = cross(d, t);
  return { t, b };
}

// 第 i 个重要性采样方向（共 S 个）。
export function sampleLobe(d, n, i, S) {
  const xi1 = (i + 0.5) / S;
  const xi2 = radicalInverse2(i);
  const cosTheta = Math.pow(1 - xi1, 1 / (n + 1));
  const phi = 2 * Math.PI * xi2;
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const { t, b } = localFrame(d);
  const omega = add(
    add(scale(t, sinTheta * Math.cos(phi)), scale(b, sinTheta * Math.sin(phi))),
    scale(d, cosTheta)
  );
  return normalize(omega);
}

// ---------- 烘焙 ----------
// 对单个输出纹素积分。onSample 可选，逐样本回调用于采样追踪。
// 返回 { value, samples: [...] }（samples 仅在需要时构造）。
export function bakeTexel(env, outDir, r, S, wantTrace) {
  if (r === 0) {
    // r=0 直接取 d 方向环境（经跨面双线性重采样）。
    const value = env.sampleBilinearDir(outDir);
    const result = { value };
    if (wantTrace) {
      result.samples = [{
        i: 0,
        dir: [outDir[0], outDir[1], outDir[2]],
        envFace: dirToFaceUV(outDir).face,
        env: value.slice(),
        weight: 1,
      }];
    }
    return result;
  }
  const n = roughnessToExponent(r);
  const acc = [0, 0, 0];
  const samples = wantTrace ? [] : null;
  for (let i = 0; i < S; i++) {
    const omega = sampleLobe(outDir, n, i, S);
    const envVal = env.sampleBilinearDir(omega);
    acc[0] += envVal[0]; acc[1] += envVal[1]; acc[2] += envVal[2];
    if (wantTrace) {
      samples.push({
        i,
        dir: [omega[0], omega[1], omega[2]],
        envFace: dirToFaceUV(omega).face,
        env: [envVal[0], envVal[1], envVal[2]],
        weight: 1 / S, // 重要性采样：等权平均
      });
    }
  }
  const value = [acc[0] / S, acc[1] / S, acc[2] / S];
  return { value, samples };
}

// 整张贴面烘焙。outN <= 32。返回 { faces, texelDirs, traces? }。
export async function bakeCubemap(env, r, S, outN, opts = {}) {
  const { onProgress = null, traceFaces = null, signal = null } = {};
  const outDirs = buildTexelDirs(outN);
  const out = {};
  const traces = {};
  const total = FACE_ORDER.length * outN * outN;
  let done = 0;
  for (const face of FACE_ORDER) {
    const buf = new Float32Array(outN * outN * 3);
    const dirArr = outDirs[face];
    const faceTrace = traceFaces && traceFaces.has(face) ? [] : null;
    for (let p = 0; p < outN * outN; p++) {
      if (signal && signal.cancelled) {
        const err = new Error("已取消");
        err.name = "AbortError";
        throw err;
      }
      const d = [dirArr[p * 3], dirArr[p * 3 + 1], dirArr[p * 3 + 2]];
      const { value, samples } = bakeTexel(env, d, r, S, faceTrace !== null);
      buf[p * 3] = value[0]; buf[p * 3 + 1] = value[1]; buf[p * 3 + 2] = value[2];
      if (faceTrace) faceTrace.push({ row: Math.floor(p / outN), col: p % outN, dir: d, samples });
      done++;
      if (onProgress && (done % 256 === 0 || done === total)) onProgress(done / total);
      // 每批让出事件循环，避免长任务冻结 UI。
      if ((done & 255) === 0) await new Promise((res) => setTimeout(res, 0));
    }
    out[face] = buf;
    if (faceTrace) traces[face] = faceTrace;
  }
  return { faces: out, texelDirs: outDirs, traces };
}

// ---------- 预览色调映射与 sRGB ----------
export function toneMap(linear, exposure) {
  return 1 - Math.exp(-exposure * linear);
}
export function linearToSRGB(c) {
  c = Math.min(1, Math.max(0, c));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
export function displayColor(rgb, exposure) {
  return [
    Math.round(linearToSRGB(toneMap(rgb[0], exposure)) * 255),
    Math.round(linearToSRGB(toneMap(rgb[1], exposure)) * 255),
    Math.round(linearToSRGB(toneMap(rgb[2], exposure)) * 255),
  ];
}

// ---------- PFM（小端 RGB float32，底行优先） ----------
export function encodePFM(width, height, rgbFloat32) {
  const header = new TextEncoder().encode(`PF\n${width} ${height}\n-1.0\n`);
  // 输入为顶行优先，PFM 按底行优先写出。
  const body = new Uint8Array(width * height * 3 * 4);
  const view = new DataView(body.buffer);
  for (let row = height - 1; row >= 0; row--) {
    const srcOff = row * width * 3;
    const dstOff = ((height - 1) - row) * width * 3;
    for (let k = 0; k < width * 3; k++) {
      view.setFloat32((dstOff + k) * 4, rgbFloat32[srcOff + k], true);
    }
  }
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

export function parsePFM(bytes) {
  // 返回 { width, height, data: Float32Array 顶行优先 RGB }。
  let pos = 0;
  const readToken = () => {
    while (pos < bytes.length && (bytes[pos] === 0x20 || bytes[pos] === 0x0a || bytes[pos] === 0x09)) pos++;
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0x20 && bytes[pos] !== 0x0a && bytes[pos] !== 0x09) pos++;
    return new TextDecoder().decode(bytes.subarray(start, pos));
  };
  const magic = readToken();
  if (magic !== "PF" && magic !== "Pf") throw new Error("PFM 魔数无效");
  const width = parseInt(readToken(), 10);
  const height = parseInt(readToken(), 10);
  const scale = parseFloat(readToken());
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("PFM 尺寸无效");
  pos++; // 跳过头部最后一个换行
  const channels = magic === "PF" ? 3 : 1;
  const littleEndian = scale < 0;
  const expected = width * height * channels * 4;
  if (bytes.length - pos < expected) throw new Error("PFM 数据长度不足");
  const view = new DataView(bytes.buffer, bytes.byteOffset + pos, expected);
  // PFM 像素按底行优先存储：文件第 fileRow 行 = 图像顶行优先的 (height-1-fileRow) 行。
  const topDown = new Float32Array(width * height * 3);
  for (let fileRow = 0; fileRow < height; fileRow++) {
    const imageRow = height - 1 - fileRow;
    for (let k = 0; k < width * 3; k++) {
      let v;
      if (channels === 3) {
        v = view.getFloat32((fileRow * width * 3 + k) * 4, littleEndian);
      } else {
        v = view.getFloat32((fileRow * width + (k / 3 | 0)) * 4, littleEndian);
      }
      topDown[imageRow * width * 3 + k] = v;
    }
  }
  return { width, height, data: topDown };
}
