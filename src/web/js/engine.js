/*
 * engine.js — 移动声源双耳渲染核心（无 DOM 依赖，可在 Worker / Node 中使用）。
 *
 * 物理模型（严格按 samples/moving-audio.zip/format.txt）：
 *   对每个整数接收帧 t、每只耳、每个发射段，解
 *       t - u = || S(u) - E(t) ||
 *   其中 S(u) 为段内匀速的发射位置，E(t) 为耳位按关键点线性插值的位置。
 *   取 u ∈ [start, end) 且 u <= t 的唯一解（h(u)=u+||S(u)-E(t)|| 严格递增）。
 *
 * 用“到达窗口 +  safeguarded 牛顿”而非逐帧全段扫描：
 *   A(t)=t-||S(start)-E(t)|| 单调递增，B(t)=t-||S(end)-E(t)|| 单调递增，
 *   段/耳在整数 t 上有解  ⇔  A(t) >= start 且 B(t) < end。
 *   由此用二分求出窗口 [t0,t1)，窗口内以相邻帧解为种子牛顿迭代，既精确又快。
 *
 * 采样：q = u - start + offset，floor(q) 与后一样本线性插值；
 *       后一样本越过本段引用末尾（offset+end-start）时记 0，不借下一段样本。
 * 混合：每项乘 8/(8+d)，d=t-u；同耳全部相加后四舍五入（.5 远离零）再夹到 int16。
 */

export const MAX_FRAMES = 2880000;
export const MAX_TRACKS = 8;
export const MAX_SEGMENTS = 6000;
export const MAX_EARS = 4096;
export const MAX_COMPONENT = 1000000;
export const EAR_SPEED_LIMIT = 0.5;
export const SRC_SPEED_LIMIT = 0.5;
const SPEED_EPS = 1e-9;
const NEWTON_TOL = 1e-7;

const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const arr3 = (v) =>
  Array.isArray(v) &&
  v.length === 3 &&
  v.every((c) => isInt(c) && Math.abs(c) <= MAX_COMPONENT);
const norm3 = (dx, dy, dz) => Math.sqrt(dx * dx + dy * dy + dz * dz);

/* ─────────────────────────── WAV 解析 ─────────────────────────── */

function readTag(u8, off, n) {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(u8[off + i]);
  return s;
}

/**
 * 解析 48kHz 单声道 PCM16 WAV。
 * 返回 {ok:true, frames, samples:Float64Array(整数样本值), dataOffset} 或 {ok:false, error}。
 */
export function parseWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 44) return { ok: false, error: "WAV 文件过短" };
  if (readTag(u8, 0, 4) !== "RIFF" || readTag(u8, 8, 4) !== "WAVE")
    return { ok: false, error: "不是 RIFF/WAVE 文件" };
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= u8.length) {
    const id = readTag(u8, pos, 4);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= u8.length) {
      fmt = { off: body };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, Math.max(0, u8.length - body));
      break;
    }
    pos = body + size + (size & 1);
  }
  if (!fmt) return { ok: false, error: "缺少 fmt 块" };
  if (dataOff < 0) return { ok: false, error: "缺少 data 块" };
  let tag = dv.getUint16(fmt.off, true);
  if (tag === 0xfffe) {
    // WAVE_FORMAT_EXTENSIBLE：真实格式在 subformat GUID 头 2 字节
    if (fmt.off + 26 > u8.length) return { ok: false, error: "fmt 扩展块损坏" };
    tag = dv.getUint16(fmt.off + 24, true);
  }
  const channels = dv.getUint16(fmt.off + 2, true);
  const rate = dv.getUint32(fmt.off + 4, true);
  const bits = dv.getUint16(fmt.off + 14, true);
  if (tag !== 1) return { ok: false, error: `WAV 不是整数 PCM（格式 ${tag}）` };
  if (channels !== 1) return { ok: false, error: `WAV 需为单声道（当前 ${channels} 声道）` };
  if (rate !== 48000) return { ok: false, error: `WAV 采样率需为 48000（当前 ${rate}）` };
  if (bits !== 16) return { ok: false, error: `WAV 位深需为 16-bit（当前 ${bits}）` };
  const frames = Math.floor(dataLen / 2);
  if (frames <= 0) return { ok: false, error: "WAV 没有采样数据" };
  const samples = new Float64Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = dv.getInt16(dataOff + 2 * i, true);
  return { ok: true, frames, samples };
}

/* ─────────────────────────── 校验 ─────────────────────────── */

