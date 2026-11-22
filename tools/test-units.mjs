// Focused unit tests for RLE variants, crop clipping and BT.709 conversion.
// Run: node tools/test-units.mjs
import { decodeRLE, ycbcrToRgba, renderState } from "../js/pgs.js";

let failures = 0;
const assert = (cond, msg) => { if (!cond) { failures++; console.log("  ✗", msg); } else console.log("  ✓", msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log("=== RLE ===");
// literal palette indices
eq(decodeRLE(new Uint8Array([1, 2, 3])).pixels, [1, 2, 3], "literal indices");
// 00 NN -> N zero runs
eq(decodeRLE(new Uint8Array([0, 3])).pixels, [0, 0, 0], "8-bit zero run");
// 00 02 LL HH -> long run (little-endian length)
eq(decodeRLE(new Uint8Array([0, 2, 4, 0])).pixels, [0, 0, 0, 0], "16-bit zero run");
// EOL splits rows
eq(decodeRLE(new Uint8Array([1, 0, 0, 2])).rows, [[1], [2]], "EOL splits rows");
// standard EOB terminates and trailing data is tolerated
const withEOB = decodeRLE(new Uint8Array([1, 0, 1, 9, 9]));
eq(withEOB.pixels, [1], "EOB terminates stream");
assert(withEOB.sawEOB, "EOB flag set");
// implicit end (subset style, no EOB) still yields the pixels
eq(decodeRLE(new Uint8Array([2, 2])).pixels, [2, 2], "implicit end without EOB");

console.log("=== BT.709 limited range ===");
// black Y=16, neutral chroma, full alpha -> (0,0,0,255)
eq(ycbcrToRgba(16, 128, 128, 255), [0, 0, 0, 255], "limited black");
// white Y=235 neutral -> (255,255,255,255)
eq(ycbcrToRgba(235, 128, 128, 255), [255, 255, 255, 255], "limited white");
// transparent black clear colour
eq(ycbcrToRgba(16, 128, 128, 0), [0, 0, 0, 0], "transparent black");

console.log("=== compositor source-over + crop ===");
const canvas = { width: 8, height: 4 };
const state = {
  paletteSnapshot: new Map([
    [0, { rgba: [0, 0, 0, 0] }],
    [1, { rgba: [255, 0, 0, 255] }],
    [2, { rgba: [0, 0, 255, 128] }],
  ]),
  windows: [],
  entries: [
    { objectId: 1, forced: false, stale: false, missing: false, x: 1, y: 1, crop: { x: 0, y: 0, w: 2, h: 1 },
      object: { width: 4, height: 2, rows: [[1, 1, 1, 1], [0, 0, 0, 0]] } },
    { objectId: 2, forced: true, stale: false, missing: false, x: 2, y: 1, crop: null,
      object: { width: 2, height: 1, rows: [[2, 2]] } },
  ],
};
const r = renderState(state, canvas);
// first object paints two red opaque pixels at (1,1),(2,1)
assert(r.rgba[(1 * 8 + 1) * 4] === 255 && r.rgba[(1 * 8 + 1) * 4 + 3] === 255, "red pixel placed");
// (2,1) is red then half-alpha blue source-over: blended, owner should be entry 1
const off = (1 * 8 + 2) * 4;
assert(r.rgba[off + 2] > 0 && r.rgba[off] > 0, "source-over blend mixes red+blue");
assert(r.owner[1 * 8 + 2] === 1, "owner array records topmost contributing entry");
assert(r.owner[0] === -1, "untouched pixel has no owner");
// canvas clipping: object placed partly off-canvas
const clipped = renderState({
  paletteSnapshot: state.paletteSnapshot, windows: [],
  entries: [{ objectId: 3, forced: false, stale: false, missing: false, x: 7, y: 3, crop: null,
    object: { width: 4, height: 2, rows: [[1, 1, 1, 1], [1, 1, 1, 1]] } }],
}, canvas);
assert(clipped.paintedEntries[0].placed.w === 1 && clipped.paintedEntries[0].placed.h === 1, "canvas clips to one pixel");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL UNIT CHECKS PASSED");
process.exit(failures ? 1 : 0);
