// Node-side numerical smoke tests for the exact same ESM modules the page uses.
// Run: node --input-type=module - < tools/test/node-smoke.mjs <data_dir> [tol]
// (kept generic; invoked by tools/run_tests.sh)
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import zlib from "node:zlib";
import { parsePnm } from "../src/pnm.js";
import {
  solveImage, inspectPixel, channelInterval, composite,
  STATUS_FEASIBLE, STATUS_NO_SOLUTION, STATUS_UNMEASURED,
} from "../src/solver.js";
import { encodeRgbaPng, encodeStatusPng } from "../src/png.js";
import { recomposite } from "../src/recomposite.js";

function readAb(path) {
  const buf = readFileSync(path);
  // Node Buffers may alias a shared pool; copy into an exact-size ArrayBuffer.
  return Uint8Array.prototype.slice.call(buf, 0, buf.length).buffer;
}

function load(dataDir) {
  const spec = JSON.parse(readFileSync(join(dataDir, "groups.json"), "utf8"));
  const groups = [];
  let width = 0, height = 0;
  for (const g of spec.groups) {
    const bg = parsePnm(readAb(join(dataDir, g.background)));
    const ob = parsePnm(readAb(join(dataDir, g.observed)));
    if (bg.channels !== 3 || ob.channels !== 3) throw new Error("bg/obs must be P6");
    if (width === 0) { width = bg.width; height = bg.height; }
    if (bg.width !== width || bg.height !== height || ob.width !== width || ob.height !== height) {
      throw new Error("尺寸不一致");
    }
    let mask = null;
    if (g.valid) {
      const m = parsePnm(readAb(join(dataDir, g.valid)));
      if (m.channels !== 1 || m.width !== width || m.height !== height) throw new Error("掩膜尺寸/格式错误");
      mask = m.data;
    }
    groups.push({ bg: bg.data, obs: ob.data, mask, enabled: true });
  }
  return { width, height, groups };
}

function bruteInterval(a, b, o, t) {
  const vals = [];
  for (let f = 0; f <= 255; f++) {
    if (Math.abs(composite(a, f, b) - o) <= t) vals.push(f);
  }
  return vals.length ? [vals[0], vals[vals.length - 1]] : null;
}

// minimal PNG decode for verification: signature + IHDR + IDATs
function decodePng(bytes) {
  if (bytes[0] !== 137 || bytes[1] !== 80) throw new Error("bad png signature");
  let pos = 8, width = 0, height = 0, colorType = 0, idat = [];
  while (pos < bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0); height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error("bitdepth must be 8");
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const channels = colorType === 6 ? 4 : 1;
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error("test decoder expects filter 0, got " + filter);
    out.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return { width, height, colorType, data: out };
}