export function validateScene(raw, wavInfo = {}) {
  const errors = [];
  const push = (path, msg) => errors.push({ path, msg });

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    push("scene", "场景必须是 JSON 对象");
    return errors;
  }

  const frames = raw.frames;
  const framesOk = isInt(frames) && frames >= 1 && frames <= MAX_FRAMES;
  if (!framesOk) push("frames", `frames 必须是 1..${MAX_FRAMES} 的整数`);

  /* ears */
  const ears = raw.ears;
  if (!Array.isArray(ears) || ears.length < 2 || ears.length > MAX_EARS) {
    push("ears", `ears 必须是 2..${MAX_EARS} 项的数组`);
  } else {
    let prevT = -Infinity;
    let prevL = null;
    let prevR = null;
    for (let i = 0; i < ears.length; i++) {
      const e = ears[i];
      const p = `ears[${i}]`;
      if (!e || typeof e !== "object" || Array.isArray(e)) {
        push(p, "耳位点必须是对象");
        prevL = prevR = null;
        continue;
      }
      if (!isInt(e.t)) push(`${p}.t`, "t 必须是整数");
      else {
        if (!(e.t > prevT)) push(`${p}.t`, "t 必须严格递增");
        if (i === 0 && e.t !== 0) push(`${p}.t`, "首项 t 必须为 0");
        if (framesOk && i === ears.length - 1 && e.t !== frames)
          push(`${p}.t`, "末项 t 必须等于 frames");
        if (framesOk && (e.t < 0 || e.t > frames))
          push(`${p}.t`, `t 必须在 0..${frames}`);
      }
      if (!arr3(e.left)) push(`${p}.left`, "left 必须是 3 个整数坐标，绝对值 ≤ 1000000");
      if (!arr3(e.right)) push(`${p}.right`, "right 必须是 3 个整数坐标，绝对值 ≤ 1000000");
      // 相邻关键点速度约束（用“上一个有效点”的 t，不能先更新 prevT）
      const prevTVal = prevT;
      if (arr3(e.left) && prevL && isInt(e.t) && Number.isFinite(prevTVal)) {
        const dt = e.t - prevTVal;
        const d = norm3(e.left[0] - prevL[0], e.left[1] - prevL[1], e.left[2] - prevL[2]);
        if (dt > 0 && d > dt * EAR_SPEED_LIMIT + SPEED_EPS)
          push(`${p}.left`, `左耳速度 ${(d / dt).toFixed(6)} 超过 1/2`);
      }
      if (arr3(e.right) && prevR && isInt(e.t) && Number.isFinite(prevTVal)) {
        const dt = e.t - prevTVal;
        const d = norm3(e.right[0] - prevR[0], e.right[1] - prevR[1], e.right[2] - prevR[2]);
        if (dt > 0 && d > dt * EAR_SPEED_LIMIT + SPEED_EPS)
          push(`${p}.right`, `右耳速度 ${(d / dt).toFixed(6)} 超过 1/2`);
      }
      if (isInt(e.t)) prevT = e.t;
      if (arr3(e.left)) prevL = e.left;
      if (arr3(e.right)) prevR = e.right;
    }
  }

  /* tracks */
  const tracks = raw.tracks;
  let totalSegments = 0;
  if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > MAX_TRACKS) {
    push("tracks", `tracks 必须是 1..${MAX_TRACKS} 项的数组`);
  } else {
    for (let ti = 0; ti < tracks.length; ti++) {
      const tr = tracks[ti];
      const tp = `tracks[${ti}]`;
      if (!tr || typeof tr !== "object" || Array.isArray(tr)) {
        push(tp, "轨道必须是对象");
        continue;
      }
      let wavFrames = null;
      if (typeof tr.wav !== "string" || tr.wav.length === 0) {
        push(`${tp}.wav`, "wav 必须是非空文件名");
      } else {
        const info = wavInfo[tr.wav];
        if (!info) push(`${tp}.wav`, `找不到 WAV 文件 ${tr.wav}`);
        else if (info.error) push(`${tp}.wav`, info.error);
        else if (typeof info.frames !== "number" || info.frames < 1)
          push(`${tp}.wav`, "WAV 帧数非法");
        else if (info.frames > MAX_FRAMES)
          push(`${tp}.wav`, `WAV 帧数 ${info.frames} 超过 ${MAX_FRAMES}`);
        else wavFrames = info.frames;
      }
      const segs = tr.segments;
      if (!Array.isArray(segs)) {
        push(`${tp}.segments`, "segments 必须是数组");
        continue;
      }
      totalSegments += segs.length;
      let prevEnd = -1;
      for (let si = 0; si < segs.length; si++) {
        const s = segs[si];
        const sp = `${tp}.segments[${si}]`;
        if (!s || typeof s !== "object" || Array.isArray(s)) {
          push(sp, "发射段必须是对象");
          prevEnd = -1;
          continue;
        }
        let okStart = isInt(s.start) && s.start >= 0 && s.start <= MAX_FRAMES;
        let okEnd = isInt(s.end) && s.end >= 1 && s.end <= MAX_FRAMES;
        if (!okStart) push(`${sp}.start`, "start 必须是 0..2880000 的整数");
        if (!okEnd) push(`${sp}.end`, "end 必须是 1..2880000 的整数");
        if (okStart && okEnd) {
          if (!(s.start < s.end)) push(`${sp}.end`, "必须满足 start < end");
          if (prevEnd > s.start) push(`${sp}.start`, "同轨各段必须按 start 排序且发射区间不重叠");
          prevEnd = s.end;
        } else {
          prevEnd = -1;
        }
        const okP0 = arr3(s.p0);
        const okP1 = arr3(s.p1);
        if (!okP0) push(`${sp}.p0`, "p0 必须是 3 个整数坐标，绝对值 ≤ 1000000");
        if (!okP1) push(`${sp}.p1`, "p1 必须是 3 个整数坐标，绝对值 ≤ 1000000");
        if (okStart && okEnd && okP0 && okP1 && s.start < s.end) {
          const dur = s.end - s.start;
          const d = norm3(s.p1[0] - s.p0[0], s.p1[1] - s.p0[1], s.p1[2] - s.p0[2]);
          if (d > dur * SRC_SPEED_LIMIT + SPEED_EPS)
            push(`${sp}.p1`, `段速度 ${(d / dur).toFixed(6)} 超过 1/2`);
        }
        if (!isInt(s.offset) || s.offset < 0) {
          push(`${sp}.offset`, "offset 必须是非负整数");
        } else if (okStart && okEnd && wavFrames != null) {
          if (s.offset + (s.end - s.start) > wavFrames)
            push(`${sp}.offset`, `offset+(end-start)=${s.offset + (s.end - s.start)} 超过 WAV 帧数 ${wavFrames}`);
        }
      }
    }
    if (totalSegments > MAX_SEGMENTS)
      push("tracks", `累计发射段 ${totalSegments} 超过上限 ${MAX_SEGMENTS}`);
  }

  return errors;
}

