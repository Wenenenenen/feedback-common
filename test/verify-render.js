#!/usr/bin/env node
/* 渲染采样核对：用 mini 案例直接核对根页/页的最近邻颜色，并验证 tiles 渲染确定性。
 * 用法: node test/verify-render.js <样例目录>
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const sim = require(path.join(__dirname, "..", "sim.js"));

const dir = process.argv[2];
if (!dir) { console.error("用法: node test/verify-render.js <样例目录>"); process.exit(2); }

/* 解码 8 位 RGBA PNG（过滤类型 0–4） */
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error("仅支持 8 位 RGBA");
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, data: out };
}

/* 与 index.html 相同的逐像素采样逻辑 */
function renderFrame(def, pixels, snap) {
  const { width: W, height: H, tileSize: T } = def;
  const out = Buffer.alloc(W * H * 4);
  const [u0, v0, du, dv] = snap.window;
  const l = snap.idealLevel, n = 1 << l;
  for (let py = 0; py < H; py++) {
    const v = v0 + ((py + 0.5) / H) * dv;
    const y = Math.min(n - 1, Math.floor(v * n));
    for (let px = 0; px < W; px++) {
      const u = u0 + ((px + 0.5) / W) * du;
      const x = Math.min(n - 1, Math.floor(u * n));
      const actual = snap.samples[`${l}/${x}/${y}`];
      const [al, ax, ay] = actual.split("/").map(Number);
      const an = 1 << al;
      const tx = Math.min(T - 1, Math.floor((u * an - ax) * T));
      const ty = Math.min(T - 1, Math.floor((v * an - ay) * T));
      const src = pixels[actual], si = (ty * T + tx) * 4, di = (py * W + px) * 4;
      src.copy(out, di, si, si + 4);
    }
  }
  return out;
}

function loadCasePixels(def, caseDir) {
  const pixels = {};
  for (const p of def.pages) {
    const png = decodePng(fs.readFileSync(path.join(caseDir, p.path)));
    pixels[p.id] = png.data;
  }
  return pixels;
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  " + detail}`);
  if (!ok) failures++;
};

const mini = JSON.parse(fs.readFileSync(path.join(dir, "mini.json"), "utf8"));
const tiles = JSON.parse(fs.readFileSync(path.join(dir, "tiles.json"), "utf8"));
const miniPx = loadCasePixels(mini, dir);
const tilesPx = loadCasePixels(tiles, dir);
const run = sim.simulate(mini, mini.frames, mini.capacity, mini.maxInflight);

// 帧 0：1/0/0 未驻留，整幅应回退到根页采样（根覆盖全图，局部坐标 = 全局坐标）
{
  const img = renderFrame(mini, miniPx, run.frames[0]);
  const T = mini.tileSize;
  let ok = true;
  for (let py = 0; py < 16 && ok; py++) for (let px = 0; px < 16 && ok; px++) {
    // 窗口 [0,0,.5,.5]，输出像素中心映射到单位正方形 [0,.5)²，根页局部纹素 = floor(u*16)
    const u = (px + 0.5) / 16 * 0.5, v = (py + 0.5) / 16 * 0.5;
    const tx = Math.floor(u * 16), ty = Math.floor(v * 16);
    for (let c = 0; c < 4; c++) {
      if (img[(py * 16 + px) * 4 + c] !== miniPx["0/0/0"][(ty * T + tx) * 4 + c]) { ok = false; break; }
    }
  }
  check("mini 帧0 整幅回退根页，最近邻颜色逐像素一致", ok, "");
}

// 帧 2：1/1/0 已驻留，窗口 [0.5,0,.5,.5] 应直接采样该页
{
  const img = renderFrame(mini, miniPx, run.frames[2]);
  const T = mini.tileSize;
  let ok = true;
  for (let py = 0; py < 16 && ok; py++) for (let px = 0; px < 16 && ok; px++) {
    const u = 0.5 + (px + 0.5) / 16 * 0.5, v = (py + 0.5) / 16 * 0.5;
    const tx = Math.floor((u * 2 - 1) * 16), ty = Math.floor(v * 2 % 1 * 16);
    for (let c = 0; c < 4; c++) {
      if (img[(py * 16 + px) * 4 + c] !== miniPx["1/1/0"][(ty * T + tx) * 4 + c]) { ok = false; break; }
    }
  }
  check("mini 帧2 直接采样 1/1/0，最近邻颜色逐像素一致", ok, "");
}

// tiles：渲染确定性 + 根页回退区域非空（快速移动时应有回退帧）
{
  const trun = sim.simulate(tiles, tiles.frames, tiles.capacity, tiles.maxInflight);
  const a = renderFrame(tiles, tilesPx, trun.frames[3]);
  const b = renderFrame(tiles, tilesPx, trun.frames[3]);
  const hasFallback = trun.frames.some((f) => f.ideal.some((id) => f.samples[id] !== id));
  check("tiles 同帧两次渲染逐字节一致", a.equals(b), "");
  check("tiles 轨迹中存在祖先回退帧（快速移动场景）", hasFallback, "");
}

process.exit(failures ? 1 : 0);
