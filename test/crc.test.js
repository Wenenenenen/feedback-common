import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32Mpeg } from "../src/crc32.js";

// Known vector: CRC-32/MPEG-2 of "123456789" = 0x0376E6E7
test("CRC-32/MPEG-2 check value", () => {
  assert.equal(crc32Mpeg(new TextEncoder().encode("123456789")), 0x0376e6e7);
});

test("CRC empty input is the init value", () => {
  assert.equal(crc32Mpeg(new Uint8Array(0)), 0xffffffff);
});

test("CRC matches manual byte loop", () => {
  const data = new Uint8Array([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00]);
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b << 24;
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  assert.equal(crc32Mpeg(data), crc >>> 0);
});