/* 仅校验耳位（用于编辑耳位）。返回 [{path,msg}]。 */
export function validateEars(ears, frames) {
  const errors = [];
  const push = (path, msg) => errors.push({ path, msg });
  if (!isInt(frames) || frames < 1) {
    push("frames", "frames 非法");
    return errors;
  }
  if (!Array.isArray(ears) || ears.length < 2 || ears.length > MAX_EARS) {
    push("ears", `ears 必须是 2..${MAX_EARS} 项的数组`);
    return errors;
  }
  let prevT = -Infinity;
  let prevL = null;
  let prevR = null;
  for (let i = 0; i < ears.length; i++) {
    const e = ears[i];
    const p = `ears[${i}]`;
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      push(p, "耳位点必须是对象");
      prevL = prevR = null;
      continue;
    }
    if (!isInt(e.t)) push(`${p}.t`, "t 必须是整数");
    else {
      if (!(e.t > prevT)) push(`${p}.t`, "t 必须严格递增");
      if (i === 0 && e.t !== 0) push(`${p}.t`, "首项 t 必须为 0");
      if (i === ears.length - 1 && e.t !== frames) push(`${p}.t`, "末项 t 必须等于 frames");
      if (e.t < 0 || e.t > frames) push(`${p}.t`, `t 必须在 0..${frames}`);
    }
    if (!arr3(e.left)) push(`${p}.left`, "left 必须是 3 个整数坐标，绝对值 ≤ 1000000");
    if (!arr3(e.right)) push(`${p}.right`, "right 必须是 3 个整数坐标，绝对值 ≤ 1000000");
    const prevTVal = prevT;
    if (arr3(e.left) && prevL && isInt(e.t) && Number.isFinite(prevTVal)) {
      const dt = e.t - prevTVal;
      const d = norm3(e.left[0] - prevL[0], e.left[1] - prevL[1], e.left[2] - prevL[2]);
      if (dt > 0 && d > dt * EAR_SPEED_LIMIT + SPEED_EPS)
        push(`${p}.left`, `左耳速度 ${(d / dt).toFixed(6)} 超过 1/2`);
    }
    if (arr3(e.right) && prevR && isInt(e.t) && Number.isFinite(prevTVal)) {
      const dt = e.t - prevTVal;
      const d = norm3(e.right[0] - prevR[0], e.right[1] - prevR[1], e.right[2] - prevR[2]);
      if (dt > 0 && d > dt * EAR_SPEED_LIMIT + SPEED_EPS)
        push(`${p}.right`, `右耳速度 ${(d / dt).toFixed(6)} 超过 1/2`);
    }
    if (isInt(e.t)) prevT = e.t;
    if (arr3(e.left)) prevL = e.left;
    if (arr3(e.right)) prevR = e.right;
  }
  return errors;
}

