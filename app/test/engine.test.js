/* Engine conformance tests — run with: node app/test/engine.test.js
 * Uses the sample package from samples/caption-edit-conformer-cases.zip
 * (extracted by the test into a temp dir when it is not already present).
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const E = require("../src/engine.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + e.message); }
}

function sampleDir() {
  const zip = path.join(__dirname, "..", "..", "samples", "caption-edit-conformer-cases.zip");
  if (!fs.existsSync(zip)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-cases-"));
  execFileSync("unzip", ["-o", zip, "-d", dir], { stdio: "ignore" });
  return dir;
}

const dir = sampleDir();
const demo = dir ? JSON.parse(fs.readFileSync(path.join(dir, "demo.json"), "utf8")) : null;
const expected = dir ? JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8")) : null;

console.log("Fraction");
test("reduces and normalises sign", () => {
  const f = E.frac(6, -8);
  assert.strictEqual(f.n, -3n);
  assert.strictEqual(f.d, 4n);
});
test("floor/ceil on negatives", () => {
  const f = E.frac(-7, 2);
  assert.strictEqual(f.floor(), -4n);
  assert.strictEqual(f.ceil(), -3n);
});
test("arithmetic stays exact", () => {
  let t = E.frac(0);
  for (let i = 0; i < 10; i++) t = t.add(E.frac(1, 3));
  assert.strictEqual(t.n, 10n);
  assert.strictEqual(t.d, 3n);
});
test("pairs serialise as decimal strings", () => {
  assert.deepStrictEqual(E.frac(1000, 21).pair(), ["1000", "21"]);
});

console.log("\nSample package");
if (!demo) {
  console.log("  ⚠ samples zip not found; skipping package checks");
} else {
  test("conform(demo) is error-free", () => {
    const r = E.conform(demo);
    assert.deepStrictEqual(r.errors, []);
  });
  test("JSON export matches expected.json exactly", () => {
    const got = E.toJSON(E.conform(demo));
    assert.deepStrictEqual(got, expected);
  });
  test("WebVTT rounds start down and end up", () => {
    const vtt = E.toWebVTT(E.conform(demo));
    assert.ok(vtt.startsWith("WEBVTT\n"), "starts with WEBVTT");
    assert.ok(vtt.includes("00:00:01.333 --> 00:00:01.762"), "p2:c1 floor/ceil");
    assert.ok(vtt.includes("00:00:01.547 --> 00:00:02.619"), "p2:c2 floor/ceil");
    assert.ok(vtt.includes("00:00:02.618 --> 00:00:03.619"), "p3:c1 floor/ceil");
  });
  test("reused clip emits its own cues", () => {
    const r = E.conform(demo);
    const p1 = r.cues.filter(c => c.clipId === "p1");
    const p3 = r.cues.filter(c => c.clipId === "p3");
    assert.strictEqual(p1.length, 1);
    assert.strictEqual(p3.length, 1);
    assert.notStrictEqual(p1[0].start.toString(), p3[0].start.toString());
  });
  test("word cut to clip keeps cue∩clip bounds", () => {
    const r = E.conform(demo);
    const cue = r.cues.find(c => c.id === "p1:c1");
    assert.strictEqual(cue.start.toString(), "0/1");    // cue.start 0 vs in 500
    assert.strictEqual(cue.end.toString(), "1000/1");   // cue.end 3000 vs out 2000
    assert.strictEqual(cue.words.length, 2);
  });
  test("cue with words that all fall outside is dropped", () => {
    const d = { sources: [{ id: "s", duration_ms: 1000, cues: [{ id: "c", start: 0, end: 1000, text: "x y", words: [{ text: "x", start: 0, end: 200 }, { text: "y", start: 800, end: 1000 }] }] }], clips: [{ id: "k", source: "s", in: 300, out: 700, speed: [1, 1] }] };
    assert.strictEqual(E.conform(d).cues.length, 0);
  });
  test("cue without words keeps whole text on partial cut", () => {
    const d = { sources: [{ id: "s", duration_ms: 1000, cues: [{ id: "c", start: 100, end: 900, text: "整句" }] }], clips: [{ id: "k", source: "s", in: 300, out: 700, speed: [1, 1] }] };
    const r = E.conform(d);
    assert.strictEqual(r.cues.length, 1);
    assert.strictEqual(r.cues[0].text, "整句");
    // cue∩clip = [300, 700): the cue is wider than the clip, so the result
    // spans the whole clip, not the cue's own head and tail.
    assert.strictEqual(r.cues[0].start.toString(), "0/1");
    assert.strictEqual(r.cues[0].end.toString(), "400/1");
  });
  test("cue trimmed by clip start maps from the cut point", () => {
    const d = { sources: [{ id: "s", duration_ms: 1000, cues: [{ id: "c", start: 100, end: 500, text: "整句" }] }], clips: [{ id: "k", source: "s", in: 300, out: 900, speed: [1, 1] }] };
    const r = E.conform(d);
    assert.strictEqual(r.cues[0].start.toString(), "0/1");
    assert.strictEqual(r.cues[0].end.toString(), "200/1");
  });
  test("overlapping source cues both survive and stay overlapping", () => {
    const d = {
      sources: [{ id: "s", duration_ms: 5000, cues: [
        { id: "a", start: 0, end: 3000, text: "A" },
        { id: "b", start: 2000, end: 4000, text: "B" }
      ] }],
      clips: [{ id: "k", source: "s", in: 0, out: 5000, speed: [1, 1] }]
    };
    const r = E.conform(d);
    assert.strictEqual(r.cues.length, 2);
    assert.deepStrictEqual(r.cues.map(c => c.id), ["k:a", "k:b"]);
    assert.ok(r.cues[1].overlapsEarlier);
  });
  test("sort tie-break: clip order then cue id code-unit order", () => {
    const d = {
      sources: [{ id: "s", duration_ms: 1000, cues: [
        { id: "b", start: 0, end: 500, text: "B" },
        { id: "a", start: 0, end: 500, text: "A" }
      ] }],
      clips: [
        { id: "z", source: "s", in: 0, out: 500, speed: [1, 1] },
        { id: "y", source: "s", in: 0, out: 500, speed: [1, 1] }
      ]
    };
    const r = E.conform(d);
    // both clips start at 0 → clip order decides first
    assert.deepStrictEqual(r.cues.map(c => c.id), ["z:a", "z:b", "y:a", "y:b"]);
  });
  test("gap duration accumulates exactly", () => {
    const d = { sources: [{ id: "s", duration_ms: 1000, cues: [] }], clips: [
      { id: "g1", source: null, duration_ms: 333 },
      { id: "g2", source: null, duration_ms: 667 }
    ] };
    const r = E.conform(d);
    assert.strictEqual(r.duration.toString(), "1000/1");
  });
  test("speed stretches output", () => {
    const d = { sources: [{ id: "s", duration_ms: 4000, cues: [{ id: "c", start: 0, end: 4000, text: "x" }] }], clips: [{ id: "k", source: "s", in: 0, out: 4000, speed: [2, 1] }] };
    const r = E.conform(d);
    assert.strictEqual(r.cues[0].end.toString(), "2000/1");
    assert.strictEqual(r.duration.toString(), "2000/1");
  });
  test("multiple sources stay independent", () => {
    const d = {
      sources: [
        { id: "a", duration_ms: 1000, cues: [{ id: "a1", start: 0, end: 1000, text: "A" }] },
        { id: "b", duration_ms: 2000, cues: [{ id: "b1", start: 500, end: 1500, text: "B" }] }
      ],
      clips: [
        { id: "p", source: "a", in: 0, out: 1000, speed: [1, 1] },
        { id: "q", source: "b", in: 0, out: 2000, speed: [1, 1] }
      ]
    };
    const r = E.conform(d);
    assert.deepStrictEqual(r.cues.map(c => c.id), ["p:a1", "q:b1"]);
    assert.strictEqual(r.cues[1].start.toString(), "1500/1");
  });
}

console.log("\nValidation");
const errs = (doc) => E.validateDoc(doc).errors;
const has = (list, re) => list.some(e => re.test(e.message));

test("rejects non-positive cue interval with location", () => {
  const e = errs({ sources: [{ id: "s", duration_ms: 100, cues: [{ id: "c", start: 90, end: 90, text: "" }] }], clips: [] });
  const hit = e.find(x => /长度不为正/.test(x.message));
  assert.ok(hit);
  assert.strictEqual(hit.sourceIndex, 0);
  assert.strictEqual(hit.cueIndex, 0);
  assert.strictEqual(hit.path, "sources[0].cues[0].end");
});
test("rejects zero speed and names the clip", () => {
  const e = errs({ sources: [{ id: "s", duration_ms: 100, cues: [] }], clips: [{ id: "k", source: "s", in: 0, out: 10, speed: [0, 5] }] });
  const hit = e.find(x => x.kind === "zero-speed");
  assert.ok(hit);
  assert.strictEqual(hit.clipIndex, 0);
  assert.strictEqual(hit.where, "片段 k");
});
test("rejects out-of-order words (錯序) with index", () => {
  const e = errs({ sources: [{ id: "s", duration_ms: 1000, cues: [{ id: "c", start: 0, end: 1000, text: "", words: [
    { text: "a", start: 500, end: 600 },
    { text: "b", start: 200, end: 300 }
  ] }] }], clips: [] });
  const hit = e.find(x => x.kind === "order");
  assert.ok(hit);
  assert.strictEqual(hit.wordIndex, 1);
  assert.ok(/错序词/.test(hit.message));
});
test("rejects word overlapping previous word", () => {
  const e = errs({ sources: [{ id: "s", duration_ms: 1000, cues: [{ id: "c", start: 0, end: 1000, text: "", words: [
    { text: "a", start: 100, end: 500 },
    { text: "b", start: 400, end: 600 }
  ] }] }], clips: [] });
  assert.ok(e.some(x => x.kind === "overlap" && x.wordIndex === 1));
});
test("rejects word outside its cue", () => {
  const e = errs({ sources: [{ id: "s", duration_ms: 1000, cues: [{ id: "c", start: 100, end: 500, text: "", words: [
    { text: "a", start: 50, end: 200 }
  ] }] }], clips: [] });
  assert.ok(e.some(x => /不在所属字幕/.test(x.message)));
});
test("rejects clip beyond source duration", () => {
  const e = errs({ sources: [{ id: "s", duration_ms: 1000, cues: [] }], clips: [{ id: "k", source: "s", in: 0, out: 1001, speed: [1, 1] }] });
  assert.ok(has(e, /越过源/));
});
test("rejects speed outside 1/4–4", () => {
  const e = errs({ sources: [{ id: "s", duration_ms: 1000, cues: [] }], clips: [{ id: "k", source: "s", in: 0, out: 10, speed: [5, 1] }] });
  assert.ok(has(e, /超出 1\/4–4/));
});
test("rejects duplicate ids", () => {
  const e = errs({ sources: [{ id: "s", duration_ms: 1000, cues: [{ id: "c", start: 0, end: 10, text: "" }, { id: "c", start: 20, end: 30, text: "" }] }], clips: [] });
  assert.ok(has(e, /id“c”重复/));
});
test("strict conform blocks on error; tolerant keeps previewing", () => {
  const doc = { sources: [{ id: "s", duration_ms: 1000, cues: [{ id: "a", start: 0, end: 500, text: "ok" }] }], clips: [
    { id: "good", source: "s", in: 0, out: 500, speed: [1, 1] },
    { id: "bad", source: "s", in: 0, out: 500, speed: [0, 1] }
  ] };
  assert.strictEqual(E.conform(doc).cues.length, 0);
  const t = E.conform(doc, { tolerant: true });
  assert.strictEqual(t.cues.length, 1);
  assert.strictEqual(t.cues[0].clipId, "good");
  assert.strictEqual(t.skippedClips, 1);
});
test("words with [] produce no caption", () => {
  const doc = { sources: [{ id: "s", duration_ms: 1000, cues: [{ id: "c", start: 0, end: 1000, text: "fallback", words: [] }] }], clips: [{ id: "k", source: "s", in: 0, out: 1000, speed: [1, 1] }] };
  assert.strictEqual(E.conform(doc).cues.length, 0);
});
test("hours field is at least two digits", () => {
  const f = E.frac(3723456); // 01:02:03.456
  assert.strictEqual(E.vttTime(f.floor()), "01:02:03.456");
});
test("VTT escapes newlines in text", () => {
  const doc = { sources: [{ id: "s", duration_ms: 1000, cues: [{ id: "c", start: 0, end: 1000, text: "a\nb" }] }], clips: [{ id: "k", source: "s", in: 0, out: 1000, speed: [1, 1] }] };
  const vtt = E.toWebVTT(E.conform(doc));
  assert.ok(vtt.includes("a b"));
  assert.ok(!/a\nb/.test(vtt));
});

console.log("\nScale");
test("1500 cues × 500 clips conforms under a few seconds", () => {
  const cues = [];
  for (let i = 0; i < 1500; i++) {
    const s = Math.floor(i * 10000 / 1500);
    cues.push({ id: "c" + String(i).padStart(4, "0"), start: s, end: s + 60, text: "字", words: [{ text: "字", start: s, end: s + 60 }] });
  }
  const doc = { sources: [{ id: "a", duration_ms: 10000, cues }], clips: [] };
  for (let i = 0; i < 500; i++) doc.clips.push({ id: "p" + i, source: "a", in: 0, out: 10000, speed: [1, 1] });
  const t0 = Date.now();
  const r = E.conform(doc, { tolerant: true });
  const ms = Date.now() - t0;
  assert.strictEqual(r.cues.length, 750000);
  assert.ok(ms < 8000, "took " + ms + "ms");
});

console.log("\n" + (failed ? failed + " failed, " : "") + passed + " passed");
process.exit(failed ? 1 : 0);
