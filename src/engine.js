// Homogeneous rasterization engine — pure computation, no DOM / graphics API.
// Pipeline: six-plane Sutherland-Hodgman clipping -> fan triangulation ->
// pixel-center edge-function coverage with top-left rule -> perspective
// correct color, z/w depth, strict-less depth test.
//
// Runs unchanged in the browser (ES module) and under Node for verification.

export const EPS_W = 1e-12;
const EPS_AREA = 1e-12;

// Six clip planes: -w<=x<=w, -w<=y<=w, 0<=z<=w.
// Each entry returns a signed distance that is >= 0 exactly when inside.
const PLANE_FNS = [
  (v) => v.x[3] + v.x[0], // left:   w + x
  (v) => v.x[3] - v.x[0], // right:  w - x
  (v) => v.x[3] + v.x[1], // bottom: w + y
  (v) => v.x[3] - v.x[1], // top:    w - y
  (v) => v.x[2],          // near:   z
  (v) => v.x[3] - v.x[2], // far:    w - z
];
export const PLANE_NAMES = ["left", "right", "bottom", "top", "near", "far"];

function makeVertex(x, rgb) {
  return { x: x.slice(), rgb: rgb.slice() };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function interpolateVertex(a, b, t) {
  return {
    x: [0, 1, 2, 3].map((k) => lerp(a.x[k], b.x[k], t)),
    rgb: [0, 1, 2].map((k) => lerp(a.rgb[k], b.rgb[k], t)),
  };
}

// Sutherland-Hodgman clipping of one polygon against all six planes.
// Input/output are arrays of {x:[x,y,z,w], rgb:[r,g,b]}.
export function clipPolygon(polyIn) {
  let poly = polyIn;
  for (const dist of PLANE_FNS) {
    if (poly.length === 0) break;
    const out = [];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const cur = poly[i];
      const prev = poly[(i - 1 + n) % n];
      const dc = dist(cur);
      const dp = dist(prev);
      const curIn = dc >= 0;
      const prevIn = dp >= 0;
      if (curIn) {
        if (!prevIn) {
          const t = dp / (dp - dc);
          out.push(interpolateVertex(prev, cur, t));
        }
        out.push(cur);
      } else if (prevIn) {
        const t = dp / (dp - dc);
        out.push(interpolateVertex(prev, cur, t));
      }
    }
    poly = out;
  }
  return poly;
}

function screenProject(v, width, height) {
  const w = v.x[3];
  return {
    sx: (v.x[0] / w + 1) * width * 0.5,
    sy: (1 - v.x[1] / w) * height * 0.5,
    z: v.x[2],
    w,
    rgb: v.rgb,
    clip: v.x,
  };
}

const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

