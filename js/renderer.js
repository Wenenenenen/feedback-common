// renderer.js — 画布渲染(自研三角网格)、原生描边对照、PNG/网格导出、点选查询。
import { matApply, matInvert, pointAtLength } from './geometry.js';
import { dashIntervals } from './stroker.js';

export function colorCss(c, alphaScale = 1) {
  const r = Math.round(c[0] * 255), g = Math.round(c[1] * 255), b = Math.round(c[2] * 255);
  return `rgba(${r},${g},${b},${Math.min(1, c[3] * alphaScale)})`;
}

// 把路径的所有三角形放进一个 Path2D(局部坐标)。
function meshPath2D(mesh) {
  const p2d = new Path2D();
  const pos = mesh.positions, tris = mesh.triangles;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 2, b = tris[i + 1] * 2, c = tris[i + 2] * 2;
    p2d.moveTo(pos[a], pos[a + 1]);
    p2d.lineTo(pos[b], pos[b + 1]);
    p2d.lineTo(pos[c], pos[c + 1]);
    p2d.closePath();
  }
  return p2d;
}

// 关键:同一条路径的所有三角形在**一次 fill()** 中栅格化。
// 半透明时每个像素只着色一次,内部三角形重叠不会变深。
export function fillPathMesh(ctx, computed, baseScale) {
  const m = computed.path.transform;
  const k = baseScale;
  ctx.save();
  ctx.setTransform(k * m[0], k * m[1], k * m[2], k * m[3], k * m[4], k * m[5]);
  ctx.fillStyle = colorCss(computed.path.style.color);
  ctx.fill(meshPath2D(computed.mesh), 'nonzero');
  ctx.restore();
}

