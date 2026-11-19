/*
 * Minimal RFC 1951 DEFLATE decompressor (raw deflate, no zlib wrapper),
 * implemented from the spec so PNG IDAT decoding works without
 * DecompressionStream (absent in some embedded/headless browsers).
 * Validated against Node's zlib on the sample fixtures.
 */
(function (root) {
  'use strict';

  // Fixed Huffman tables (RFC 1951 section 3.2.6).
  function buildFixedLitlen() {
    // 0-143: 8-bit 00110000..10111111 ; 144-255: 9-bit 110010000.. ;
    // 256-279: 7-bit 0000000..0010111 ; 280-287: 8-bit 11000000..11000111
    const bits = new Uint8Array(288), codes = new Uint16Array(288);
    for (let i = 0; i <= 143; i++) bits[i] = 8;
    for (let i = 144; i <= 255; i++) bits[i] = 9;
    for (let i = 256; i <= 279; i++) bits[i] = 7;
    for (let i = 280; i <= 287; i++) bits[i] = 8;
    return canonicalCodes(bits, codes);
  }

  // Build canonical Huffman codes from a vector of code lengths.
  function canonicalCodes(lengths, codesOut) {
    const MAXBITS = 15;
    const blCount = new Uint32Array(MAXBITS + 1);
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) blCount[lengths[i]]++;
    const nextCode = new Uint32Array(MAXBITS + 1);
    let code = 0;
    for (let bits = 1; bits <= MAXBITS; bits++) {
      code = (code + blCount[bits - 1]) << 1;
      nextCode[bits] = code;
    }
    const codes = codesOut || new Uint16Array(lengths.length);
    for (let n = 0; n < lengths.length; n++) {
      const len = lengths[n];
      if (len) codes[n] = nextCode[len]++;
    }
    return codes;
  }

  // Reverse the low `len` bits of v.
  function reverse(v, len) {
    let r = 0;
    for (let i = 0; i < len; i++) { r = (r << 1) | (v & 1); v >>= 1; }
    return r;
  }

  // Decode table. The BitReader serves bits LSB-first, while DEFLATE Huffman
  // codes are packed MSB-first. The standard trick is to bit-reverse the
  // canonical codes and then match the LSB-first bit stream directly,
  // accumulating on the right (low bits).
  function makeDecoder(lengths) {
    const codes = canonicalCodes(lengths);
    const byLen = new Map();
    for (let s = 0; s < lengths.length; s++) {
      const L = lengths[s];
      if (!L) continue;
      if (!byLen.has(L)) byLen.set(L, new Map());
      byLen.get(L).set(reverse(codes[s], L), s);
    }
    return function (br) {
      let acc = 0;
      for (let L = 1; L <= 15; L++) {
        // LSB-first stream: the next bit becomes the new high bit of `acc`.
        acc |= br.readBit() << (L - 1);
        const m = byLen.get(L);
        if (m && m.has(acc)) return m.get(acc);
      }
      throw new Error('inflate: invalid Huffman code');
    };
  }

  const FIXED_LITLEN_BITS = (() => {
    const a = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) a[i] = 8;
    for (let i = 144; i <= 255; i++) a[i] = 9;
    for (let i = 256; i <= 279; i++) a[i] = 7;
    for (let i = 280; i <= 287; i++) a[i] = 8;
    return a;
  })();
  const FIXED_DIST_BITS = new Uint8Array(30).fill(5);

  // length/base and distance base+extra tables (RFC 1951 section 3.2.5).
  const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  class BitReader {
    constructor(u8) {
      this.u8 = u8; this.bytePos = 0; this.bitInByte = 0;
    }
    readBit() {
      const v = (this.u8[this.bytePos] >> this.bitInByte) & 1;
      this.bitInByte++;
      if (this.bitInByte === 8) { this.bitInByte = 0; this.bytePos++; }
      return v;
    }
    readBits(n) {
      let v = 0;
      for (let i = 0; i < n; i++) v |= this.readBit() << i;
      return v;
    }
    // Skip to the next byte boundary. Safe to call when already aligned:
    // bitInByte===0 means the reader already points at a fresh byte, so no
    // position is consumed.
    alignByte() {
      if (this.bitInByte > 0) { this.bitInByte = 0; this.bytePos++; }
    }
  }

  function decodeDynamic(br) {
    const hlit = br.readBits(5) + 257;
    const hdist = br.readBits(5) + 1;
    const hclen = br.readBits(4) + 4;
    const clBits = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) clBits[CL_ORDER[i]] = br.readBits(3);
    const clDecode = makeDecoder(clBits);
    const allBits = new Uint8Array(hlit + hdist);
    let i = 0;
    while (i < hlit + hdist) {
      const sym = clDecode(br);
      if (sym < 16) { allBits[i++] = sym; }
      else if (sym === 16) {
        const rep = br.readBits(2) + 3;
        const prev = allBits[i - 1];
        for (let k = 0; k < rep; k++) allBits[i++] = prev;
      } else if (sym === 17) {
        const rep = br.readBits(3) + 3;
        for (let k = 0; k < rep; k++) allBits[i++] = 0;
      } else {
        const rep = br.readBits(7) + 11;
        for (let k = 0; k < rep; k++) allBits[i++] = 0;
      }
    }
    const litBits = allBits.subarray(0, hlit);
    const distBits = allBits.subarray(hlit);
    return {
      lit: makeDecoder(litBits),
      dist: distBits.some(Boolean) ? makeDecoder(distBits) : null,
    };
  }

  // raw: Uint8Array of raw DEFLATE data (zlib header/trailer already stripped).
  function inflateRaw(raw) {
    const br = new BitReader(raw);
    const out = [];
    let last = 0;
    do {
      last = br.readBit();
      const btype = br.readBits(2);
      if (btype === 0) {
        br.alignByte();
        // After alignment bytePos points directly at the LEN field.
        const len = br.u8[br.bytePos] | (br.u8[br.bytePos + 1] << 8);
        br.bytePos += 4; // skip LEN (2) + NLEN (2)
        for (let k = 0; k < len; k++) out.push(br.u8[br.bytePos++]);
      } else {
        let lit, dist;
        if (btype === 1) {
          lit = makeDecoder(FIXED_LITLEN_BITS);
          dist = makeDecoder(FIXED_DIST_BITS);
        } else if (btype === 2) {
          const d = decodeDynamic(br);
          lit = d.lit; dist = d.dist;
        } else {
          throw new Error('inflate: reserved block type 3');
        }
        while (true) {
          const sym = lit(br);
          if (sym === 256) break;
          if (sym < 256) {
            out.push(sym);
          } else {
            const li = sym - 257;
            const length = LEN_BASE[li] + br.readBits(LEN_EXTRA[li]);
            const dsym = dist(br);
            const distance = DIST_BASE[dsym] + br.readBits(DIST_EXTRA[dsym]);
            const start = out.length - distance;
            for (let k = 0; k < length; k++) out.push(out[start + k]);
          }
        }
      }
    } while (!last);
    return new Uint8Array(out);
  }

  // Full zlib stream: skip 2-byte header, inflate raw, ignore adler32 trailer.
  function inflateZlib(u8) {
    if (u8.length < 6 || (u8[0] & 0x0F) !== 8) throw new Error('zlib: unsupported CM');
    const fdict = u8[1] & 0x20;
    let off = 2 + (fdict ? 4 : 0);
    return inflateRaw(u8.subarray(off, u8.length - 4));
  }

  const BINFLATE = { inflateRaw, inflateZlib, canonicalCodes, reverse, makeDecoder };
  root.BINFLATE = BINFLATE;
  if (typeof module !== 'undefined' && module.exports) module.exports = BINFLATE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
