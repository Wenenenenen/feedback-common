/*
 * Nested Glass Ray Reel - self-contained analytic sphere tracer.
 * Classic UMD-ish file: works in a browser as window.NestedGlass and in Node/CJS.
 * No ray-tracing library is used.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.NestedGlass = api;
    root.GlassTracer = api; // convenient alias for console/automation
    root.traceRay = api.traceRay;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({
    spheres: 32,
    rays: 96 * 64,
    width: 96,
    height: 64,
    maxDepth: 10
  });

  const GEOM_TOL = 1e-10;       // scaled by scene magnitude; still far below 1e-6 clearance
  const SAME_HIT_EPS = 1e-8;    // only used to identify the t=0 root just traversed
  const TANGENT_DIST_EPS = 1e-9;
  const AIR = Object.freeze({ id: null, name: '空气', outside: true, n: 1, sigma: [0, 0, 0] });

  class SceneValidationError extends Error {
    constructor(message, details) {
      super(message);
      this.name = 'SceneValidationError';
      this.details = details || {};
      if (Error.captureStackTrace) Error.captureStackTrace(this, SceneValidationError);
    }
  }

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function v3(a, name) {
    if (!Array.isArray(a) || a.length < 3 || !a.slice(0, 3).every(isNum)) {
      throw new SceneValidationError(`${name} 必须是含 3 个有限数值的数组`);
    }
    return [a[0], a[1], a[2]];
  }

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mulV(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function mulVV(a, b) { return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]; }
  function norm2(a) { return dot(a, a); }
  function length3(a) { return Math.sqrt(Math.max(0, norm2(a))); }

  function normalize(a) {
    const l = length3(a);
    if (!Number.isFinite(l) || l === 0) return null;
    return [a[0] / l, a[1] / l, a[2] / l];
  }

  function mediumOfSphere(s) {
    return { id: s.id, name: `球 #${s.id}`, n: s.n, sigma: s.sigma.slice() };
  }

  function airMedium() {
    return { id: null, name: '空气', outside: true, n: 1, sigma: [0, 0, 0] };
  }

  function mediumRef(m) {
    return m ? { id: m.id, name: m.name, outside: !!m.outside, n: m.n, sigma: m.sigma.slice() } : airMedium();
  }

  function validateSphere(raw, index) {
    const where = `spheres[${index}]`;
    if (!raw || typeof raw !== 'object') throw new SceneValidationError(`${where} 必须是对象`);
    if (raw.id === undefined || raw.id === null || raw.id === '') {
      throw new SceneValidationError(`${where} 缺少 id`);
    }
    const c = v3(raw.c, `${where}.c`);
    const r = raw.r;
    const n = raw.n;
    if (!isNum(r) || r <= 0) throw new SceneValidationError(`球 ${raw.id} 的 r 必须为正数`);
    if (Math.abs(r) > 100) throw new SceneValidationError(`球 ${raw.id} 的半径绝对值不能超过 100`);
    if (c.some((x) => Math.abs(x) > 100)) throw new SceneValidationError(`球 ${raw.id} 的坐标绝对值不能超过 100`);
    if (!isNum(n) || n < 1 || n > 3) throw new SceneValidationError(`球 ${raw.id} 的 n 必须在 1..3`);

    let sigma = raw.sigma;
    if (sigma === undefined || sigma === null) sigma = [0, 0, 0];
    if (!Array.isArray(sigma) || sigma.length < 3) {
      throw new SceneValidationError(`球 ${raw.id} 的 sigma 必须是 RGB 三元素数组`);
    }
    sigma = sigma.slice(0, 3).map((x, k) => {
      if (!isNum(x) || x < 0 || x > 1e6) {
        throw new SceneValidationError(`球 ${raw.id} 的 sigma[${k}] 必须在 0..1000000`);
      }
      return x;
    });

    return {
      id: raw.id,
      c,
      r,
      r2: r * r,
      n,
      sigma,
      _index: index
    };
  }

  function pairRelation(a, b) {
    const dx = b.c[0] - a.c[0];
    const dy = b.c[1] - a.c[1];
    const dz = b.c[2] - a.c[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const big = a.r >= b.r ? a : b;
    const small = a.r >= b.r ? b : a;
    const scale = Math.max(1, d, a.r, b.r);
    const tol = GEOM_TOL * scale;

    const innerClearance = big.r - (d + small.r); // >0: strictly nested gap
    const outerClearance = d - (a.r + b.r);       // >0: separated gap

    let valid = false;
    let kind = 'intersection';
    let clearance = Math.min(innerClearance, outerClearance);

    if (innerClearance > tol) {
      valid = true;
      kind = 'nested';
      clearance = innerClearance;
    } else if (outerClearance > tol) {
      valid = true;
      kind = 'separated';
      clearance = outerClearance;
    } else if (Math.abs(innerClearance) <= tol) {
      kind = 'internal-contact';
      clearance = innerClearance;
    } else if (Math.abs(outerClearance) <= tol) {
      kind = 'external-contact';
      clearance = outerClearance;
    } else {
      kind = 'intersection';
      clearance = Math.max(innerClearance, outerClearance);
    }

    return {
      a: a.id,
      b: b.id,
      d,
      kind,
      valid,
      clearance,
      tolerance: tol
    };
  }

  function validateGeometry(spheres) {
    const conflicts = [];
    for (let i = 0; i < spheres.length; i++) {
      for (let j = i + 1; j < spheres.length; j++) {
        const rel = pairRelation(spheres[i], spheres[j]);
        if (!rel.valid) conflicts.push(rel);
      }
    }
    return conflicts;
  }

  function buildParents(spheres) {
    const byId = new Map(spheres.map((s) => [s.id, s]));
    const parent = new Map();
    for (const s of spheres) {
      let best = null;
      for (const p of spheres) {
        if (p.id === s.id || p.r <= s.r) continue;
        const d = length3(sub(s.c, p.c));
        // Valid input is strictly nested with positive clearance.
        if (d + s.r < p.r + GEOM_TOL * Math.max(1, d, p.r, s.r)) {
          if (!best || p.r < best.r) best = p;
        }
      }
      parent.set(s.id, best ? best.id : null);
    }
    return { parent, byId };
  }

  function mediumAt(point, spheres) {
    let inner = null;
    for (const s of spheres) {
      const d2 = norm2(sub(point, s.c));
      if (d2 < s.r2) {
        if (!inner || s.r < inner.r) inner = s;
      }
    }
    return inner ? mediumOfSphere(inner) : airMedium();
  }

  function normalizeRay(raw, index) {
    let o;
    let d;
    let id;
    let pixel;
    if (Array.isArray(raw) && raw.length >= 2) {
      o = v3(raw[0], `rays[${index}][0]`);
      d = v3(raw[1], `rays[${index}][1]`);
    } else if (raw && typeof raw === 'object') {
      o = v3(raw.origin || raw.o, `rays[${index}].origin`);
      d = v3(raw.direction || raw.d, `rays[${index}].direction`);
      id = raw.id;
      pixel = raw.pixel;
    } else {
      throw new SceneValidationError(`rays[${index}] 必须是 [origin, direction]`);
    }
    const dn = normalize(d);
    if (!dn) throw new SceneValidationError(`rays[${index}] 的方向不能为零向量`);
    return { id, pixel, origin: o, direction: dn, rawDirection: d };
  }

  function normalizeScene(raw) {
    if (!raw || typeof raw !== 'object') throw new SceneValidationError('JSON 顶层必须是对象');

    const rawSpheres = Array.isArray(raw.spheres) ? raw.spheres : [];
    if (rawSpheres.length > LIMITS.spheres) {
      throw new SceneValidationError(`球面数量 ${rawSpheres.length} 超过上限 ${LIMITS.spheres}`);
    }
    const spheres = rawSpheres.map(validateSphere);
    const ids = new Set();
    for (const s of spheres) {
      if (ids.has(s.id)) throw new SceneValidationError(`球面 id 重复：${String(s.id)}`);
      ids.add(s.id);
    }

    const conflicts = validateGeometry(spheres);
    if (conflicts.length) {
      const list = conflicts.map((x) => `#${x.a} 与 #${x.b}（${geometryKindLabel(x.kind)}）`).join('；');
      const err = new SceneValidationError(`球必须严格嵌套或分离：${list}`, { sphereConflicts: conflicts });
      err.sphereConflicts = conflicts;
      throw err;
    }

    let rays = Array.isArray(raw.rays) ? raw.rays : [];
    if (!rays.length) throw new SceneValidationError('rays 至少需要一条射线');
    if (rays.length > LIMITS.rays) {
      throw new SceneValidationError(`射线数量 ${rays.length} 超过上限 ${LIMITS.rays}`);
    }
    rays = rays.map(normalizeRay);

    let width = 0;
    let height = 1;
    if (Array.isArray(raw.size) && raw.size.length >= 2) {
      width = raw.size[0];
      height = raw.size[1];
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new SceneValidationError('size 必须是两个正整数 [width, height]');
      }
      if (width * height !== rays.length) {
        throw new SceneValidationError(`size=${width}×${height} 与 rays 数量 ${rays.length} 不一致`);
      }
    } else {
      width = rays.length;
      height = 1;
    }

    let background = Array.isArray(raw.background) ? raw.background.slice(0, 3) : [1, 1, 1];
    background = background.map((x, k) => {
      if (!isNum(x) || x < 0) throw new SceneValidationError(`background[${k}] 必须是非负有限数`);
      return x;
    });

    const depthInput = Number.isFinite(raw.depth) ? Math.round(raw.depth) : 4;
    const depth = clamp(depthInput, 0, LIMITS.maxDepth);
    const hierarchy = buildParents(spheres);

    return {
      format: raw.format,
      size: [width, height],
      width,
      height,
      depth,
      requestedDepth: depthInput,
      background,
      spheres,
      rays,
      parent: hierarchy.parent,
      byId: hierarchy.byId
    };
  }

  function geometryKindLabel(kind) {
    return ({
      nested: '严格嵌套',
      separated: '分离',
      intersection: '相交',
      'external-contact': '外切/接触',
      'internal-contact': '内切/接触'
    })[kind] || kind;
  }

  function sphereRoots(o, d, s) {
    const oc = sub(o, s.c);
    const b = dot(oc, d);
    const cc = norm2(oc) - s.r2;
    const disc = b * b - cc;
    const scale = Math.max(1, Math.abs(b * b), Math.abs(cc), s.r2);
    // Tangency band in discriminant units. The relative term catches floating
    // cancellation; 1e-9 world-distance term handles rounded tangent inputs.
    const discTol = 2 * s.r * TANGENT_DIST_EPS + TANGENT_DIST_EPS * TANGENT_DIST_EPS + 1e-12 * scale;
    if (disc <= discTol) return { tangent: disc >= -discTol, miss: disc < -discTol, disc, b, cc };
    const sq = Math.sqrt(disc);
    return { roots: [-b - sq, -b + sq], disc, b, cc };
  }

  function nearestHit(o, d, spheres, lastSphereId) {
    let best = null;

    for (const s of spheres) {
      const solved = sphereRoots(o, d, s);
      if (!solved.roots) continue;
      let roots = solved.roots.slice();

      // The child ray starts exactly at the previous interface. Remove only
      // the t≈0 root belonging to that same intersection; keep the other root,
      // even when the next layer is only 1e-6 world units thick.
      if (s.id === lastSphereId && roots.length === 2) {
        const zeroIndex = Math.abs(roots[0]) <= Math.abs(roots[1]) ? 0 : 1;
        if (Math.abs(roots[zeroIndex]) <= SAME_HIT_EPS) roots.splice(zeroIndex, 1);
      }

      for (const rawT of roots) {
        if (!Number.isFinite(rawT) || rawT <= 0) continue;
        if (best === null || rawT < best.t || (rawT === best.t && String(s.id) < String(best.sphere.id))) {
          const rawPoint = add(o, mulV(d, rawT));
          let gn = normalize(sub(rawPoint, s.c));
          if (!gn) gn = [1, 0, 0];
          // Snap to the analytic sphere without moving along the ray. This is
          // radial projection to the boundary, not a directional nudge.
          const point = add(s.c, mulV(gn, s.r));
          const geomNormal = normalize(sub(point, s.c)) || gn;
          const nd = dot(geomNormal, d);
          const entering = nd < 0;
          const normal = entering ? geomNormal.slice() : [-geomNormal[0], -geomNormal[1], -geomNormal[2]];
          const cosI = clamp(-dot(normal, d), 0, 1);

          best = {
            t: rawT,
            sphere: s,
            sphereId: s.id,
            point,
            geometricNormal: geomNormal,
            normal,
            entering,
            cosI
          };
        }
      }
    }

    return best;
  }

  function fresnel(cosI, nIn, nOut) {
    if (nIn === nOut) return { F: 0, eta: 1, sinT2: 0, cosT: 1, tir: false };
    const eta = nIn / nOut;
    const sinT2 = eta * eta * (1 - cosI * cosI);
    if (sinT2 > 1 + 1e-10) {
      return { F: 1, eta, sinT2, cosT: 0, tir: true };
    }
    const cosT = Math.sqrt(Math.max(0, 1 - Math.min(1, sinT2)));
    const rsNum = nIn * cosI - nOut * cosT;
    const rsDen = nIn * cosI + nOut * cosT;
    const rpNum = nOut * cosI - nIn * cosT;
    const rpDen = nOut * cosI + nIn * cosT;
    let rs = rsDen === 0 ? 1 : (rsNum / rsDen) ** 2;
    let rp = rpDen === 0 ? 1 : (rpNum / rpDen) ** 2;
    if (!Number.isFinite(rs)) rs = 1;
    if (!Number.isFinite(rp)) rp = 1;
    const F = clamp(0.5 * (rs + rp), 0, 1);
    return { F, eta, sinT2, cosT, tir: sinT2 > 1 };
  }

  function reflectDirection(d, n) {
    const k = dot(d, n);
    return normalize([
      d[0] - 2 * k * n[0],
      d[1] - 2 * k * n[1],
      d[2] - 2 * k * n[2]
    ]);
  }

  function refractDirection(d, n, eta, cosI, cosT) {
    const k = eta * cosI - cosT;
    const t = [
      eta * d[0] + k * n[0],
      eta * d[1] + k * n[1],
      eta * d[2] + k * n[2]
    ];
    return normalize(t);
  }

  function isZeroWeight(w) {
    return w[0] === 0 && w[1] === 0 && w[2] === 0;
  }

  function quantizeRgb(rgb) {
    return rgb.map((x) => Math.round(255 * clamp(x, 0, 1)));
  }

  function traceRay(scene, rayInput, maxDepth, options) {
    const opts = options || {};
    const detail = opts.detail !== false;
    const depthLimit = Number.isInteger(maxDepth) ? clamp(maxDepth, 0, LIMITS.maxDepth) : scene.depth;
    const ray = rayInput && rayInput.direction ? rayInput : normalizeRay(rayInput, 0);
    const spheres = scene.spheres;
    const background = scene.background;
    const parentMap = scene.parent || buildParents(spheres).parent;

    const rgb = [0, 0, 0];
    const residual = [0, 0, 0];
    const residualArrived = [0, 0, 0];
    const branches = [];
    const stats = {
      nodes: 0,
      events: 0,
      reflections: 0,
      transmissions: 0,
      tir: 0,
      escapes: 0,
      residualBranches: 0,
      zeroBranches: 0
    };

    function mediumAfterHit(hit, currentMedium) {
      if (hit.entering) return mediumOfSphere(hit.sphere);
      const pid = parentMap.get(hit.sphere.id);
      const p = pid === null || pid === undefined ? null : scene.byId ? scene.byId.get(pid) : spheres.find((s) => s.id === pid);
      return p ? mediumOfSphere(p) : airMedium();
    }

    function startBranch(kind, parentId, id, start, direction, medium, startWeight, usedEvents, scalarWeight, lastSphereId) {
      stats.nodes++;
      const node = detail ? {
        id,
        parent: parentId,
        order: kind,
        kind,
        start: start.slice(),
        origin: start.slice(),
        direction: direction.slice(),
        d: direction.slice(),
        medium: mediumRef(medium),
        mediumIn: mediumRef(medium),
        inMedium: mediumRef(medium),
        startWeight: startWeight.slice(),
        weight: startWeight.slice(),
        weightRgb: startWeight.slice(),
        scalarWeight,
        eventDepth: usedEvents,
        depth: usedEvents,
        lastSphereId: lastSphereId === undefined ? null : lastSphereId,
        hit: null,
        t: null,
        distance: null,
        end: null,
        endPoint: null,
        attenuation: [1, 1, 1],
        endWeight: startWeight.slice(),
        weightAtEnd: startWeight.slice(),
        outcome: 'pending',
        event: null,
        children: []
      } : null;

      const hit = nearestHit(start, direction, spheres, lastSphereId);
      let attenuation = [1, 1, 1];
      let endWeight = startWeight.slice();

      if (hit) {
        attenuation = medium.sigma.map((sigma) => Math.exp(-sigma * hit.t));
        endWeight = mulVV(startWeight, attenuation);
        if (node) {
          node.hit = serializeHit(hit);
          node.t = hit.t;
          node.distance = hit.t;
          node.end = hit.point.slice();
          node.endPoint = hit.point.slice();
          node.attenuation = attenuation.slice();
          node.endWeight = endWeight.slice();
          node.weightAtEnd = endWeight.slice();
          node.sphereId = hit.sphereId;
          node.sphere = hit.sphereId;
          node.eventSphere = hit.sphereId;
        }
      }

      if (!hit) {
        // Outside/in non-absorbing background medium in every valid finite scene.
        const contribution = mulVV(startWeight, background);
        for (let k = 0; k < 3; k++) rgb[k] += contribution[k];
        stats.escapes++;
        if (node) {
          node.outcome = 'escape';
          node.escaped = true;
          node.escapeContribution = contribution;
          node.contribution = contribution;
          node.end = null;
          branches.push(compactBranch(node));
        }
        return node;
      }

      if (usedEvents >= depthLimit) {
        // Contract: budget exhausted with a next hit => keep the ORIGINAL
        // branch weight as residual and do not propagate through that candidate
        // segment. endWeight is retained only as a diagnostic "if propagated"
        // value after medium attenuation.
        for (let k = 0; k < 3; k++) {
          residual[k] += startWeight[k];
          residualArrived[k] += endWeight[k];
        }
        stats.residualBranches++;
        if (node) {
          node.outcome = 'residual';
          node.propagated = false;
          node.residual = startWeight.slice();
          node.originalResidual = startWeight.slice();
          node.residualAtStart = startWeight.slice();
          node.remainder = startWeight.slice();
          node.residualArrived = endWeight.slice();
          node.residualAfterAttenuation = endWeight.slice();
          node.hypotheticalEndWeight = endWeight.slice();
          node.pendingHit = serializeHit(hit);
          node.candidateT = hit.t;
          node.candidateEnd = hit.point.slice();
          node.candidateAttenuation = attenuation.slice();
          node.reason = 'depth-budget-exhausted-original-weight-retained';
          branches.push(compactBranch(node));
        }
        return node;
      }

      const outMedium = mediumAfterHit(hit, medium);
      const fr = fresnel(hit.cosI, medium.n, outMedium.n);
      stats.events++;
      if (fr.tir) stats.tir++;

      const reflectionFactor = fr.tir ? 1 : fr.F;
      const transmissionFactor = fr.tir ? 0 : 1 - fr.F;
      const reflectionDirection = reflectDirection(direction, hit.normal);
      const transmissionDirection = fr.tir ? null : refractDirection(direction, hit.normal, fr.eta, hit.cosI, fr.cosT);

      const eventInfo = {
        sphereId: hit.sphereId,
        sphere: hit.sphereId,
        eventSphere: hit.sphereId,
        t: hit.t,
        point: hit.point.slice(),
        normal: hit.normal.slice(),
        geometricNormal: hit.geometricNormal.slice(),
        entering: hit.entering,
        cosI: hit.cosI,
        cosT: fr.cosT,
        eta: fr.eta,
        sinT2: fr.sinT2,
        fresnel: fr.F,
        F: fr.F,
        tir: fr.tir,
        mediumIn: mediumRef(medium),
        inMedium: mediumRef(medium),
        mediumOut: mediumRef(outMedium),
        outMedium: mediumRef(outMedium),
        inId: medium.id,
        outId: outMedium.id,
        reflection: { factor: reflectionFactor, weight: mulV(endWeight, reflectionFactor) },
        transmission: fr.tir ? null : { factor: transmissionFactor, weight: mulV(endWeight, transmissionFactor) }
      };

      if (node) {
        node.outcome = 'event';
        node.event = eventInfo;
        node.mediumOut = mediumRef(outMedium);
        node.outMedium = mediumRef(outMedium);
        node.fresnel = fr.F;
        node.F = fr.F;
        node.tir = fr.tir;
        branches.push(compactBranch(node));
      }

      // R is always created before T in traversal/export ordering.
      const rWeight = mulV(endWeight, reflectionFactor);
      if (reflectionFactor !== 0 && !isZeroWeight(rWeight) && reflectionDirection) {
        stats.reflections++;
        const child = startBranch(
          'R', id, `${id}.R`,
          hit.point, reflectionDirection, mediumRef(medium),
          rWeight, usedEvents + 1, scalarWeight * reflectionFactor,
          hit.sphereId
        );
        if (node && child) node.children.push(child);
      } else {
        stats.zeroBranches++;
      }

      if (!fr.tir && transmissionFactor !== 0 && transmissionDirection) {
        const tWeight = mulV(endWeight, transmissionFactor);
        if (!isZeroWeight(tWeight)) {
          stats.transmissions++;
          const child = startBranch(
            'T', id, `${id}.T`,
            hit.point, transmissionDirection, mediumRef(outMedium),
            tWeight, usedEvents + 1, scalarWeight * transmissionFactor,
            hit.sphereId
          );
          if (node && child) node.children.push(child);
        } else {
          stats.zeroBranches++;
        }
      } else if (!fr.tir) {
        stats.zeroBranches++;
      }

      if (node && node.children.length === 0 && node.outcome === 'event') {
        node.outcome = 'zero';
        node.reason = 'all-child-weights-zero';
        const last = branches[branches.length - 1];
        if (last && last.id === node.id) {
          last.outcome = 'zero';
          last.reason = node.reason;
        }
      }
      return node;
    }

    const rootMedium = mediumAt(ray.origin, spheres);
    const tree = startBranch(
      'root', null, '0',
      ray.origin, ray.direction, rootMedium,
      [1, 1, 1], 0, 1,
      null
    );

    const rgb255 = quantizeRgb(rgb);
    const residual255Like = quantizeRgb(residual);
    return {
      rayIndex: opts.rayIndex,
      pixel: opts.pixel,
      id: ray.id,
      origin: ray.origin.slice(),
      o: ray.origin.slice(),
      direction: ray.direction.slice(),
      d: ray.direction.slice(),
      depth: depthLimit,
      rgb,
      unquantizedRgb: rgb,
      color: rgb,
      residual,
      remainder: residual,
      leftover: residual,
      originalResidual: residual,
      residualAtStart: residual,
      residualArrived,
      residualAfterAttenuation: residualArrived,
      residualDisplay: residual255Like,
      rgb255,
      quantized: rgb255,
      outputRgb: rgb255,
      stats,
      branches: detail ? branches : [],
      tree: detail ? tree : undefined
    };
  }

  function serializeHit(hit) {
    return {
      t: hit.t,
      distance: hit.t,
      point: hit.point.slice(),
      end: hit.point.slice(),
      sphereId: hit.sphereId,
      sphere: hit.sphereId,
      eventSphere: hit.sphereId,
      normal: hit.normal.slice(),
      geometricNormal: hit.geometricNormal.slice(),
      entering: hit.entering,
      cosI: hit.cosI
    };
  }

  function compactBranch(node) {
    const event = node.event;
    return {
      id: node.id,
      parent: node.parent,
      order: node.order,
      kind: node.kind,
      start: node.start,
      end: node.end,
      origin: node.start,
      direction: node.direction,
      t: node.t,
      distance: node.distance,
      sphereId: node.sphereId === undefined ? null : node.sphereId,
      sphere: node.sphere === undefined ? null : node.sphere,
      eventSphere: node.eventSphere === undefined ? null : node.eventSphere,
      medium: node.medium,
      mediumIn: event ? event.mediumIn : node.medium,
      inMedium: event ? event.inMedium : node.inMedium,
      mediumOut: event ? event.mediumOut : null,
      outMedium: event ? event.outMedium : null,
      inId: event ? event.inId : node.medium.id,
      outId: event ? event.outId : null,
      weight: node.weight,
      startWeight: node.startWeight,
      endWeight: node.endWeight,
      weightAtEnd: node.weightAtEnd,
      scalarWeight: node.scalarWeight,
      attenuation: node.attenuation,
      outcome: node.outcome,
      propagated: node.propagated === undefined ? true : node.propagated,
      residual: node.residual || null,
      originalResidual: node.originalResidual || node.residual || null,
      residualAtStart: node.residualAtStart || node.residual || null,
      residualArrived: node.residualArrived || null,
      residualAfterAttenuation: node.residualAfterAttenuation || null,
      pendingHit: node.pendingHit || null,
      candidateT: node.candidateT === undefined ? null : node.candidateT,
      candidateEnd: node.candidateEnd || null,
      candidateAttenuation: node.candidateAttenuation || null,
      reason: node.reason || null,
      escapeContribution: node.escapeContribution || null,
      fresnel: event ? event.fresnel : null,
      F: event ? event.F : null,
      tir: event ? event.tir : false,
      cosI: event ? event.cosI : null,
      cosT: event ? event.cosT : null,
      eta: event ? event.eta : null,
      entering: event ? event.entering : null,
      event
    };
  }

  function renderImageData(scene, depth) {
    const width = scene.width;
    const height = scene.height;
    const data = new Uint8ClampedArray(width * height * 4);
    const results = new Array(scene.rays.length);
    for (let i = 0; i < scene.rays.length; i++) {
      const pixel = [i % width, Math.floor(i / width)];
      const result = traceRay(scene, scene.rays[i], depth, { detail: false, rayIndex: i, pixel });
      results[i] = result;
      const q = result.rgb255;
      const k = i * 4;
      data[k] = q[0];
      data[k + 1] = q[1];
      data[k + 2] = q[2];
      data[k + 3] = 255;
    }
    return { width, height, data, results };
  }

  function buildExport(scene, options) {
    const opts = options || {};
    const depth = Number.isInteger(opts.depth) ? clamp(opts.depth, 0, LIMITS.maxDepth) : scene.depth;
    const width = scene.width;
    const rayIndices = opts.rayIndices || scene.rays.map((_, i) => i);
    const rays = [];

    for (const rayIndex of rayIndices) {
      const sourceRay = scene.rays[rayIndex];
      if (!sourceRay) continue;
      const pixel = [rayIndex % width, Math.floor(rayIndex / width)];
      const result = traceRay(scene, sourceRay, depth, {
        detail: true,
        rayIndex,
        pixel
      });
      rays.push(serializeTraceForExport(result, opts.includeTree !== false));
    }

    const totalRgb = [0, 0, 0];
    const totalResidual = [0, 0, 0];
    let totalResidualBranches = 0;
    for (const ray of rays) {
      for (let k = 0; k < 3; k++) {
        totalRgb[k] += ray.rgb[k];
        totalResidual[k] += ray.residual[k];
      }
      totalResidualBranches += ray.stats.residualBranches;
    }

    return {
      schema: 'nested-glass-light-paths/v1',
      app: 'nested-glass-ray-reel',
      exportedAt: new Date().toISOString(),
      sourceFile: opts.sourceFile || null,
      size: scene.size,
      depth,
      maxDepth: LIMITS.maxDepth,
      background: scene.background,
      limits: LIMITS,
      counts: {
        spheres: scene.spheres.length,
        rays: rays.length,
        sourceRays: scene.rays.length
      },
      summary: {
        rgb: totalRgb,
        residual: totalResidual,
        residualBranches: totalResidualBranches
      },
      // Explicit column-style conveniences in addition to rays[].
      residuals: rays.map((ray) => ({ rayIndex: ray.rayIndex, pixel: ray.pixel, residual: ray.residual })),
      pixels: rays.map((ray) => ({ rayIndex: ray.rayIndex, pixel: ray.pixel, rgb: ray.rgb, rgb255: ray.rgb255 })),
      spheres: scene.spheres.map((s) => ({ id: s.id, c: s.c, r: s.r, n: s.n, sigma: s.sigma, parent: scene.parent.get(s.id) ?? null })),
      rays,
      results: rays
    };
  }

  function serializeTraceForExport(result, includeTree) {
    const out = {
      rayIndex: result.rayIndex,
      pixel: result.pixel,
      id: result.id,
      origin: result.origin,
      direction: result.direction,
      depth: result.depth,
      rgb: result.rgb,
      unquantizedRgb: result.unquantizedRgb,
      residual: result.residual,
      residualAtStart: result.residualAtStart,
      originalResidual: result.originalResidual,
      residualArrived: result.residualArrived,
      residualAfterAttenuation: result.residualAfterAttenuation,
      remainder: result.remainder,
      rgb255: result.rgb255,
      quantized: result.quantized,
      outputRgb: result.outputRgb,
      stats: result.stats,
      branches: result.branches
    };
    if (includeTree) out.tree = result.tree;
    return out;
  }

  function downloadJsonValue(value, filename) {
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
      throw new Error('downloadJsonValue is browser-only');
    }
    const text = JSON.stringify(value, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    LIMITS,
    AIR,
    SceneValidationError,
    clamp,
    dot,
    sub,
    add,
    mulV,
    mulVV,
    normalize,
    length3,
    normalizeScene,
    validateScene: normalizeScene,
    validateGeometry,
    pairRelation,
    geometryKindLabel,
    mediumAt,
    nearestHit,
    fresnel,
    reflectDirection,
    refractDirection,
    traceRay,
    trace: traceRay,
    traceAll: renderImageData,
    renderImageData,
    buildExport,
    quantizeRgb,
    downloadJsonValue
  };
});
