// Re-composite the delivered straight RGBA over a chosen backdrop.
// Uses the exact package integer formula. Non-feasible/unmeasured pixels keep
// transparent-black bytes; the caller decides whether to show the checkerboard.

import { composite } from "./solver.js";

// backdrop: Uint8Array(3n) or uniform {r,g,b}
export function recomposite(width, height, rgba, backdrop) {
  const n = width * height;
  const out = new Uint8Array(4 * n);
  const uniform = !(backdrop instanceof Uint8Array);
  for (let p = 0; p < n; p++) {
    const a = rgba[4 * p + 3];
    for (let c = 0; c < 3; c++) {
      const b = uniform ? backdrop[["r", "g", "b"][c]] : backdrop[3 * p + c];
      out[4 * p + c] = composite(a, rgba[4 * p + c], b);
    }
    out[4 * p + 3] = 255;
  }
  return out;
}