// One rasterization run.
// scene: {width, height, vertices:[{x,rgb}], triangles:[[i,j,k], ...]}
// opts:  { signal:{cancelled:boolean}, onProgress(0..1), yieldEvery }
// Returns framebuffers, per-face clipped geometry and statistics.
// The only async points are cooperative yields between faces, so a
// cancellation signal takes effect within at most one face of work.
export async function rasterizeScene(scene, opts = {}) {
  const signal = opts.signal || { cancelled: false };
  const onProgress = opts.onProgress || (() => {});
  const yieldEvery = opts.yieldEvery ?? 64;

  const width = scene.width | 0;
  const height = scene.height | 0;
  const npix = width * height;

  const faceBuffer = new Int32Array(npix).fill(-1);
  const depthBuffer = new Float64Array(npix).fill(Infinity);
  const rgbR = new Float64Array(npix);
  const rgbG = new Float64Array(npix);
  const rgbB = new Float64Array(npix);
  const coverage = new Uint32Array(npix); // fragments passing edge tests
  const writes = new Uint32Array(npix); // actual framebuffer writes

  // Inspector data (compact; the full per-pixel detail is derived on click).
  const detailFace = new Int32Array(npix).fill(-1);
  const detailBary = new Float64Array(npix * 3);

  const stats = {
    totalFaces: scene.triangles.length,
    invalidFaces: 0,
    degenerateFaces: 0,
    clippedFaces: 0,
    drawnFaces: 0,
    emittedTriangles: 0,
    coveredPixels: 0,
    depthRejected: 0,
    multiCoveredPixels: 0,
  };

  const faceRecords = new Array(scene.triangles.length);
  const total = scene.triangles.length;

  for (let faceId = 0; faceId < total; faceId++) {
    if (signal.cancelled) {
      const error = new Error("cancelled");
      error.cancelled = true;
      throw error;
    }
    runOneFace(faceId);
    if (faceId % yieldEvery === 0) {
      onProgress(faceId / total);
      await yieldToLoop();
    }
  }
  onProgress(1);

  let multi = 0;
  for (let i = 0; i < npix; i++) if (coverage[i] > 1) multi++;
  stats.multiCoveredPixels = multi;

  return {
    width,
    height,
    faceBuffer,
    depthBuffer,
    rgb: [rgbR, rgbG, rgbB],
    coverage,
    writes,
    detailFace,
    detailBary,
    faceRecords,
    stats,
  };

  function runOneFace(faceId) {
    const tri = scene.triangles[faceId];
    const rec = {
      faceId,
      valid: true,
      degenerate: false,
      clipped: false,
      original: null,
      clippedPoly: null,
      screenPoly: null,
      subTriangles: [],
    };
    faceRecords[faceId] = rec;

    if (
      !Array.isArray(tri) ||
      tri.length !== 3 ||
      tri.some(
        (idx) =>
          !Number.isInteger(idx) || idx < 0 || idx >= scene.vertices.length
      )
    ) {
      rec.valid = false;
      stats.invalidFaces++;
      return;
    }

    const original = tri.map((idx) =>
      makeVertex(scene.vertices[idx].x, scene.vertices[idx].rgb)
    );
    rec.original = original;
    const clipped = clipPolygon(
      original.map((v) => makeVertex(v.x, v.rgb))
    );
    rec.clippedPoly = clipped;

    if (clipped.length < 3 || clipped.some((v) => v.x[3] <= EPS_W)) {
      rec.degenerate = true;
      stats.degenerateFaces++;
      return;
    }

    // Fan triangulation of the convex clipped polygon.
    const screenTriangles = [];
    for (let k = 1; k < clipped.length - 1; k++) {
      const pts = [0, k, k + 1].map((vi) =>
        screenProject(clipped[vi], width, height)
      );
      let area =
        (pts[1].sx - pts[0].sx) * (pts[2].sy - pts[0].sy) -
        (pts[1].sy - pts[0].sy) * (pts[2].sx - pts[0].sx);
      if (Math.abs(area) <= EPS_AREA) continue; // zero-area fan slice
      if (area < 0) {
        const tmp = pts[1];
        pts[1] = pts[2];
        pts[2] = tmp;
        area = -area;
      }
      screenTriangles.push({ pts, area });
    }

    if (screenTriangles.length === 0) {
      rec.degenerate = true;
      stats.degenerateFaces++;
      return;
    }

    if (clipped.length !== 3) {
      rec.clipped = true;
      stats.clippedFaces++;
    }
    stats.drawnFaces++;
    rec.screenPoly = clipped.map((v) => screenProject(v, width, height));
    rec.subTriangles = screenTriangles;

    for (const { pts, area } of screenTriangles) {
      stats.emittedTriangles++;
      const [a, b, c] = pts;

      // Edge functions evaluated DIRECTLY in raw form at every sample:
      //   e = dx*(qy-p.sy) - dy*(qx-p.sx),  dx=q.sx-p.sx, dy=q.sy-p.sy
      // Sign and exact-zero are tested on the raw value (the 1/area scaling
      // for barycentric weights is applied only afterwards), so the result is
      // bit-faithful to the reference operation order and immune to the drift
      // that incremental accumulation would introduce at an e==0 edge.
      const invArea = 1 / area;
      const edgeDef = [
        { p: a, q: b, lamOf: 2 }, // edge ab  -> barycentric weight of c
        { p: b, q: c, lamOf: 0 }, // edge bc  -> weight of a
        { p: c, q: a, lamOf: 1 }, // edge ca  -> weight of b
      ];
      const edges = edgeDef.map(({ p, q, lamOf }) => {
        const dx = q.sx - p.sx;
        const dy = q.sy - p.sy;
        return {
          bx: p.sx,
          by: p.sy,
          dx,
          dy,
          include: dy < 0 || (dy === 0 && dx > 0), // top-left rule
          lamOf,
        };
      });

      let minX = Math.max(0, Math.floor(Math.min(a.sx, b.sx, c.sx)));
      let maxX = Math.min(width - 1, Math.ceil(Math.max(a.sx, b.sx, c.sx)));
      let minY = Math.max(0, Math.floor(Math.min(a.sy, b.sy, c.sy)));
      let maxY = Math.min(height - 1, Math.ceil(Math.max(a.sy, b.sy, c.sy)));

      // Per-vertex coefficients of the quantities that are linear on screen
      // because they are divided by w.
      const vAttr = [a, b, c].map((v) => ({
        iw: 1 / v.w,
        r: v.rgb[0] / v.w,
        g: v.rgb[1] / v.w,
        b: v.rgb[2] / v.w,
        z: v.z / v.w,
      }));
      const weightVertex = edges.map((e) => e.lamOf);

      for (let py = minY; py <= maxY; py++) {
        const qy = py + 0.5;
        const rowBase = py * width;
        for (let px = minX; px <= maxX; px++) {
          const qx = px + 0.5;
          const w = [0, 0, 0]; // barycentric weights indexed by vertex
          let inside = true;
          for (let ei = 0; ei < 3; ei++) {
            const ed = edges[ei];
            const e = ed.dx * (qy - ed.by) - ed.dy * (qx - ed.bx);
            if (e < 0 || (e === 0 && !ed.include)) {
              inside = false;
              break;
            }
            w[weightVertex[ei]] = e * invArea;
          }
          if (!inside) continue;

          // Barycentric weights of vertices a, b, c.
          const lamA = w[0];
          const lamB = w[1];
          const lamC = w[2];

          // Linear-on-screen accumulations.
          const iw =
            lamA * vAttr[0].iw + lamB * vAttr[1].iw + lamC * vAttr[2].iw;
          const lr =
            lamA * vAttr[0].r + lamB * vAttr[1].r + lamC * vAttr[2].r;
          const lg =
            lamA * vAttr[0].g + lamB * vAttr[1].g + lamC * vAttr[2].g;
          const lb =
            lamA * vAttr[0].b + lamB * vAttr[1].b + lamC * vAttr[2].b;
          const depth =
            lamA * vAttr[0].z + lamB * vAttr[1].z + lamC * vAttr[2].z;

          // Perspective-correct color: one division per covered pixel.
          const invIw = 1 / iw;
          const colR = lr * invIw;
          const colG = lg * invIw;
          const colB = lb * invIw;

          const idx = rowBase + px;
          coverage[idx]++;
          // Strict less-than: equal depth keeps the earlier submission.
          if (depth < depthBuffer[idx]) {
            if (depthBuffer[idx] === Infinity) {
              stats.coveredPixels++;
            } else {
              stats.depthRejected++;
            }
            depthBuffer[idx] = depth;
            faceBuffer[idx] = faceId;
            rgbR[idx] = colR;
            rgbG[idx] = colG;
            rgbB[idx] = colB;
            detailFace[idx] = faceId;
            detailBary[idx * 3] = lamA;
            detailBary[idx * 3 + 1] = lamB;
            detailBary[idx * 3 + 2] = lamC;
            writes[idx]++;
          }
        }
      }
    }
  }
}
