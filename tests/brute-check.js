const SF = require('../strip-forge.js');

function rotations(v) {
  return [
    [v[0], v[1], v[2]],
    [v[1], v[2], v[0]],
    [v[2], v[0], v[1]]
  ];
}

function validTriples(f) {
  return rotations(f.v).filter((c) => f.last === null || c[2] === f.last);
}

function matches(f, c) {
  return rotations(f.v).some((r) => r[0] === c[0] && r[1] === c[1] && r[2] === c[2]);
}

function lexLess(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return a.length < b.length;
}

function brutePack(faces) {
  let best = null;

  function consider(stream) {
    if (!best || stream.length < best.length || (stream.length === best.length && lexLess(stream, best))) {
      best = stream.slice();
    }
  }

  function contPaths(f, src, cb) {
    const U = [...new Set([src.x, src.y, ...f.v])];
    for (let len = 1; len <= 4; len++) {
      const seq = [];
      const dfs = () => {
        if (seq.length === len) {
          let x = src.x, y = src.y, q = src.q;
          let ok = true;
          for (let p = 0; p < len; p++) {
            const t = seq[p];
            const raw = [x, y, t];
            const dup = raw[0] === raw[1] || raw[0] === raw[2] || raw[1] === raw[2];
            if (p < len - 1) {
              if (!dup) { ok = false; break; }
            } else {
              if (dup) { ok = false; break; }
              const canon = q === 0 ? raw : [raw[1], raw[0], raw[2]];
              if (!matches(f, canon)) { ok = false; break; }
              if (f.last !== null && t !== f.last) { ok = false; break; }
            }
            x = y; y = t; q ^= 1;
          }
          if (ok) cb(seq.slice(), { x, y, q });
          return;
        }
        for (const t of U) {
          seq.push(t);
          dfs();
          seq.pop();
        }
      };
      dfs();
    }
  }

  function encodeFrom(i, stream, state) {
    if (i === faces.length) {
      consider(stream);
      return;
    }
    const f = faces[i];
    const prev = faces[i - 1];
    const triples = validTriples(f);

    if (prev.group !== f.group) {
      for (const c of triples) {
        const s = { x: c[1], y: c[2], q: 1 };
        stream.push(-1, c[0], c[1], c[2]);
        encodeFrom(i + 1, stream, s);
        stream.pop(); stream.pop(); stream.pop(); stream.pop();
      }
      return;
    }

    // Same-group restart.
    for (const c of triples) {
      const s = { x: c[1], y: c[2], q: 1 };
      stream.push(-1, c[0], c[1], c[2]);
      encodeFrom(i + 1, stream, s);
      stream.pop(); stream.pop(); stream.pop(); stream.pop();
    }

    // Continuation with 0..3 degenerate windows.
    contPaths(f, state, (tokens, nextState) => {
      for (const t of tokens) stream.push(t);
      encodeFrom(i + 1, stream, nextState);
      for (let k = 0; k < tokens.length; k++) stream.pop();
    });
  }

  for (const c of validTriples(faces[0])) {
    const stream = [c[0], c[1], c[2]];
    encodeFrom(1, stream, { x: c[1], y: c[2], q: 1 });
  }
  return best;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomCase(rand, n) {
  const faces = [];
  let group = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && rand() < 0.28) group++;
    let v;
    do {
      v = [Math.floor(rand() * 7), Math.floor(rand() * 7), Math.floor(rand() * 7)];
    } while (new Set(v).size !== 3);
    let last = null;
    if (rand() < 0.45) last = v[Math.floor(rand() * 3)];
    faces.push({ v, group, last });
  }
  return faces;
}

let failures = 0;
for (let seed = 1; seed <= 3000; seed++) {
  const rand = rng(seed);
  const n = 1 + Math.floor(rand() * 5);
  const faces = randomCase(rand, n);
  let got;
  try {
    got = SF.packDocument({ faces }).indices;
  } catch (e) {
    console.error('PACK THREW seed', seed, e);
    process.exit(1);
  }
  const want = brutePack(faces);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.log('MISMATCH seed', seed);
    console.log(JSON.stringify(faces));
    console.log('got ', JSON.stringify(got));
    console.log('want', JSON.stringify(want));
    if (failures >= 5) process.exit(1);
  }
  const ver = SF.verifyResult({ faces }, SF.packDocument({ faces }));
  if (!ver.ok) {
    console.error('VERIFY FAIL seed', seed, ver.errors);
    process.exit(1);
  }
}
console.log(failures === 0 ? 'all exhaustive/random comparisons passed' : `${failures} failures`);
if (failures) process.exit(1);
