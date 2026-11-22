// Node harness: validate the parser against the sample pack.
// Run: node tools/test-parser.mjs
import { readFileSync } from "node:fs";
import { parseSup, renderState, buildIntervals, formatTicks, PgsError } from "../js/pgs.js";

const base = "samples/extracted";
const cases = ["layers.sup", "stale.sup", "truncated.sup"];

const load = (name) => {
  const u8 = readFileSync(`${base}/${name}`);
  // Node buffers may be views on a pooled ArrayBuffer; hand the parser an exact-size copy.
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
};

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { failures++; console.log("  ✗", msg); }
  else console.log("  ✓", msg);
};

for (const name of cases) {
  console.log(`\n=== ${name} ===`);
  const buf = load(name);
  try {
    const parsed = parseSup(buf);
    console.log(`  canvas=${parsed.canvas.width}×${parsed.canvas.height} states=${parsed.states.length} objects=${parsed.objects.size}`);
    for (const s of parsed.states) {
      const r = renderState(s, parsed.canvas);
      const visible = r.paintedEntries.filter((e) => e.pixels > 0);
      console.log(`  PTS=${s.pts} (${formatTicks(s.pts)}) kind=${s.kind} entries=${s.entries.length} forced=${s.anyForced} painted=${visible.length} warnings=${s.warnings.length}`);
      for (const e of r.paintedEntries) {
        console.log(`    - obj=${e.objectId} stale=${e.stale} missing=${e.missing} forced=${e.forced} pixels=${e.pixels} placed=${JSON.stringify(e.placed)}`);
      }
    }
    if (parsed.diagnostics.length) console.log("  diagnostics:", parsed.diagnostics);
    if (parsed.warnings.length) console.log("  warnings:", parsed.warnings);

    if (name === "layers.sup") {
      assert(parsed.states.length === 4, "layers: 4 committed states");
      const kinds = parsed.states.map((s) => s.kind);
      assert(kinds[0] === "epoch", "layers: first state is epoch start");
      assert(kinds[1] === "palette", "layers: second state is palette-only update (0x80, 0 objects)");
      assert(kinds[2] === "clear", "layers: third state is clear (0x00, 0 objects)");
      const iv = buildIntervals(parsed.states, 450000);
      assert(iv.length === 4 && iv.at(-1).end === 450000, "layers: intervals half-open with user end");
      assert(iv.every((x) => x.end > x.start), "layers: all intervals end after start");
      const last = parsed.states.at(-1);
      const r = renderState(last, parsed.canvas);
      // epoch4's ODS decodes to 70 palette-0 pixels; palette entry 0 is alpha=0 transparent black,
      // so the correct composited result is a fully transparent strip (0 visible pixels).
      assert(last.entries.length === 1 && last.entries[0].stale, "layers: epoch4 keeps the stale object entry");
      assert(r.paintedEntries[0]?.placed?.w === 70, "layers: epoch4 places the 70-wide strip");
      assert(r.paintedEntries.every((e) => e.pixels === 0), "layers: transparent-black palette paints nothing visible");
    }
    if (name === "stale.sup") {
      const stale = parsed.states.find((s) => s.warnings.some((w) => w.includes("沿用上一个对象")));
      assert(!!stale, "stale: stale carry-over object is flagged");
      assert(parsed.states.some((s) => s.kind === "clear"), "stale: contains a real clear-screen state");
    }
  } catch (err) {
    if (err instanceof PgsError) {
      console.log(`  PgsError: ${err.message}`);
      console.log(`    segmentOffset=${err.segmentOffset?.toString(16)} fileOffset=${err.fileOffset?.toString(16)} index=${err.segmentIndex}`);
      failures++;
    } else {
      failures++;
      console.log(err);
    }
  }
  // truncated.sup: first set commits, second set lacks END -> diagnostic anchored at PCS 0xc5
  if (name === "truncated.sup") {
    try {
      const parsed2 = parseSup(load(name));
      const d = parsed2.diagnostics.find((x) => /END/.test(x.message));
      assert(!!d, "truncated: missing-END diagnostic emitted");
      assert(/0xc5/.test(d.message), "truncated: diagnostic names PCS offset 0xc5");
      assert(parsed2.states.length === 1, "truncated: only the committed state is on the timeline");
    } catch (e) {
      assert(false, "truncated: should not throw when one state committed: " + e.message);
    }
  }
}

// forced-only filter check on layers
const parsed = parseSup(load("layers.sup"));
const forcedIv = buildIntervals(parsed.states, 450000, { forcedOnly: true });
console.log("\nforced-only intervals:", forcedIv);
assert(forcedIv.some((i) => i.blank), "forced filter: non-forced states become blank intervals");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
