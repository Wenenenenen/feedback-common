// Reads a room JSON on stdin, prints { pairs, results, response } for cross-check.
const fs = require('fs');
const E = require('../app/engine.js');

const raw = JSON.parse(fs.readFileSync(0, 'utf8'));
const room = E.validateRoom(raw);
const seqs = E.enumerateSequences(room.order);
const pairs = [];
const results = [];
let firstResponse = null;

for (let si = 0; si < room.sources.length; si++) {
  for (let ri = 0; ri < room.receivers.length; ri++) {
    const paths = E.solvePair(room, si, ri, seqs);
    pairs.push([si, ri]);
    results.push(paths.map((p) => ({
      walls: p.wallNames,
      verts: p.vertices.map((v) => v.map((r) => {
        // exact rational as a fraction string Python Fraction understands
        const g = 1n; // denominator already normalized positive; no reduction needed
        return r.d === 1n ? r.n.toString() : `${r.n}/${r.d}`;
      })),
      length: p.lengthMm,
      blocked: p.reachable ? null : [p.blockedSegment, p.blockedBox],
    })));
    if (firstResponse === null) firstResponse = Array.from(E.buildResponse(room, paths));
  }
}
process.stdout.write(JSON.stringify({ pairs, results, response: firstResponse }));