/* ─────────────────────── 几何：耳位插值 ─────────────────────── */

function buildEarKeyframes(ears) {
  const K = ears.length;
  const ts = new Float64Array(K);
  const L = new Float64Array(K * 3);
  const R = new Float64Array(K * 3);
  for (let i = 0; i < K; i++) {
    ts[i] = ears[i].t;
    L[3 * i] = ears[i].left[0];
    L[3 * i + 1] = ears[i].left[1];
    L[3 * i + 2] = ears[i].left[2];
    R[3 * i] = ears[i].right[0];
    R[3 * i + 1] = ears[i].right[1];
    R[3 * i + 2] = ears[i].right[2];
  }
  return { ts, L, R, count: K };
}

function buildEarPos(ear, pts, frames) {
  const K = ear.count;
  const ts = ear.ts;
  const out = new Float64Array(frames * 3);
  let k = 0;
  for (let t = 0; t < frames; t++) {
    while (k + 1 < K && ts[k + 1] <= t) k++;
    const k2 = Math.min(k + 1, K - 1);
    const t0 = ts[k];
    const t1 = ts[k2];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    const a = 3 * k;
    const b = 3 * k2;
    out[3 * t] = pts[a] + (pts[b] - pts[a]) * f;
    out[3 * t + 1] = pts[a + 1] + (pts[b + 1] - pts[a + 1]) * f;
    out[3 * t + 2] = pts[a + 2] + (pts[b + 2] - pts[a + 2]) * f;
  }
  return out;
}

export function earAtFractional(ear, pts, t) {
  const K = ear.count;
  const ts = ear.ts;
  if (t <= ts[0]) return [pts[0], pts[1], pts[2]];
  if (t >= ts[K - 1]) {
    const a = 3 * (K - 1);
    return [pts[a], pts[a + 1], pts[a + 2]];
  }
  let lo = 0;
  let hi = K - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = ts[lo];
  const t1 = ts[hi];
  const f = (t - t0) / (t1 - t0);
  const a = 3 * lo;
  const b = 3 * hi;
  return [
    pts[a] + (pts[b] - pts[a]) * f,
    pts[a + 1] + (pts[b + 1] - pts[a + 1]) * f,
    pts[a + 2] + (pts[b + 2] - pts[a + 2]) * f,
  ];
}

/* ─────────────────────────── 预处理 ─────────────────────────── */

