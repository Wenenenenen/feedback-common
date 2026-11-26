// P5/P6 (8-bit, maxval 255) parser. Pure ESM, no DOM, no Node APIs.
// Inputs are untrusted: every field is validated, no typed-array view of
// unvalidated bytes is handed out before the length check passes.

export class PnmError extends Error {}

function parseHeader(view) {
  const dec = new TextDecoder("ascii");
  let pos = 0;
  const len = view.byteLength;

  function isWs(ch) {
    return ch === 32 || ch === 9 || ch === 10 || ch === 13;
  }

  // Skip any run of whitespace and '#' comments (comment runs to end of line).
  function skipSep() {
    while (pos < len) {
      const ch = view.getUint8(pos);
      if (ch === 35) {
        while (pos < len && view.getUint8(pos) !== 10 && view.getUint8(pos) !== 13) pos++;
      } else if (isWs(ch)) {
        pos++;
      } else {
        break;
      }
    }
  }

  function readToken() {
    skipSep();
    const start = pos;
    while (pos < len && !isWs(view.getUint8(pos))) pos++;
    if (pos === start) throw new PnmError("文件头意外结束");
    return dec.decode(new Uint8Array(view.buffer, view.byteOffset + start, pos - start));
  }

  const magic = readToken();
  if (magic !== "P5" && magic !== "P6") throw new PnmError("只支持 P5/P6 格式，收到 " + magic);
  const width = Number(readToken());
  const height = Number(readToken());
  const maxval = Number(readToken());
  // readToken stopped on the single whitespace separating header from raster;
  // netpbm: raster begins immediately after that one whitespace byte.
  const rasterStart = pos + 1;
  return { magic, width, height, maxval, rasterStart };
}

export function parsePnm(buffer) {
  if (!(buffer instanceof ArrayBuffer)) throw new PnmError("需要 ArrayBuffer 输入");
  let view;
  try {
    view = new DataView(buffer);
  } catch (e) {
    throw new PnmError("无法读取文件字节");
  }
  const { magic, width, height, maxval, rasterStart } = parseHeader(view);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PnmError("宽高必须为正整数");
  }
  if (width > 384 || height > 384) throw new PnmError("每边最大 384，收到 " + width + "x" + height);
  if (maxval !== 255) throw new PnmError("只支持 8 位（maxval=255），收到 maxval=" + maxval);
  const channels = magic === "P6" ? 3 : 1;
  const need = width * height * channels;
  const available = buffer.byteLength - rasterStart;
  if (available < need) throw new PnmError("栅格数据不完整：需要 " + need + " 字节，实际 " + available);
  const data = new Uint8Array(buffer, rasterStart, need);
  return { magic, width, height, channels, data };
}
