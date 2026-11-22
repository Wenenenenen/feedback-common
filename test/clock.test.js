import { test } from "node:test";
import assert from "node:assert/strict";
import { ClockUnwrapper, PCR_MOD, PTS_MOD, pcrToSeconds, ptsToSeconds } from "../src/clock.js";

test("PTS normal progression", () => {
  const u = new ClockUnwrapper(PTS_MOD);
  const a = u.push(1000n);
  const b = u.push(2000n);
  assert.equal(a.kind, "first");
  assert.equal(b.kind, "normal");
  assert.equal(b.delta, 1000n);
  assert.equal(b.unwrapped, 2000n);
});

test("PTS wrap near 2^33 boundary keeps monotonic unwrapped value", () => {
  const u = new ClockUnwrapper(PTS_MOD);
  u.push(BigInt(PTS_MOD) - 10n);
  const r = u.push(20n);
  assert.equal(r.kind, "wrap");
  assert.equal(r.raw, 20n);
  assert.equal(r.unwrapped, BigInt(PTS_MOD) + 20n);
  assert.equal(r.delta, -(BigInt(PTS_MOD) - 30n));
});

test("small PTS backward step is regression, not wrap", () => {
  const u = new ClockUnwrapper(PTS_MOD);
  u.push(5000n);
  const r = u.push(4980n);
  assert.equal(r.kind, "regression");
  assert.equal(r.unwrapped, 4980n); // no modulus added
  assert.equal(r.delta, -20n);
});

test("PCR wrap at 42-bit boundary", () => {
  const u = new ClockUnwrapper(PCR_MOD);
  u.push(BigInt(PCR_MOD) - 300n);
  const r = u.push(18n);
  assert.equal(r.kind, "wrap");
  assert.equal(r.unwrapped, BigInt(PCR_MOD) + 18n);
});
test("unwrapper reset starts a fresh series", () => {
  const u = new ClockUnwrapper(PTS_MOD);
  u.push(9000n);
  u.reset();
  const r = u.push(5n);
  assert.equal(r.kind, "first");
  assert.equal(r.unwrapped, 5n);
});

test("converters", () => {
  assert.equal(ptsToSeconds(90000n), 1);
  assert.equal(pcrToSeconds(27000000n), 1);
});