export function prepare(scene, wavMap, { withEarPos = true } = {}) {
  const frames = scene.frames;
  const ear = buildEarKeyframes(scene.ears);
  const earPos = withEarPos
    ? {
        left: buildEarPos(ear, ear.L, frames),
        right: buildEarPos(ear, ear.R, frames),
      }
    : null;

  const tracks = [];
  for (const tr of scene.tracks) {
    const wav = wavMap[tr.wav];
    const segs = tr.segments;
    const n = segs.length;
    const t = {
      wav,
      wavFrames: wav.length,
      count: n,
      segStart: new Float64Array(n),
      segEnd: new Float64Array(n),
      segOffset: new Float64Array(n),
      refEnd: new Float64Array(n),
      p0x: new Float64Array(n),
      p0y: new Float64Array(n),
      p0z: new Float64Array(n),
      velx: new Float64Array(n),
      vely: new Float64Array(n),
      velz: new Float64Array(n),
    };
    for (let i = 0; i < n; i++) {
      const s = segs[i];
      const dur = s.end - s.start;
      t.segStart[i] = s.start;
      t.segEnd[i] = s.end;
      t.segOffset[i] = s.offset;
      t.refEnd[i] = s.offset + dur;
      t.p0x[i] = s.p0[0];
      t.p0y[i] = s.p0[1];
      t.p0z[i] = s.p0[2];
      t.velx[i] = (s.p1[0] - s.p0[0]) / dur;
      t.vely[i] = (s.p1[1] - s.p0[1]) / dur;
      t.velz[i] = (s.p1[2] - s.p0[2]) / dur;
    }
    tracks.push(t);
  }
  return { frames, ear, earPos, tracks };
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

function firstTrue(frames, pred) {
  let lo = 0;
  let hi = frames - 1;
  let ans = frames;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function renderSegSide(tr, si, earArr, acc, frames, energy, count, collect) {
  const p0x = tr.p0x[si];
  const p0y = tr.p0y[si];
  const p0z = tr.p0z[si];
  const vx = tr.velx[si];
  const vy = tr.vely[si];
  const vz = tr.velz[si];
  const start = tr.segStart[si];
  const end = tr.segEnd[si];
  const offset = tr.segOffset[si];
  const refEnd = tr.refEnd[si];
  const wav = tr.wav;

  const distTo = (px, py, pz, t) => {
    const dx = px - earArr[3 * t];
    const dy = py - earArr[3 * t + 1];
    const dz = pz - earArr[3 * t + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  // t0: 首个 A(t) >= start 的整数帧
  const t0 = firstTrue(frames, (t) => t - distTo(p0x, p0y, p0z, t) >= start);
  if (t0 >= frames) return 0;
  // t1: 首个 B(t) >= end 的整数帧；无则延伸到末尾
  const ex = p0x + (end - start) * vx;
  const ey = p0y + (end - start) * vy;
  const ez = p0z + (end - start) * vz;
  let t1 = firstTrue(frames, (t) => t - distTo(ex, ey, ez, t) >= end);
  if (t1 < t0) t1 = t0;
  if (t1 <= t0) return 0;

  let u = start;
  let arrivals = 0;
  for (let t = t0; t < t1; t++) {
    const exx = earArr[3 * t];
    const eyy = earArr[3 * t + 1];
    const ezz = earArr[3 * t + 2];
    let uu = u;
    let lo = start;
    let hi = end;
    for (let it = 0; it < 8; it++) {
      const du = uu - start;
      const px = p0x + du * vx;
      const py = p0y + du * vy;
      const pz = p0z + du * vz;
      const wx = px - exx;
      const wy = py - eyy;
      const wz = pz - ezz;
      const r = Math.sqrt(wx * wx + wy * wy + wz * wz);
      const g = uu + r - t;
      if (g < 0) lo = uu;
      else hi = uu;
      if (Math.abs(g) < NEWTON_TOL) break;
      const gp = r > 1e-9 ? 1 + (wx * vx + wy * vy + wz * vz) / r : 1;
      let nu = uu - g / gp;
      if (!(nu > lo && nu < hi)) nu = (lo + hi) * 0.5;
      uu = nu;
    }
    if (uu < start) uu = start;
    else if (uu >= end) uu = end - 1e-9;
    let d = t - uu;
    if (d < 0) d = 0;
    const q = uu - start + offset;
    const k = Math.floor(q);
    let sval = 0;
    if (k >= 0 && k < refEnd) {
      const v0 = wav[k];
      const v1 = k + 1 < refEnd ? wav[k + 1] : 0;
      sval = v0 + (v1 - v0) * (q - k);
    }
    const contrib = sval * (8 / (8 + d));
    acc[t] += contrib;
    if (energy) energy[t] += Math.abs(contrib);
    if (count) count[t]++;
    u = uu;
    arrivals++;
  }
  return arrivals;
}

export function render(prepared, { progressMs = 0, onProgress = null } = {}) {
  const t0 = now();
  const frames = prepared.frames;
  const earPos = prepared.earPos;
  if (!earPos) throw new Error("render 需要 earPos（prepare 时 withEarPos=true）");
  const accL = new Float64Array(frames);
  const accR = new Float64Array(frames);
  const energyL = new Float32Array(frames);
  const energyR = new Float32Array(frames);
  const countL = new Uint32Array(frames);
  const countR = new Uint32Array(frames);
  let arrivals = 0;
  let lastReport = t0;
  const total = prepared.tracks.length;

  for (let ti = 0; ti < total; ti++) {
    const tr = prepared.tracks[ti];
    for (let si = 0; si < tr.count; si++) {
      arrivals += renderSegSide(tr, si, earPos.left, accL, frames, energyL, countL, null);
      arrivals += renderSegSide(tr, si, earPos.right, accR, frames, energyR, countR, null);
    }
    if (onProgress && progressMs > 0) {
      const n = now();
      if (n - lastReport >= progressMs) {
        lastReport = n;
        onProgress((ti + 1) / total);
      }
    }
  }

  const left = new Int16Array(frames);
  const right = new Int16Array(frames);
  let peakL = 0;
  let peakR = 0;
  let firstNonzero = -1;
  for (let i = 0; i < frames; i++) {
    let v = roundHalfAway(accL[i]);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    left[i] = v;
    if (Math.abs(v) > peakL) peakL = Math.abs(v);
    if (firstNonzero < 0 && v !== 0) firstNonzero = i;
    let w = roundHalfAway(accR[i]);
    if (w > 32767) w = 32767;
    else if (w < -32768) w = -32768;
    right[i] = w;
    if (Math.abs(w) > peakR) peakR = Math.abs(w);
    if (firstNonzero < 0 && w !== 0) firstNonzero = i;
  }

  return {
    left,
    right,
    energyL,
    energyR,
    countL,
    countR,
    stats: {
      frames,
      arrivals,
      peakL,
      peakR,
      firstNonzero,
      elapsedMs: now() - t0,
    },
  };
}

function now() {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

export function roundHalfAway(x) {
  if (x >= 0) return Math.floor(x + 0.5);
  return Math.ceil(x - 0.5);
}

/* ───────────────────── 到达检查（逐帧逐段） ───────────────────── */

export function inspectFrame(prepared, t, side, wavInfo) {
  const { ear } = prepared;
  const pts = side === "left" ? ear.L : ear.R;
  const E = earAtFractional(ear, pts, t);
  const out = [];
  for (let ti = 0; ti < prepared.tracks.length; ti++) {
    const tr = prepared.tracks[ti];
    for (let si = 0; si < tr.count; si++) {
      const start = tr.segStart[si];
      const end = tr.segEnd[si];
      const p0x = tr.p0x[si];
      const p0y = tr.p0y[si];
      const p0z = tr.p0z[si];
      const vx = tr.velx[si];
      const vy = tr.vely[si];
      const vz = tr.velz[si];
      const ex = p0x + (end - start) * vx;
      const ey = p0y + (end - start) * vy;
      const ez = p0z + (end - start) * vz;
      const dStart = Math.hypot(p0x - E[0], p0y - E[1], p0z - E[2]);
      const dEnd = Math.hypot(ex - E[0], ey - E[1], ez - E[2]);
      if (!(t - dStart >= start)) continue;
      if (!(t - dEnd < end)) continue;
      // safeguarded 牛顿
      let u = start;
      let lo = start;
      let hi = end;
      for (let it = 0; it < 60; it++) {
        const du = u - start;
        const px = p0x + du * vx;
        const py = p0y + du * vy;
        const pz = p0z + du * vz;
        const wx = px - E[0];
        const wy = py - E[1];
        const wz = pz - E[2];
        const r = Math.sqrt(wx * wx + wy * wy + wz * wz);
        const g = u + r - t;
        if (g < 0) lo = u;
        else hi = u;
        if (Math.abs(g) < 1e-10) break;
        const gp = r > 1e-12 ? 1 + (wx * vx + wy * vy + wz * vz) / r : 1;
        let nu = u - g / gp;
        if (!(nu > lo && nu < hi)) nu = (lo + hi) * 0.5;
        u = nu;
      }
      if (u < start) u = start;
      if (!(u < end)) continue;
      let d = t - u;
      if (d < 0) d = 0;
      const q = u - start + tr.segOffset[si];
      const refEnd = tr.refEnd[si];
      const k = Math.floor(q);
      let sval = 0;
      if (k >= 0 && k < refEnd) {
        const v0 = tr.wav[k];
        const v1 = k + 1 < refEnd ? tr.wav[k + 1] : 0;
        sval = v0 + (v1 - v0) * (q - k);
      }
      const gain = 8 / (8 + d);
      // 声程核对：发射位置到当前耳位的欧氏距离应等于传播时间 d
      const du = u - start;
      const sx = p0x + du * vx;
      const sy = p0y + du * vy;
      const sz = p0z + du * vz;
      const reach = Math.hypot(sx - E[0], sy - E[1], sz - E[2]);
      out.push({
        track: ti,
        segment: si,
        u,
        d,
        gain,
        q,
        value: sval,
        contrib: sval * gain,
        residual: reach - d,
      });
    }
  }
  return out;
}
