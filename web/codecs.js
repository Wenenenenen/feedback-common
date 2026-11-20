// Browser-side image codecs with no external libraries.
// Decoding uses the platform's built-in PNG decoder via ImageData;
// encoding emits 8-bit grayscale PNGs (for valid masks) using CompressionStream.

export async function decodeGrayPNG(fileOrBlob) {
  const bitmap = await createImageBitmap(fileOrBlob);
  const { width, height } = bitmap;
  if (width > 256 || height > 256) {
    bitmap.close();
    throw new Error(`图像边长 ${Math.max(width, height)} 超过 256 上限`);
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    // Rec.601 luma; the samples are 8-bit grayscale so channels already match.
    gray[j] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  }
  return { width, height, data: gray };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = new TextEncoder().encode(type);
  const len = new ArrayBuffer(4), lv = new DataView(len);
  lv.setUint32(0, data.length);
  const crc = new ArrayBuffer(4), cv = new DataView(crc);
  const body = new Uint8Array(typeBuf.length + data.length);
  body.set(typeBuf, 0); body.set(data, typeBuf.length);
  cv.setUint32(0, crc32(body));
  return new Blob([len, body, crc]);
}

// Encode an 8-bit grayscale PNG. data: Uint8Array of width*height bytes.
export async function encodeGrayPNG(width, height, data) {
  const ihdr = new ArrayBuffer(13), v = new DataView(ihdr);
  v.setUint32(0, width); v.setUint32(4, height);
  v.setUint8(8, 8);  // bit depth
  v.setUint8(9, 0);  // color type 0 = grayscale
  // 10,11,12 stay 0 (compression/filter/interlace defaults)

  const stride = width;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none) per scanline
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const cs = new CompressionStream('deflate');
  const compressed = await new Response(
    new Blob([raw]).stream().pipeThrough(cs)
  ).arrayBuffer();

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Blob([
    sig,
    chunk('IHDR', new Uint8Array(ihdr)),
    chunk('IDAT', new Uint8Array(compressed)),
    chunk('IEND', new Uint8Array(0)),
  ], { type: 'image/png' });
}

// ---------------------------------------------------------------------------
// Minimal store-only ZIP writer (no compression, correct CRC32 + sizes).
// ---------------------------------------------------------------------------

function zipCrc(data) { return crc32(data); }

export async function buildZip(files /* [{name, blob|Uint8Array}] */) {
  const enc = new TextEncoder();
  const localParts = [];
  const central = [];
  let offset = 0;
  const dosTime = 0, dosDate = 0x21; // 1980-01-01, deterministic

  for (const f of files) {
    const bytes = f.data instanceof Uint8Array ? f.data
      : new Uint8Array(await f.data.arrayBuffer());
    const nameBytes = enc.encode(f.name);
    const crc = zipCrc(bytes);

    const local = new ArrayBuffer(30), lv = new DataView(local);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, bytes.length, true);
    lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localParts.push(new Blob([local, nameBytes, bytes]));

    const cen = new ArrayBuffer(46), cv = new DataView(cen);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.push(new Blob([cen, nameBytes]));

    offset += 30 + nameBytes.length + bytes.length;
  }

  const centralBlob = new Blob(central);
  const centralSize = centralBlob.size;
  const end = new ArrayBuffer(22), ev = new DataView(end);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...localParts, centralBlob, end], { type: 'application/zip' });
}

// flow.raw: interleaved u,v float32 little-endian per pixel; invalid -> 0.
export function flowToRaw(u, v, valid, W, H) {
  const buf = new ArrayBuffer(W * H * 2 * 4);
  const dv = new DataView(buf);
  let k = 0;
  for (let i = 0; i < W * H; i++) {
    if (valid[i]) { dv.setFloat32(k, u[i], true); dv.setFloat32(k + 4, v[i], true); }
    else { dv.setFloat32(k, 0, true); dv.setFloat32(k + 4, 0, true); }
    k += 8;
  }
  return new Uint8Array(buf);
}

export function validToPngBytes(valid, W, H) {
  const out = new Uint8Array(W * H);
  for (let i = 0; i < valid.length; i++) out[i] = valid[i] ? 255 : 0;
  return out;
}
