/* Screen-space slab tracer — analytic interval version.
 *
 * Coordinate conventions (from the sample package):
 *   camera looks down +z; u = fx*x/z + cx, v = cy - fy*y/z
 *   cell (x,y) covers u in [x, x+1), v in [y, y+1)  (half-open)
 *   depth is forward z; a filled cell's volume is the intersection of its
 *   projection cone with the z slab [depth, depth+thickness]
 *   ray p(t) = origin + t*normalize(direction),
 *   t in [epsilon, maxDistance], near <= z <= far
 *
 * Every cell boundary is a strict/non-strict LINEAR inequality on t once
 * z>0 holds (near plane guarantees it): e.g. u >= x  <=> fx*x+(cx-x)*z >= 0.
 * A candidate needs interval length > 1e-9, so single-point tangents are
 * rejected. Front-face rule: normal . direction < 0.
 */
(function (global) {
  "use strict";

  const EPS_LEN = 1e-9;
  const T_EPS = 1e-12;

  function normalize(v) {
    const n = Math.hypot(v[0], v[1], v[2]);
    if (n === 0) return { dir: [0, 0, 0], len: 0 };
    return { dir: [v[0] / n, v[1] / n, v[2] / n], len: n };
  }

  // Mutable parameter span with strictness flags for the two endpoints.
  function makeSpan(lo, hi) {
    return { lo, hi, loStrict: false, hiStrict: false };
  }

  // Constrain a + b*t > 0 (strictPositive) or >= 0.
  function applyLinear(span, a, b, strictPositive) {
    if (Math.abs(b) < 1e-30) {
      if (a > 0 || (!strictPositive && a === 0)) return span;
      return null;
    }
    const r = -a / b;
    if (b > 0) {
      if (r > span.lo || (r === span.lo && strictPositive)) {
        span.lo = r;
        span.loStrict = strictPositive;
      }
    } else {
      if (r < span.hi || (r === span.hi && strictPositive)) {
        span.hi = r;
        span.hiStrict = strictPositive;
      }
    }
    return span.hi < span.lo ? null : span;
  }

  // Projection-cone-only interval for cell (i, j).
  function coneInterval(o, d, i, j, cam, tlo, thi) {
    const { fx, fy, cx, cy } = cam;
    const span = makeSpan(tlo, thi);
    const constraints = [
      [fx * o[0] + (cx - i) * o[2], fx * d[0] + (cx - i) * d[2], false],
      [-(fx * o[0] + (cx - i - 1) * o[2]),
       -(fx * d[0] + (cx - i - 1) * d[2]), true],
      [(cy - j) * o[2] - fy * o[1], (cy - j) * d[2] - fy * d[1], false],
      [-((cy - j - 1) * o[2] - fy * o[1]),
       -((cy - j - 1) * d[2] - fy * d[1]), true],
    ];
    for (const [a, b, strict] of constraints) {
      if (applyLinear(span, a, b, strict) === null) return null;
    }
    if (span.hi - span.lo <= EPS_LEN) return null;
    return { enter: span.lo, exit: span.hi };
  }

  // Full slab volume: cone intersected with z in [depth, depth+thickness].
  function cellInterval(o, d, i, j, cam, depth, thickness, tlo, thi) {
    const cone = coneInterval(o, d, i, j, cam, tlo, thi);
    if (cone === null) return null;
    const span = makeSpan(cone.enter, cone.exit);
    span.loStrict = false; span.hiStrict = false;
    if (applyLinear(span, o[2] - depth, d[2], false) === null) return null;
    if (applyLinear(span, depth + thickness - o[2], -d[2], false) === null) {
      return null;
    }
    if (span.hi - span.lo <= EPS_LEN) return null;
    return { enter: span.lo, exit: span.hi };
  }

  // Global t span: epsilon/maxDistance plus near/far and screen rectangle.
  function clipSpan(o, d, cam, W, H, epsilon, maxDistance) {
    const span = makeSpan(epsilon, maxDistance);
    const tags = { lo: "epsilon", hi: "maxDistance" };
    const before = { lo: span.lo, hi: span.hi };
    if (applyLinear(span, o[2] - cam.near, d[2], false) === null) {
      return { fail: "near" };
    }
    if (span.lo !== before.lo) tags.lo = "near";
    if (applyLinear(span, cam.far - o[2], -d[2], false) === null) {
      return { fail: "far" };
    }
    if (span.hi !== before.hi) tags.hi = "far";
    const { fx, fy, cx, cy } = cam;
    const screen = [
      [fx * o[0] + cx * o[2], fx * d[0] + cx * d[2], false],
      [-(fx * o[0] + (cx - W) * o[2]), -(fx * d[0] + (cx - W) * d[2]), true],
      [cy * o[2] - fy * o[1], cy * d[2] - fy * d[1], false],
      [-((cy - H) * o[2] - fy * o[1]), -((cy - H) * d[2] - fy * d[1]), true],
    ];
    for (const [a, b, strict] of screen) {
      const snap = { lo: span.lo, hi: span.hi };
      if (applyLinear(span, a, b, strict) === null) {
        return { fail: "off-screen" };
      }
      if (span.lo !== snap.lo) tags.lo = "screen";
      if (span.hi !== snap.hi) tags.hi = "screen";
    }
    return { span, tags };
  }

  function projectAt(o, d, t, cam) {
    const x = o[0] + d[0] * t;
    const y = o[1] + d[1] * t;
    const z = o[2] + d[2] * t;
    return [cam.fx * x / z + cam.cx, cam.cy - cam.fy * y / z];
  }

  // Exact-t DDA over screen cells. The projected ray is straight in (u,v)
  // because u(t), v(t) are linear in t (z stays positive). Boundary crossing
  // times come from the same linear inequality solves, never from stepping.
  // Simultaneous u/v crossings move diagonally, matching half-open cells.
  function ddaCells(o, d, t0, t1, cam, W, H) {
    const [u0, v0] = projectAt(o, d, t0, cam);
    const [u1, v1] = projectAt(o, d, t1, cam);
    const su = u1 === u0 ? 0 : u1 > u0 ? 1 : -1;
    const sv = v1 === v0 ? 0 : v1 > v0 ? 1 : -1;
    // clip guarantees the open span (t0,t1) projects inside the screen rect;
    // an out-of-range floor at t0 is the exact-boundary entry artifact.
    let i = Math.min(Math.max(Math.floor(u0), 0), W - 1);
    let j = Math.min(Math.max(Math.floor(v0), 0), H - 1);
    const out = [];
    let tcur = t0;
    const { fx, fy, cx, cy } = cam;
    let guard = 0;
    while (tcur < t1) {
      if (++guard > 100000) break;
      let tV = Infinity;
      let tH = Infinity;
      if (su !== 0) {
        const k = su > 0 ? i + 1 : i;
        const a = fx * o[0] + (cx - k) * o[2];
        const b = fx * d[0] + (cx - k) * d[2];
        if (b !== 0) {
          const t = -a / b;
          if (t > tcur) tV = t;
        }
      }
      if (sv !== 0) {
        const k = sv > 0 ? j + 1 : j;
        const a = (cy - k) * o[2] - fy * o[1];
        const b = (cy - k) * d[2] - fy * d[1];
        if (b !== 0) {
          const t = -a / b;
          if (t > tcur) tH = t;
        }
      }
      const tend = Math.min(tV, tH, t1);
      if (i >= 0 && i < W && j >= 0 && j < H && tend > tcur) {
        out.push({ x: i, y: j, enter: tcur, exit: tend });
      }
      if (tV === tH) { i += su; j += sv; }
      else if (tV < tH) i += su;
      else j += sv;
      tcur = tend;
      if (i < -2 || i > W + 1 || j < -2 || j > H + 1) break;
    }
    return out;
  }

  function classifyCell(o, d, x, y, scene, tlo, thi, sourcePixel) {
    const W = scene.width;
    const idx = y * W + x;
    const base = { pixel: [x, y] };
    if (sourcePixel && sourcePixel[0] === x && sourcePixel[1] === y) {
      return Object.assign(base, { status: "source-skip" });
    }
    const depth = scene.depth[idx];
    if (depth === null || depth === undefined) {
      return Object.assign(base, { status: "empty-depth" });
    }
    const n = scene.normal[idx];
    const nd = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    if (nd >= 0) {
      return Object.assign(base, { status: "backface", nDotD: nd });
    }
    const iv = cellInterval(o, d, x, y, scene.camera, depth,
      scene.thickness, tlo, thi);
    if (iv !== null) {
      return Object.assign(base, { status: "candidate", enter: iv.enter, exit: iv.exit });
    }
    const cone = coneInterval(o, d, x, y, scene.camera, tlo, thi);
    if (cone !== null) {
      return Object.assign(base, { status: "graze", coneEnter: cone.enter, coneExit: cone.exit });
    }
    return Object.assign(base, { status: "miss" });
  }

  function decideReason(cells, tags, walkedEmpty) {
    const factors = new Set();
    if (tags) {
      if (tags.hi !== "maxDistance") factors.add(tags.hi);
      if (tags.lo !== "epsilon") factors.add("enter-" + tags.lo);
    }
    for (const c of cells) factors.add(c.status);
    // No cell walked: the ray-level clip is the whole explanation.
    if (walkedEmpty) {
      const primary = tags && (tags.hi === "near" || tags.hi === "far") ? tags.hi : "off-screen";
      return { primary, factors: [...new Set([...factors, primary])] };
    }
    const statuses = new Set(cells.map((c) => c.status));
    const nonSource = new Set([...statuses].filter((s) => s !== "source-skip"));
    // With walked cells, cell-level geometry explains the miss; clipping
    // bounds stay visible as factors.
    let primary;
    if (nonSource.size === 0) primary = "source-only";
    else if (onlyHas(nonSource, "empty-depth")) primary = "empty-depth";
    else if (onlyHas(nonSource, "graze")) primary = "graze";
    else if (subsetOf(nonSource, ["backface", "graze"])) primary = "backface";
    else if (subsetOf(nonSource, ["graze", "empty-depth"])) primary = "graze";
    else if (subsetOf(nonSource, ["backface", "graze", "empty-depth"])) primary = "backface";
    else if (tags && tags.hi === "near") primary = "near";
    else if (tags && tags.hi === "far") primary = "far";
    else if (tags && tags.hi === "screen") primary = "off-screen";
    else primary = "max-distance";
    return { primary, factors: [...factors] };
  }

  function onlyHas(set, value) {
    return set.size === 1 && set.has(value);
  }
  function subsetOf(set, values) {
    for (const s of set) if (!values.includes(s)) return false;
    return true;
  }

  // mode: "dda" walks only projected cells; "exhaustive" tests every cell.
  function trace(scene, ray, mode) {
    const W = scene.width, H = scene.height;
    const norm = normalize(ray.direction);
    if (norm.len === 0) {
      return { id: ray.id, reason: "bad-direction", reasonFactors: ["bad-direction"],
        directionLength: 0,
        candidates: [], cells: [], hit: null, span: null, spanTags: null };
    }
    const d = norm.dir;
    const o = ray.origin;
    const clip = clipSpan(o, d, scene.camera, W, H, scene.epsilon, scene.maxDistance);
    if (clip.fail) {
      return { id: ray.id, reason: clip.fail, reasonFactors: [clip.fail],
        candidates: [], cells: [],
        hit: null, span: null, spanTags: null,
        directionLength: norm.len, normalizedDirection: d };
    }
    const { span, tags } = clip;
    let walked;
    if (mode === "exhaustive") {
      walked = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cone = coneInterval(o, d, x, y, scene.camera, span.lo, span.hi);
          if (cone !== null) walked.push({ x, y, enter: cone.enter, exit: cone.exit });
        }
      }
    } else {
      walked = ddaCells(o, d, span.lo, span.hi, scene.camera, W, H);
    }
    const cells = walked.map((w) =>
      classifyCell(o, d, w.x, w.y, scene, span.lo, span.hi, ray.sourcePixel));
    const candidates = cells
      .filter((c) => c.status === "candidate")
      .sort((a, b) => (a.enter - b.enter) ||
        (a.pixel[1] - b.pixel[1]) || (a.pixel[0] - b.pixel[0]));
    const result = {
      id: ray.id, reason: null, candidates, cells,
      span: [span.lo, span.hi], spanTags: tags,
      directionLength: norm.len, normalizedDirection: d,
      walkedCount: walked.length,
    };
    if (candidates.length) {
      result.hit = { pixel: candidates[0].pixel,
        enter: candidates[0].enter, exit: candidates[0].exit };
      result.reason = "hit";
      result.reasonFactors = ["hit"];
    } else {
      result.hit = null;
      const decision = decideReason(cells, tags, walked.length === 0);
      result.reason = decision.primary;
      result.reasonFactors = decision.factors;
    }
    return result;
  }

  // Reflection ray from a clicked source pixel, per package convention.
  function reflectionFromPixel(scene, x, y) {
    const W = scene.width;
    const idx = y * W + x;
    const depth = scene.depth[idx];
    const issues = [];
    if (depth === null || depth === undefined) {
      return { error: "empty-depth", message: "源格没有深度，无法反投影" };
    }
    const { fx, fy, cx, cy } = scene.camera;
    const u = x + 0.5, v = y + 0.5;
    const z = depth;
    const ox = (u - cx) * z / fx;
    const oy = (cy - v) * z / fy;
    const origin = [ox, oy, z];
    const incident = normalize(origin).dir;
    const n = scene.normal[idx];
    const dot = incident[0] * n[0] + incident[1] * n[1] + incident[2] * n[2];
    // reflect incident vector about the surface normal
    const reflected = [
      incident[0] - 2 * dot * n[0],
      incident[1] - 2 * dot * n[1],
      incident[2] - 2 * dot * n[2],
    ];
    if (dot >= 0) issues.push("源法线未朝向相机（入射·法线 ≥ 0），反射方向仅供参考");
    return {
      ray: {
        id: `refl-${x}-${y}`,
        origin,
        direction: reflected,
        sourcePixel: [x, y],
      },
      incident, normal: n, dot, issues,
    };
  }

  function projectPoint(p, cam) {
    return [cam.fx * p[0] / p[2] + cam.cx, cam.cy - cam.fy * p[1] / p[2]];
  }

  const api = {
    trace, normalize, reflectionFromPixel, projectPoint, projectAt,
    ddaCells, coneInterval, cellInterval, clipSpan, EPS_LEN,
  };
  global.Tracer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