export function drawWireframe(ctx, computed, baseScale, color = 'rgba(30,144,255,0.55)') {
  const m = computed.path.transform;
  const pos = computed.mesh.positions, tris = computed.mesh.triangles;
  ctx.save();
  ctx.setTransform(baseScale, 0, 0, baseScale, 0, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.5 / baseScale * 2;
  ctx.beginPath();
  for (let i = 0; i < tris.length; i += 3) {
    let px = null, py = null, fx = 0, fy = 0;
    for (let j = 0; j < 3; j++) {
      const idx = tris[i + j] * 2;
      const [x, y] = matApply(m, pos[idx], pos[idx + 1]);
      if (j === 0) { ctx.moveTo(x, y); fx = x; fy = y; }
      else ctx.lineTo(x, y);
      px = x; py = y;
    }
    ctx.lineTo(fx, fy);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawCenterlines(ctx, computed, baseScale, color = 'rgba(220,40,40,0.8)') {
  const m = computed.path.transform;
  ctx.save();
  ctx.setTransform(baseScale, 0, 0, baseScale, 0, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1 / baseScale;
  ctx.setLineDash([4 / baseScale, 3 / baseScale]);
  for (const sp of computed.subpaths) {
    ctx.beginPath();
    sp.pts.forEach((p, i) => {
      const [x, y] = matApply(m, p[0], p[1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.restore();
}

// 高亮某条虚线段对应的三角形(点选反馈)
export function drawDashHighlight(ctx, computed, polyline, baseScale) {
  const m = computed.path.transform;
  ctx.save();
  ctx.setTransform(baseScale, 0, 0, baseScale, 0, 0);
  ctx.strokeStyle = 'rgba(255,160,0,0.95)';
  ctx.lineWidth = 1.5 / baseScale;
  ctx.setLineDash([]);
  ctx.beginPath();
  polyline.pts.forEach((p, i) => {
    const [x, y] = matApply(m, p[0], p[1]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

// 原生描边对照(仅用于肉眼对比;网格管线不依赖它)
export function drawNativeStroke(ctx, path, baseScale) {
  const m = path.transform;
  ctx.save();
  ctx.setTransform(baseScale * m[0], baseScale * m[1], baseScale * m[2], baseScale * m[3], baseScale * m[4], baseScale * m[5]);
  const p2d = new Path2D();
  for (const cmd of path.commands) {
    if (cmd[0] === 'M') p2d.moveTo(cmd[1], cmd[2]);
    else if (cmd[0] === 'L') p2d.lineTo(cmd[1], cmd[2]);
    else if (cmd[0] === 'Q') p2d.quadraticCurveTo(cmd[1], cmd[2], cmd[3], cmd[4]);
    else if (cmd[0] === 'C') p2d.bezierCurveTo(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
    else if (cmd[0] === 'Z') p2d.closePath();
  }
  const st = path.style;
  ctx.strokeStyle = colorCss(st.color);
  ctx.lineWidth = st.width;
  ctx.lineJoin = st.join;
  ctx.lineCap = st.cap;
  ctx.miterLimit = st.miterLimit;
  ctx.setLineDash(st.dash.length % 2 === 1 ? st.dash.concat(st.dash) : st.dash);
  ctx.lineDashOffset = st.dashOffset;
  ctx.stroke(p2d);
  ctx.restore();
}

export function renderScene(ctx, computedDoc, view, baseScale, highlight) {
  const { doc } = computedDoc;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  for (const cp of computedDoc.paths) {
    if (view.native) drawNativeStroke(ctx, cp.path, baseScale);
    if (view.fill) fillPathMesh(ctx, cp, baseScale);
  }
  if (view.wireframe) for (const cp of computedDoc.paths) drawWireframe(ctx, cp, baseScale);
  if (view.centerline) for (const cp of computedDoc.paths) drawCenterlines(ctx, cp, baseScale);
  if (highlight) drawDashHighlight(ctx, highlight.computed, highlight.polyline, baseScale);
}

// ---------- 导出 ----------
export function exportMeshJSON(computedDoc) {
  const { doc } = computedDoc;
  const out = { canvas: doc.canvas.slice(), paths: [] };
  for (const cp of computedDoc.paths) {
    const m = cp.path.transform;
    const pos = cp.mesh.positions;
    const flat = new Array(pos.length);
    for (let i = 0; i < pos.length; i += 2) {
      const [x, y] = matApply(m, pos[i], pos[i + 1]);
      flat[i] = x; flat[i + 1] = y;
    }
    const tris = [];
    for (let i = 0; i < cp.mesh.triangles.length; i += 3) {
      tris.push([cp.mesh.triangles[i], cp.mesh.triangles[i + 1], cp.mesh.triangles[i + 2]]);
    }
    out.paths.push({
      id: cp.path.id ?? null,
      color: cp.path.style.color.slice(),
      positions: flat,
      triangles: tris,
    });
  }
  return out;
}

export function exportPNG(computedDoc, view) {
  const [w, h] = computedDoc.doc.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  // 透明背景,仅描边内容
  for (const cp of computedDoc.paths) fillPathMesh(ctx, cp, 1);
  return canvas.toDataURL('image/png');
}

// ---------- 点选:返回命中路径与弧长区间 ----------
export function hitTest(computedDoc, xDoc, yDoc) {
  let best = null;
  for (const cp of computedDoc.paths) {
    const inv = matInvert(cp.path.transform);
    if (!inv) continue;
    const [lx, ly] = [inv[0] * xDoc + inv[2] * yDoc + inv[4], inv[1] * xDoc + inv[3] * yDoc + inv[5]];
    const half = cp.path.style.width / 2;
    cp.subpaths.forEach((sp, si) => {
      // 点到子路径折线的最近距离与弧长
      let bestD = Infinity, bestS = 0;
      for (let i = 0; i < sp.pieces.length; i++) {
        const a = sp.pts[i], b = sp.pts[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((lx - a[0]) * dx + (ly - a[1]) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = a[0] + t * dx, py = a[1] + t * dy;
        const d = Math.hypot(lx - px, ly - py);
        if (d < bestD) {
          bestD = d;
          bestS = sp.cum[i] + t * (sp.cum[i + 1] - sp.cum[i]);
        }
      }
      if (bestD <= half + 1e-9) {
        const score = bestD;
        if (!best || score < best.score) {
          // 找所在(或最近的)虚线 on 区间
          const st = cp.path.style;
          const res = dashIntervals(sp.length, st.dash, st.dashOffset, sp.closed);
          let iv = res.intervals.find((v) => bestS >= v.s0 - 1e-9 && bestS <= v.s1 + 1e-9);
          let inGap = false;
          if (!iv && res.intervals.length) {
            inGap = true;
            iv = res.intervals.reduce((p, v) => {
              const dc = bestS < v.s0 ? v.s0 - bestS : bestS - v.s1;
              const dp = bestS < p.s0 ? p.s0 - bestS : bestS - p.s1;
              return dc < dp ? v : p;
            });
          }
          best = { computed: cp, subpathIndex: si, s: bestS, interval: iv || null, inGap, score };
        }
      }
    });
  }
  return best;
}
