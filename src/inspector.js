// Per-pixel inspector: re-derives every interpolation quantity for the face
// that owns a pixel, independently of the stored framebuffer values, so the
// panel can show exactly how the final numbers were produced.
import { EPS_W } from "./engine.js";

function project(v, width, height) {
  const w = v.x[3];
  return {
    sx: (v.x[0] / w + 1) * width * 0.5,
    sy: (1 - v.x[1] / w) * height * 0.5,
    z: v.x[2],
    w,
    rgb: v.rgb,
    clip: v.x.slice(),
  };
}

// Locate the winning sub-triangle for the sample (px+0.5, py+0.5) and return
// the full derivation. Returns null-ish records for invalid/degenerate faces.
export function inspectPixel(result, scene, px, py) {
  const { width, height } = result;
  const idx = py * width + px;
  const faceId = result.faceBuffer[idx];
  if (faceId < 0) {
    return { covered: false, px, py, faceId: -1 };
  }
  const rec = result.faceRecords[faceId];
  const qx = px + 0.5;
  const qy = py + 0.5;

  let hit = null;
  for (const { pts, area } of rec.subTriangles) {
    const [a, b, c] = pts;
    const edgeDef = [
      { p: a, q: b, lamOf: 2 },
      { p: b, q: c, lamOf: 0 },
      { p: c, q: a, lamOf: 1 },
    ];
    const edges = edgeDef.map(({ p, q, lamOf }) => {
      const dx = q.sx - p.sx;
      const dy = q.sy - p.sy;
      return {
        p,
        dx,
        dy,
        include: dy < 0 || (dy === 0 && dx > 0),
        lamOf,
      };
    });
    const weight = [0, 0, 0];
    const edgeInfo = [];
    let inside = true;
    for (const ed of edges) {
      const e = ed.dx * (qy - ed.p.sy) - ed.dy * (qx - ed.p.sx);
      const onEdge = e === 0;
      if (e < 0 || (onEdge && !ed.include)) {
        inside = false;
        break;
      }
      edgeInfo.push({ e, onEdge, included: true });
      weight[ed.lamOf] = e / area;
    }
    if (inside) {
      hit = { pts: [a, b, c], area, weight, edgeInfo };
      break;
    }
  }

  if (!hit) {
    return { covered: true, px, py, faceId, rec, derivation: null };
  }

  const pts = hit.pts;
  const [lamA, lamB, lamC] = hit.weight;
  const lambdas = [lamA, lamB, lamC];

  // One term per clipped sub-triangle vertex, exposing every intermediate.
  const terms = pts.map((v, i) => ({
    lambda: lambdas[i],
    w: v.w,
    z: v.z,
    rgb: v.rgb.slice(),
    clip: v.clip.slice(),
    screen: [v.sx, v.sy],
    lambdaOverW: lambdas[i] / v.w,
    rgbOverW: v.rgb.map((ch) => ch / v.w),
    zOverW: v.z / v.w,
  }));

  const sumLambdaOverW = terms.reduce((s, t) => s + t.lambdaOverW, 0);
  const colorNumerator = [0, 1, 2].map((ch) =>
    terms.reduce((s, t) => s + t.lambdaOverW * t.rgb[ch], 0)
  );
  const color = colorNumerator.map((n) => n / sumLambdaOverW);
  // depth = sum(lambda * z / w); no perspective divide (already z/w space).
  const depth = terms.reduce((s, t) => s + t.lambda * t.zOverW, 0);

  return {
    covered: true,
    px,
    py,
    sample: [qx, qy],
    faceId,
    rec,
    storedDepth: result.depthBuffer[idx],
    storedRgb: [result.rgb[0][idx], result.rgb[1][idx], result.rgb[2][idx]],
    coverage: result.coverage[idx],
    writes: result.writes[idx],
    derivation: {
      area: hit.area,
      edges: hit.edgeInfo,
      barycentric: { a: lamA, b: lamB, c: lamC },
      barySum: lamA + lamB + lamC,
      terms,
      sumLambdaOverW,
      colorNumerator,
      color,
      depth,
    },
  };
}

// Screen-space projection of a face's clipped polygon for wireframe overlays.
export function screenPolygonOf(rec, width, height) {
  if (!rec || !rec.clippedPoly) return null;
  return rec.clippedPoly
    .filter((v) => v.x[3] > EPS_W)
    .map((v) => project(v, width, height));
}
