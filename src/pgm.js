// Minimal binary P5 PGM parser (Netpbm).
// Supports 8-bit and big-endian 16-bit samples per the spec, comments and
// arbitrary whitespace in the header. Dimensions are capped at 1024 per side.

export class PgmError extends Error {}

function readToken(buf, pos) {
  // Whitespace per Netpbm: space, tab, CR, LF; comments start with '#'.
  while (pos.i < buf.length) {
    const c = buf[pos.i];
    if (c === 0x23) {
      while (pos.i < buf.length && buf[pos.i] !== 0x0a && buf[pos.i] !== 0x0d) pos.i++;
      continue;
    }
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) { pos.i++; continue; }
    break;
  }
  const start = pos.i;
  while (pos.i < buf.length) {
    const c = buf[pos.i];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x23) break;
    pos.i++;
  }
  if (start === pos.i) throw new PgmError('PGM: malformed header');
  return new TextDecoder('ascii').decode(buf.subarray(start, pos.i));
}

export function parsePgm(buf) {
  const pos = { i: 0 };
  const magic = readToken(buf, pos);
  if (magic !== 'P5') throw new PgmError(`PGM: unsupported magic "${magic}", only binary P5 is accepted`);
  const width = parseInt(readToken(buf, pos), 10);
  const height = parseInt(readToken(buf, pos), 10);
  const maxval = parseInt(readToken(buf, pos), 10);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PgmError('PGM: invalid dimensions');
  }
  if (width > 1024 || height > 1024) throw new PgmError('PGM: dimensions exceed 1024 per side');
  if (!Number.isInteger(maxval) || maxval < 1 || maxval > 65535) throw new PgmError('PGM: invalid maxval');
  // Exactly one whitespace character separates the header from the raster (Netpbm).
  if (pos.i >= buf.length) throw new PgmError('PGM: missing raster');
  const sep = buf[pos.i++];
  if (sep !== 0x20 && sep !== 0x09 && sep !== 0x0a && sep !== 0x0d) {
    throw new PgmError('PGM: malformed raster separator');
  }
  const bytesPerSample = maxval < 256 ? 1 : 2;
  const expected = width * height * bytesPerSample;
  if (buf.length - pos.i < expected) throw new PgmError('PGM: raster shorter than declared dimensions');
  const gray = new Uint16Array(width * height);
  let p = pos.i;
  if (bytesPerSample === 1) {
    for (let i = 0; i < gray.length; i++, p++) gray[i] = buf[p];
  } else {
    // Big-endian 16-bit, per the sample format note.
    for (let i = 0; i < gray.length; i++, p += 2) gray[i] = (buf[p] << 8) | buf[p + 1];
  }
  return { width, height, maxval, gray };
}
