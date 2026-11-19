// Node test for the hand-rolled PNG encoder and sRGB transfer.
import { encodePng, linearToSrgbByte, buildPixelJson, colorBufferToRgba } from "../src/exporters.js";
import { writeFileSync } from "node:fs";

// 2x2 pattern: black, linear-white, mid-gray linear 0.5, red linear 1.
const w = 2, h = 2;
const rgba = new Uint8Array(w * h * 4);
const lin = [
  [0, 0, 0],
  [1, 1, 1],
  [0.5, 0.5, 0.5],
  [1, 0, 0],
];
for (let i = 0; i < 4; i++) {
  rgba[i * 4] = linearToSrgbByte(lin[i][0]);
  rgba[i * 4 + 1] = linearToSrgbByte(lin[i][1]);
  rgba[i * 4 + 2] = linearToSrgbByte(lin[i][2]);
  rgba[i * 4 + 3] = 255;
}
const png = encodePng(w, h, rgba);
writeFileSync("/tmp/encoder_test.png", png);

// Known sRGB bytes: 0.5 -> ~188, 1.0 -> 255, 0 -> 0.
console.log("bytes:", Array.from(rgba));
console.log("expected mid gray byte ~188:", linearToSrgbByte(0.5));

// Exercise the JSON builder with a fake engine-shaped result.
const fake = {
  width: 1, height: 2,
  faceBuffer: new Int32Array([-1, 7]),
  depthBuffer: new Float64Array([Infinity, 0.25]),
  rgb: [new Float64Array([0, 0.9]), new Float64Array([0, 0.1]), new Float64Array([0, 0.2])],
  coverage: new Uint32Array([0, 3]),
};
console.log(JSON.stringify(buildPixelJson(fake)));