async function main() {
  const dataDir = process.argv[2];
  const tol = Number(process.argv[3] ?? 0);
  const { width, height, groups } = load(dataDir);
  const n = width * height;
  let failures = 0;
  const check = (cond, msg) => { if (!cond) { failures++; console.error("FAIL:", msg); } };

  // 1. interval vs brute force on every (A, group, channel) of every pixel
  //    (exhaustive brute force only on small images; larger ones rely on the
  //    small-image proof plus the per-pixel tolerance check below)
  let ivChecks = 0;
  const doBrute = n <= 256;
  if (doBrute) {
    for (let p = 0; p < n; p++) {
      for (const g of groups) {
        if (g.mask && g.mask[p] === 0) continue;
        for (let c = 0; c < 3; c++) {
          for (let a = 0; a <= 255; a++) {
            const got = channelInterval(a, g.bg[3 * p + c], g.obs[3 * p + c], tol);
            const want = bruteInterval(a, g.bg[3 * p + c], g.obs[3 * p + c], tol);
            ivChecks++;
            check(JSON.stringify(got) === JSON.stringify(want),
              `interval mismatch p=${p} a=${a} c=${c} got=${got} want=${want}`);
          }
        }
      }
    }
  }

  // 2. full solve: tolerances and delivered tie-break
  const res = solveImage(width, height, groups, tol);
  let worst = 0;
  for (let p = 0; p < n; p++) {
    if (res.status[p] !== STATUS_FEASIBLE) continue;
    const a = res.rgba[4 * p + 3];
    for (const g of groups) {
      if (g.mask && g.mask[p] === 0) continue;
      for (let c = 0; c < 3; c++) {
        const pred = composite(a, res.rgba[4 * p + c], g.bg[3 * p + c]);
        const err = pred - g.obs[3 * p + c];
        worst = Math.max(worst, Math.abs(err));
        check(Math.abs(err) <= tol, `tol violated p=${p} err=${err}`);
      }
    }
  }
  check(worst <= tol, `worst err ${worst} > tol ${tol}`);

  // 3. unmeasured / no-solution pixels must be transparent black; status codes valid
  for (let p = 0; p < n; p++) {
    if (res.status[p] === STATUS_UNMEASURED || res.status[p] === STATUS_NO_SOLUTION) {
      for (let k = 0; k < 4; k++) check(res.rgba[4 * p + k] === 0, `special pixel not transparent black p=${p}`);
    }
    check(res.status[p] <= 2, `bad status p=${p}`);
  }

  // 4. inspector: feasible list ordered ascending A, solution = smallest A / smallest F
  for (const p of [0, n - 1]) {
    const x = p % width, y = (p / width) | 0;
    const info = inspectPixel(width, groups, tol, x, y);
    for (let i = 1; i < info.feasible.length; i++) {
      check(info.feasible[i].a > info.feasible[i - 1].a, "feasible A not ascending");
    }
    if (info.status === STATUS_FEASIBLE) {
      check(info.feasible.length >= 1, "feasible but empty list");
      const first = info.feasible[0];
      check(info.solution[0] === first.a && info.solution[1] === first.lo[0] &&
        info.solution[2] === first.lo[1] && info.solution[3] === first.lo[2],
        "solution tie-break mismatch");
      check(Math.abs(info.feasible.length - res.feasibleCount[p]) === 0, "feasible count mismatch");
      // every group used must have prediction errors within tol
      for (let gi = 0; gi < info.perGroup.length; gi++) {
        if (!info.perGroup[gi].used) continue;
        for (let c = 0; c < 3; c++) {
          check(Math.abs(info.predictions[gi].err[c]) <= tol, "inspector error outside tol");
        }
      }
    }
  }

  // 5. RGBA PNG round trip preserves exact delivered bytes
  const png = await encodeRgbaPng(width, height, res.rgba);
  const dec = decodePng(png);
  check(dec.width === width && dec.height === height && dec.colorType === 6, "rgba png header");
  check(dec.data.length === res.rgba.length, "rgba png length");
  let byteMismatch = 0;
  for (let i = 0; i < dec.data.length; i++) if (dec.data[i] !== res.rgba[i]) byteMismatch++;
  check(byteMismatch === 0, `rgba png byte mismatch x${byteMismatch}`);

  // 6. status PNG: gray code values equal status
  const spng = await encodeStatusPng(width, height, res.status);
  const sdec = decodePng(spng);
  check(sdec.colorType === 0 && sdec.width === width, "status png header");
  let sMismatch = 0;
  for (let i = 0; i < n; i++) if (sdec.data[i] !== res.status[i]) sMismatch++;
  check(sMismatch === 0, `status png mismatch x${sMismatch}`);

  // 7. recomposite over uniform color uses same integer formula
  const recomp = recomposite(width, height, res.rgba, { r: 12, g: 200, b: 77 });
  for (let p = 0; p < n; p++) {
    const a = res.rgba[4 * p + 3];
    for (let c = 0; c < 3; c++) {
      const b = [12, 200, 77][c];
      check(recomp[4 * p + c] === composite(a, res.rgba[4 * p + c], b), "recomposite formula mismatch");
    }
    check(recomp[4 * p + 3] === 255, "recomposite alpha must be opaque");
  }

  // 8. cross-implementation parity with the Python reference dump (if provided)
  const refPath = process.argv[4];
  let refChecks = 0;
  if (refPath) {
    const ref = JSON.parse(readFileSync(refPath, "utf8"));
    check(ref.w === width && ref.h === height && ref.tol === tol, "ref dump header mismatch");
    for (let p = 0; p < n; p++) {
      const want = ref.pixels[p];
      check(res.status[p] === want.s, `ref status mismatch p=${p} got=${res.status[p]} want=${want.s}`);
      if (want.sol) {
        const got = [res.rgba[4 * p + 3], res.rgba[4 * p], res.rgba[4 * p + 1], res.rgba[4 * p + 2]];
        check(got.join(",") === want.sol.join(","), `ref solution mismatch p=${p} got=${got} want=${want.sol}`);
      } else {
        check(res.rgba[4 * p + 3] === 0, `ref expects no solution but got alpha p=${p}`);
      }
      check(res.feasibleCount[p] === want.nA, `ref feasible-count mismatch p=${p}`);
      refChecks++;
    }
  }

  console.log(JSON.stringify({
    dir: basename(dataDir), size: `${width}x${height}`, groups: groups.length, tol,
    intervalChecks: ivChecks,
    bruteForce: doBrute,
    refChecks,
    counts: res.counts,
    worstError: worst,
    pngBytes: png.length,
    statusPngBytes: spng.length,
    failures,
  }, null, 2));
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
