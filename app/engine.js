/*
 * Room early-reflection engine (mirror / image-source method).
 *
 * Exact geometry: all intersection parameters are rational numbers
 * (BigInt numerator / positive BigInt denominator). Hits that land on a room
 * edge or corner (two or three crossings sharing one parameter) are discarded;
 * closed box obstacles use closed-interval slab tests, so a grazing touch is a
 * block. No acoustic-simulation library is used anywhere.
 *
 * Works unchanged in Node and the browser (attaches to globalThis as RoomEngine).
 */
(function (root) {
  'use strict';

  // ---------- exact rational helpers ----------
  // A rational is { n: BigInt, d: BigInt } with d > 0. Not reduced; comparison
  // uses cross multiplication.

  const ZERO = { n: 0n, d: 1n };
  const ONE = { n: 1n, d: 1n };

  function rsub(a, b) { return { n: a.n * b.d - b.n * a.d, d: a.d * b.d }; }
  function rdiv(an, bd) { return { n: BigInt(an), d: BigInt(bd) }; }
  function rcmp(a, b) {
    const l = a.n * b.d, r = b.n * a.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  function rle(a, b) { return rcmp(a, b) <= 0; }
  function rtof(r) { return Number(r.n) / Number(r.d); }

  // floor(q/d) for d > 0, q any sign (truncation does not work for negatives).
  function floorDiv(q, d) {
    const t = q / d;
    return q % d < 0n ? t - 1n : t;
  }
  // ceil(q/d) for d > 0.
  function ceilDiv(q, d) {
    const t = q / d;
    return q % d > 0n ? t + 1n : t;
  }

  // Mirror-fold an unfolded rational x = n/d (d > 0) into [0, L].
  // The folded value keeps denominator d; the numerator alone is folded over
  // the period 2*L*d. Returns the folded numerator.
  function foldNum(n, L, d) {
    const period = 2n * L * d;
    let m = n % period;
    if (m < 0n) m += period;      // 0 <= m < period
    if (m > L * d) m = period - m;
    return m;
  }
  // integer convenience wrapper
  function foldInt(x, L) {
    return foldNum(x, L, 1n);
  }

  // wall codes: 0=x0 1=x1 2=y0 3=y1 4=z0 5=z1
  const WALL_NAMES = ['x0', 'x1', 'y0', 'y1', 'z0', 'z1'];
  const WALL_AXIS = [0, 0, 1, 1, 2, 2];
  const WALL_SIGN = [0, 1, 0, 1, 0, 1]; // low / high wall on its axis

  function reflectCoord(c, L, sign) {
    return sign === 0 ? -c : 2n * L - c;
  }

  // ---------- room validation ----------
  function validateRoom(room) {
    const err = (m) => { throw new Error(m); };
    const isInt = (v) => Number.isInteger(v);
    const v3 = (p, label) => {
      if (!Array.isArray(p) || p.length !== 3 || !p.every(isInt))
        err(label + ' must be a 3-element integer array');
      return p.map(BigInt);
    };
    if (!room || typeof room !== 'object') err('room must be an object');
    if (!Array.isArray(room.size) || room.size.length !== 3 ||
        !room.size.every((v) => isInt(v) && v >= 1000 && v <= 40000))
      err('size must be three integers in [1000, 40000] mm');
    const size = room.size.map(BigInt);

    const checkPoint = (p, label, boxes) => {
      const q = v3(p, label);
      for (let a = 0; a < 3; a++) {
        if (!(q[a] > 0n && q[a] < size[a])) err(label + ' must be strictly inside the room');
      }
      for (let bi = 0; bi < boxes.length; bi++) {
        const b = boxes[bi];
        let inside = true;
        for (let a = 0; a < 3; a++) {
          if (!(q[a] >= b.min[a] && q[a] <= b.max[a])) inside = false;
        }
        if (inside) err(label + ' must be outside every obstacle box');
      }
      return q;
    };

    if (!Array.isArray(room.sources) || room.sources.length < 1 || room.sources.length > 6)
      err('sources: 1..6 arrays required');
    if (!Array.isArray(room.receivers) || room.receivers.length < 1 || room.receivers.length > 32)
      err('receivers: 1..32 arrays required');
    if (!Array.isArray(room.boxes) || room.boxes.length > 24)
      err('boxes: at most 24 entries');

    const boxes = room.boxes.map((b, i) => {
      if (!b || !Array.isArray(b.min) || !Array.isArray(b.max) ||
          b.min.length !== 3 || b.max.length !== 3)
        err('box ' + i + ' needs min/max 3-arrays');
      const min = b.min.map(BigInt), max = b.max.map(BigInt);
      for (let a = 0; a < 3; a++) {
        if (!(min[a] < max[a])) err('box ' + i + ': min must be strictly below max on every axis');
        if (!(min[a] > 0n && max[a] < size[a])) err('box ' + i + ' must be strictly inside the room');
      }
      return { min, max };
    });

    const sources = room.sources.map((p, i) => checkPoint(p, 'source ' + i, boxes));
    const receivers = room.receivers.map((p, i) => checkPoint(p, 'receiver ' + i, boxes));
    for (let i = 0; i < sources.length; i++)
      for (let j = 0; j < receivers.length; j++)
        if (sources[i].every((v, a) => v === receivers[j][a]))
          err('no source may coincide with a receiver');

    const order = room.order;
    if (!isInt(order) || order < 0 || order > 4) err('order must be an integer 0..4');

    if (!Array.isArray(room.walls) || room.walls.length !== 6)
      err('walls must contain six tap triples');
    const walls = room.walls.map((t, i) => {
      if (!Array.isArray(t) || t.length !== 3 || !t.every(isInt))
        err('wall ' + i + ' taps must be three integers');
      if (t.some((v) => v < -4096 || v > 4096))
        err('wall ' + i + ' taps must be within [-4096, 4096]');
      return t.map(BigInt);
    });

    return { size, sources, receivers, boxes, order, walls };
  }

  // ---------- wall sequence enumeration ----------
  function enumerateSequences(order) {
    const out = [[]]; // 0th order: direct path
    (function dfs(seq) {
      if (seq.length === order) return;
      const last = seq.length ? seq[seq.length - 1] : -1;
      for (let w = 0; w < 6; w++) {
        if (w === last) continue; // reflection off the same wall twice in a row is impossible
        const next = seq.concat(w);
        out.push(next);
        dfs(next);
      }
    })([]);
    return out;
  }

  // ---------- one candidate path (exact) ----------
  // Returns { ok, reason?, walls, vertices, lengthMm } where vertices are
  // rationals [{n,d} x3] folded into the real room, including S and R.
  function buildCandidate(S, R, size, seq) {
    // image of R after reflecting, in reverse wall order, across real planes
    const img = R.slice();
    for (let i = seq.length - 1; i >= 0; i--) {
      const w = seq[i], a = WALL_AXIS[w];
      img[a] = reflectCoord(img[a], size[a], WALL_SIGN[w]);
    }

    // all room-cell boundary crossings of the straight segment S -> img.
    // In unfolded space the tiled rooms have boundaries at multiples of L.
    const crossings = [];
    for (let a = 0; a < 3; a++) {
      const L = size[a];
      const sv = S[a], rv = img[a], dv = rv - sv;
      if (dv === 0n) continue;
      const lo = sv < rv ? sv : rv;
      const hi = sv < rv ? rv : sv;
      // strict: lo < m*L < hi
      const m0 = floorDiv(lo, L) + 1n;
      const m1 = ceilDiv(hi, L) - 1n;
      for (let m = m0; m <= m1; m++) {
        const plane = m * L;
        // normalize denominator positive so every downstream rational is well-formed
        let tn = plane - sv, td = dv;
        if (td < 0n) { tn = -tn; td = -td; }
        crossings.push({ t: { n: tn, d: td }, axis: a, cell: m });
      }
    }

    // exact ordering; equal parameters => edge/corner hit => discard whole path
    crossings.sort((p, q) => rcmp(p.t, q.t));
    for (let i = 1; i < crossings.length; i++) {
      if (rcmp(crossings[i - 1].t, crossings[i].t) === 0)
        return { ok: false, reason: 'edge' };
    }

    // wall code of a crossing from its unfolded cell: parity + axis
    const codeOf = (axis, cell) => axis * 2 + (cell % 2n === 0n ? 0 : 1);
    const actual = crossings.map((c) => codeOf(c.axis, c.cell));
    if (actual.length !== seq.length || actual.some((w, i) => w !== seq[i]))
      return { ok: false, reason: 'sequence' };

    // fold every crossing point into the real room; build full vertex chain
    const verts = [S.map((v) => ({ n: v, d: 1n }))];
    for (const c of crossings) {
      const v = [];
      for (let a = 0; a < 3; a++) {
        if (a === c.axis) {
          v.push({ n: foldInt(c.cell * size[a], size[a]), d: 1n });
        } else {
          // fold(S[a] + t*(img[a]-S[a])) evaluated exactly as a rational
          const num = S[a] * c.t.d + c.t.n * (img[a] - S[a]);
          v.push({ n: foldNum(num, size[a], c.t.d), d: c.t.d });
        }
      }
      // reflection vertex must lie strictly inside the wall's open face
      for (let a = 0; a < 3; a++) {
        if (a !== c.axis && !(v[a].n > 0n && v[a].n < size[a] * v[a].d))
          return { ok: false, reason: 'face' };
      }
      verts.push(v);
    }
    verts.push(R.map((v) => ({ n: v, d: 1n })));

    // length: straight distance in unfolded space equals the folded path length
    let sq = 0n;
    for (let a = 0; a < 3; a++) {
      const d = img[a] - S[a];
      sq += d * d;
    }
    const lengthMm = Math.sqrt(Number(sq));

    return { ok: true, walls: seq.slice(), vertices: verts, lengthMm };
  }

  // closed-interval slab test: parameter interval of segment P + t*D inside
  // [lo, hi] on one axis. Returns null when the segment never meets the slab.
  function slabInterval(p, d, lo, hi) {
    if (d.n === 0n) {
      if (p.n >= lo * p.d && p.n <= hi * p.d) return { lo: ZERO, hi: ONE };
      return null;
    }
    const a = rsub({ n: lo, d: 1n }, p);
    const b = rsub({ n: hi, d: 1n }, p);
    let t0, t1;
    if (d.n > 0n) {
      t0 = { n: a.n * d.d, d: a.d * d.n };
      t1 = { n: b.n * d.d, d: b.d * d.n };
    } else {
      t0 = { n: b.n * (-d.d), d: b.d * (-d.n) };
      t1 = { n: a.n * (-d.d), d: a.d * (-d.n) };
    }
    if (rcmp(t1, ZERO) < 0 || rcmp(t0, ONE) > 0) return null;
    if (rcmp(t0, ZERO) < 0) t0 = ZERO;
    if (rcmp(t1, ONE) > 0) t1 = ONE;
    return { lo: t0, hi: t1 };
  }

  // Test every segment against every closed box. Returns the first blockage
  // { segment, box, t } scanning segments source->receiver, smallest box index
  // first when boxes are met at the same parameter on the same segment.
  function firstBlockage(vertices, boxes) {
    for (let s = 0; s < vertices.length - 1; s++) {
      const P = vertices[s], Q = vertices[s + 1];
      const D = P.map((p, a) => rsub(Q[a], p));
      let best = null;
      for (let bi = 0; bi < boxes.length; bi++) {
        const box = boxes[bi];
        let enter = ZERO, exit = ONE, hit = true;
        for (let a = 0; a < 3; a++) {
          const iv = slabInterval(P[a], D[a], box.min[a], box.max[a]);
          if (!iv) { hit = false; break; }
          if (rcmp(iv.lo, enter) > 0) enter = iv.lo;
          if (rcmp(iv.hi, exit) < 0) exit = iv.hi;
        }
        if (hit && rle(enter, exit)) {
          if (best === null || rcmp(enter, best.t) < 0)
            best = { t: enter, box: bi };
        }
      }
      if (best) return { segment: s, box: best.box, t: best.t };
    }
    return null;
  }

  // ---------- full pair ----------
  function solvePair(room, si, ri, sequences) {
    const S = room.sources[si], R = room.receivers[ri];
    const paths = [];
    for (const seq of sequences) {
      const cand = buildCandidate(S, R, room.size, seq);
      if (!cand.ok) continue; // edge/corner or geometrically impossible wall order
      const hit = firstBlockage(cand.vertices, room.boxes);
      paths.push({
        walls: cand.walls,
        wallNames: cand.walls.map((w) => WALL_NAMES[w]),
        vertices: cand.vertices,
        lengthMm: cand.lengthMm,
        reachable: !hit,
        blockedSegment: hit ? hit.segment : -1,
        blockedBox: hit ? hit.box : -1,
      });
    }
    // shortest first: stable presentation and predictable table order
    paths.sort((a, b) => a.lengthMm - b.lengthMm ||
      a.walls.join('.').localeCompare(b.walls.join('.')));
    return paths;
  }

  // ---------- wall filter convolution (exact integer taps) ----------
  function convolvePathWalls(wallTaps, seq) {
    let h = [1n];
    for (const w of seq) {
      const g = wallTaps[w];
      const out = new Array(h.length + g.length - 1).fill(0n);
      for (let i = 0; i < h.length; i++)
        for (let k = 0; k < g.length; k++)
          out[i + k] += h[i] * g[k];
      h = out;
    }
    return h; // integer taps; divisor 4096^n applied with attenuation later
  }

  // ---------- impulse response (96000 frames, float32 WAV payload) ----------
  const FS = 48000, NFRAMES = 96000, C = 343000, TAP_DIV = 4096;

  function buildResponse(room, paths) {
    const buf = new Float32Array(NFRAMES); // all contributions sum into frames
    for (const p of paths) {
      if (!p.reachable) continue;
      const h = convolvePathWalls(room.walls, p.walls);
      const div = Math.pow(TAP_DIV, p.walls.length);
      const atten = Math.max(1, p.lengthMm / 1000);
      const d = p.lengthMm * FS / C;
      const base = Math.floor(d);
      let frac = d - base;
      if (frac < 0) frac = 0; else if (frac >= 1) frac = 0; // guard float rounding
      for (let k = 0; k < h.length; k++) {
        const c = Number(h[k]) / div / atten;
        const f0 = base + k, f1 = f0 + 1;
        if (f0 >= 0 && f0 < NFRAMES) buf[f0] += c * (1 - frac);
        if (f1 >= 0 && f1 < NFRAMES) buf[f1] += c * frac;
      }
    }
    return buf;
  }

  // IEEE 754 little-endian float32 mono WAV, no clipping.
  function encodeWav(float32) {
    const n = float32.length;
    const dataBytes = n * 4;
    const ab = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(ab);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); ws(8, 'WAVE');
    ws(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 3, true);            // IEEE float
    dv.setUint16(22, 1, true);            // mono
    dv.setUint32(24, FS, true);
    dv.setUint32(28, FS * 4, true);       // byte rate
    dv.setUint16(32, 4, true);            // block align
    dv.setUint16(34, 32, true);           // bits per sample
    ws(36, 'data'); dv.setUint32(40, dataBytes, true);
    for (let i = 0; i < n; i++) dv.setFloat32(44 + i * 4, float32[i], true);
    return new Blob([ab], { type: 'audio/wav' });
  }

  // ---------- JSON-friendly path table ----------
  function vertexOut(v) {
    return v.map((r) => {
      const f = rtof(r);
      return Number.isInteger(f) ? f : Number(f.toFixed(6));
    });
  }
  function pathsToJSON(room, si, ri, paths) {
    return {
      room: {
        size: room.size.map(Number),
        source: room.sources[si].map(Number),
        receiver: room.receivers[ri].map(Number),
        order: room.order,
        walls: room.walls.map((t) => t.map(Number)),
      },
      count: paths.length,
      reachable: paths.filter((p) => p.reachable).length,
      blocked: paths.filter((p) => !p.reachable).length,
      paths: paths.map((p) => ({
        wallOrder: p.wallNames,
        verticesMm: p.vertices.map(vertexOut),
        lengthMm: Number(p.lengthMm.toFixed(4)),
        reachable: p.reachable,
        blockedSegment: p.blockedSegment,
        blockedBox: p.blockedBox,
      })),
    };
  }

  const api = {
    WALL_NAMES, WALL_AXIS,
    validateRoom, enumerateSequences, buildCandidate, firstBlockage,
    solvePair, convolvePathWalls, buildResponse, encodeWav, pathsToJSON,
    foldInt, floorDiv, ceilDiv, slabInterval, rcmp, rtof,
    FS, NFRAMES, C,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RoomEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
