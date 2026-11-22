import { readFileSync } from "node:fs";
import { parseSup, buildIntervals } from "../js/pgs.js";
const u8 = readFileSync("samples/extracted/layers.sup");
const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const p = parseSup(ab);
const iv = buildIntervals(p.states, 450000);
const payload = { source: "layers.sup", timeBase: "90kHz", intervalSemantics: "half-open [start,end)",
  canvas: p.canvas, forcedOnly: false, lastEndUserSupplied: true, intervals: iv };
console.log(JSON.stringify(payload, null, 2));
