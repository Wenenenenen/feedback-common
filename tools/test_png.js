/* PNG encoder roundtrip: encode -> decode with the independent python decoder,
   verify exact sample values for 8/16-bit gray and RGB. */
"use strict";
const fs = require("fs");
const path = require("path");
const P = require("./png_encoder.js");

const tmp = path.resolve(__dirname, "tmp_enc");
fs.mkdirSync(tmp, { recursive: true });

(async () => {
  let failures = 0;
  const ok = (cond, name) => {
    console.log((cond ? "PASS" : "FAIL") + " " + name);
    if (!cond) failures++;
  };

  // 16-bit grayscale, includes 0, 65535, and quantization-boundary values
  const W = 5, H = 3;
  const vals = [0, 0.5, 1, 1e-9, 2, 65534, 65535, 0.00003, 0.99999, 1.0001, -3, NaN, 0.25, 0.75, 0.1];
  const g16 = Uint16Array.from(vals.map(v => P.quantize16(v)));
  const bytes16 = await P.encodePng(W, H, 1, 16, g16, {
    Software: "masked-rl-deconvolver",
    Quantization: "clip[0,1] then floor(65535*v+0.5)"
  });
  const f16 = path.join(tmp, "gray16.png");
  fs.writeFileSync(f16, bytes16);

  // 8-bit RGB
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    rgb[i * 3] = P.quantize8(vals[i]);
    rgb[i * 3 + 1] = (i * 37) & 255;
    rgb[i * 3 + 2] = P.quantize8((i % 7) / 7);
  }
  const bytes8 = await P.encodePng(W, H, 3, 8, rgb, null);
  const f8 = path.join(tmp, "rgb8.png");
  fs.writeFileSync(f8, bytes8);

  // Stored-zlib path specifically (bypasses CompressionStream)
  const raw = new Uint8Array(70000).fill(7);
  const stored = P.storedZlib(raw);
  const zlib = require("zlib");
  const back = zlib.inflateSync(stored);
  ok(back.length === raw.length && back.every((v, i) => v === raw[i]), "stored zlib roundtrip (multi-block)");

  // CRC / adler sanity against known vectors
  ok(P.adler32(Buffer.from("Wikipedia")) === 0x11e60398, "adler32 known vector");
  ok(P.crc32(Buffer.from("123456789")) === 0xcbf43926, "crc32 known vector");

  // Quantization rule checks
  ok(P.quantize16(0) === 0 && P.quantize16(1) === 65535, "16-bit endpoints");
  ok(P.quantize16(-1) === 0 && P.quantize16(2) === 65535, "16-bit clipping");
  ok(Number.isNaN(NaN) && P.quantize16(NaN) === 0, "16-bit NaN -> 0");
  ok(P.quantize16(0.5) === Math.floor(65535 * 0.5 + 0.5), "16-bit midpoint rule");
  ok(P.quantize8(0.5) === 128, "8-bit midpoint floor(127.5+0.5)=128");

  fs.writeFileSync(path.join(tmp, "expected.json"), JSON.stringify({
    gray16: Array.from(g16), rgb8: Array.from(rgb), W, H
  }));
  console.log(failures === 0 ? "\nENCODER TESTS PASSED (python decode next)" : `\n${failures} FAILURE(S)`);
  process.exit(failures ? 1 : 0);
})();
