// Negative-path tests: malformed inputs must be rejected with clear errors.
import { File } from "node:buffer";
import { parseFile } from "../public/mp4/parse.js";
import { buildCaseA, buildBroken } from "./synth.mjs";

let failures = 0;
function check(throws, re, msg) {
  const ok = throws && re.test(String(throws));
  if (ok) console.log("  ok -", msg);
  else { failures++; console.error("  FAIL -", msg, "got:", throws && throws.message); }
}

async function parse(bytes) {
  try {
    await parseFile(new File([bytes], "x.mp4"));
    return null;
  } catch (e) {
    return e;
  }
}

// Flip arbitrary bytes at a fourcc-relative location.
function patch(bytes, type, delta, writer) {
  const key = new TextEncoder().encode(type);
  for (let i = 0; i <= bytes.length - 4; i++) {
    if (bytes[i] === key[0] && bytes[i + 1] === key[1] &&
        bytes[i + 2] === key[2] && bytes[i + 3] === key[3]) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset);
      writer(dv, i + delta);
      return;
    }
  }
  throw new Error("fourcc not found " + type);
}

// Patch the 24-bit flags of the first (or nth) full box of a given type.
function patchFlags(bytes, type, mutate, occurrence = 0) {
  const key = new TextEncoder().encode(type);
  let seen = 0;
  for (let i = 0; i <= bytes.length - 4; i++) {
    if (bytes[i] === key[0] && bytes[i + 1] === key[1] &&
        bytes[i + 2] === key[2] && bytes[i + 3] === key[3]) {
      if (seen++ !== occurrence) continue;
      const dv = new DataView(bytes.buffer, bytes.byteOffset);
      // layout at i: fourcc(4) version(1) flags(3)
      const cur = (bytes[i + 4] << 24) | (bytes[i + 5] << 16) |
        (bytes[i + 6] << 8) | bytes[i + 7];
      const next = mutate(cur >>> 0) & 0xffffff;
      bytes[i + 5] = (next >>> 16) & 0xff;
      bytes[i + 6] = (next >>> 8) & 0xff;
      bytes[i + 7] = next & 0xff;
      return;
    }
  }
  throw new Error("fourcc not found " + type);
}

async function main() {
  const a = await buildCaseA();
  const base = a.bytes;

  console.log("== trun first-sample-flags vs per-sample-flags mutual exclusion ==");
  const b1 = new Uint8Array(base);
  patchFlags(b1, "trun", (f) => f | 0x400);
  check(await parse(b1), /互斥/, "同时出现两种 trun flags 字段被拒绝");

  console.log("== tfhd base mode must be exactly one ==");
  const b2 = new Uint8Array(base);
  patchFlags(b2, "tfhd", (f) => f | 0x020000); // video tfhd uses explicit base
  check(await parse(b2), /二选一/, "两种基址同时存在被拒绝");
  const b3 = new Uint8Array(base);
  patchFlags(b3, "tfhd", () => 0);
  check(await parse(b3), /二选一/, "两种基址都缺失被拒绝");

  console.log("== tfdt discontinuity ==");
  const b4 = new Uint8Array(base);
  {
    const key = new TextEncoder().encode("tfdt");
    let at = -1;
    for (let i = b4.length - 4; i >= 0; i--) {
      if (b4[i] === key[0] && b4[i + 1] === key[1] && b4[i + 2] === key[2] && b4[i + 3] === key[3]) { at = i; break; }
    }
    const dv = new DataView(b4.buffer, b4.byteOffset);
    // v1 tfdt: u64 at fourcc + version/flags(4)
    dv.setBigUint64(at + 4, dv.getBigUint64(at + 4) + 1n);
  }
  check(await parse(b4), /不连续/, "tfdt 与前段结束 DTS 不一致被拒绝");

  console.log("== truncated box ==");
  const b5 = base.subarray(0, base.length - 40);
  check(await parse(b5), /越界|截断|超出|缺少|边界/, "尾部截断被拒绝");

  console.log("== box claiming size beyond parent ==");
  const b6 = new Uint8Array(base);
  patch(b6, "tfhd", -4, (dv, at) => {
    dv.setUint32(at, dv.getUint32(at) + 4);
  });
  check(await parse(b6), /越界|超出|边界/, "子盒越出父盒被拒绝");

  console.log("== zero-duration sample rejected ==");
  const b7 = new Uint8Array(base);
  // first trun: full header(12) + count(4) + data_offset(4) + first sample
  patch(b7, "trun", 12 + 4 + 4, (dv, at) => dv.setUint32(at, 0));
  check(await parse(b7), /时长须为正/, "零时长被拒绝");

  console.log("== size=0 only allowed at file end ==");
  const b8 = new Uint8Array(base);
  new DataView(b8.buffer, b8.byteOffset).setUint32(0, 0);
  check(await parse(b8), /size=0|越界/, "文件中部 size=0 被拒绝");

  console.log("== broken overrun still parses with warnings, not hard error ==");
  const over = await buildBroken("overrun");
  const model = await parseFile(new File([over.bytes], "o.mp4"));
  check(model.rangeErrors.some((e) => e.kind === "out-of-mdat")
    ? new Error("rangeErrors populated") : null, /rangeErrors/, "越界作为可恢复警告而非致命错误");

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
