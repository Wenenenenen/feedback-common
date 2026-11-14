/**
 * 3-D canvas renderer: painter's algorithm over CPU-projected triangles,
 * back-face culled, with a section-plane overlay and section outline drawn at
 * true 3-D positions. Canvas 2D only.
 */

const LIGHT = (() => {
  const l = [0.42, 0.72, 0.55];
  const n = Math.hypot(l[0], l[1], l[2]);
  return [l[0] / n, l[1] / n, l[2] / n];
})();

const BODY_COLORS = [
  { base: [56, 139, 253], edge: [30, 85, 160], fill: 'rgba(56,139,253,0.16)' },
  { base: [35, 182, 141], edge: [18, 120, 94], fill: 'rgba(35,182,141,0.16)' },
  { base: [210, 153, 34], edge: [150, 106, 18], fill: 'rgba(210,153,34,0.16)' },
  { base: [188, 92, 214], edge: [130, 58, 152], fill: 'rgba(188,92,214,0.16)' },
  { base: [230, 92, 92], edge: [160, 58, 58], fill: 'rgba(230,92,92,0.16)' },
  { base: [99, 179, 237], edge: [56, 121, 168], fill: 'rgba(99,179,237,0.16)' },
];

export function bodyColor(index) {
  return BODY_COLORS[index % BODY_COLORS.length];
}

export class Renderer3D {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.mesh = null;
    this.section = null;
    this.planeVisible = true;
    this.sectionHighlight = false;
    this.faceBackface = 0.18;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  setMesh(mesh) {
    this.mesh = mesh;
  }

  setSection(section) {
    this.section = section;
  }

  draw() {
    const ctx = this.resize();
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f7f8fa';
    ctx.fillRect(0, 0, w, h);
    if (!this.mesh) {
      this.drawEmpty(ctx, w, h);
      return;
    }
    const { project, basis } = this.camera.projector(w, h);

    // Ambient occlusion-ish ground grid helps depth perception.
    this.drawReferenceGrid(ctx, project, w, h);

    const positions = this.mesh.renderPositions;
    const components = this.mesh.triComponent;
    const b = basis;
    const eye = b.eye;
    const triCount = this.mesh.triangleCount;

    // Painter's algorithm: project all triangles, cull, sort by depth,
    // then fill. 20k triangles is fine at interactive rates.
    const tri = new Array(triCount);
    let visible = 0;
    for (let t = 0; t < triCount; t++) {
      const o = t * 9;
      const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
      const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
      const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const nlen = Math.hypot(nx, ny, nz);
      if (!(nlen > 0)) continue;
      const ndx = nx / nlen, ndy = ny / nlen, ndz = nz / nlen;
      const mx = (ax + bx + cx) / 3;
      const my = (ay + by + cy) / 3;
      const mz = (az + bz + cz) / 3;
      const viewX = mx - eye[0];
      const viewY = my - eye[1];
      const viewZ = mz - eye[2];
      const facing = ndx * viewX + ndy * viewY + ndz * viewZ;
      if (facing > 0) continue; // outward normal toward eye? we want outward facing
      const pa = project([ax, ay, az]);
      const pb = project([bx, by, bz]);
      const pc = project([cx, cy, cz]);
      if (!pa || !pb || !pc) continue;
      // Cheap screen bounds culling.
      if ((pa.x < -w && pb.x < -w && pc.x < -w) || (pa.x > 2 * w && pb.x > 2 * w && pc.x > 2 * w)) continue;
      if ((pa.y < -h && pb.y < -h && pc.y < -h) || (pa.y > 2 * h && pb.y > 2 * h && pc.y > 2 * h)) continue;
      const depth = (pa.depth + pb.depth + pc.depth) / 3;
      const ndotl = ndx * LIGHT[0] + ndy * LIGHT[1] + ndz * LIGHT[2];
      // Two-sided shading: a back-facing facet of a closed solid is still
      // visible through an opening, and must not go black.
      const light = 0.55 + 0.45 * Math.max(0, ndotl) + 0.10 * Math.max(0, -ndotl);
      // Screen-space area picks whether this cell needs a seam-covering
      // stroke; tiny cells are already sub-pixel and only cost fill time.
      const screenArea = Math.abs(
        (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y),
      ) * 0.5;
      tri[visible++] = {
        ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y, cx: pc.x, cy: pc.y,
        depth, light, comp: components[t], screenArea,
      };
    }
    const list = tri.slice(0, visible);
    list.sort((p, q) => q.depth - p.depth);

    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.9;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const col = BODY_COLORS[f.comp % BODY_COLORS.length];
      const fill = rgb(col.base, f.light);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(f.ax, f.ay);
      ctx.lineTo(f.bx, f.by);
      ctx.lineTo(f.cx, f.cy);
      ctx.closePath();
      ctx.fill();
      if (f.screenArea > 36) {
        // Stroke only on cells big enough to show a seam; the stroke is the
        // same colour, so it covers the antialiasing gap between neighbours.
        ctx.strokeStyle = fill;
        ctx.stroke();
      }
    }

    // Plane overlay and its projected bounding-box quad.
    if (this.planeVisible && this.section && !this.section.empty) {
      this.drawPlane(ctx, project, w, h);
    }
    // Section rings at their true 3-D positions.
    if (this.section && !this.section.empty) {
      this.drawSectionRings(ctx, project, w, h);
    }
  }

  drawEmpty(ctx, w, h) {
    ctx.save();
    ctx.strokeStyle = '#c7d2df';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    ctx.setLineDash([]);
    ctx.fillStyle = '#64748b';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('载入模型或选择一个示例', w / 2, h / 2 - 6);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('拖入 STL · 支持 ASCII 与二进制 · 单位 mm', w / 2, h / 2 + 16);
    ctx.restore();
  }

  drawReferenceGrid(ctx, project, w, h) {
    const bbox = this.mesh.meta.bbox;
    const z = bbox.min[2];
    const [minx, miny] = bbox.min;
    const [maxx, maxy] = bbox.max;
    const span = Math.max(maxx - minx, maxy - miny, 1);
    const stepChoices = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000];
    let step = stepChoices[stepChoices.length - 1];
    for (const s of stepChoices) {
      if (span / s <= 14) { step = s; break; }
    }
    ctx.save();
    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.lineWidth = 0.7;
    const gx0 = Math.ceil(minx / step) * step;
    const gy0 = Math.ceil(miny / step) * step;
    const xt = Math.ceil((maxx - gx0) / step);
    const yt = Math.ceil((maxy - gy0) / step);
    ctx.beginPath();
    for (let i = 0; i <= xt; i++) {
      const x = gx0 + i * step;
      const p = project([x, miny, z]);
      const q = project([x, maxy, z]);
      if (p && q) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    }
    for (let i = 0; i <= yt; i++) {
      const y = gy0 + i * step;
      const p = project([minx, y, z]);
      const q = project([maxx, y, z]);
      if (p && q) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    }
    ctx.stroke();
    ctx.restore();
  }

  planeQuadWorld() {
    const { u, v } = this.section.plane;
    const bbox = this.mesh.meta.bbox;
    const center = [
      (bbox.min[0] + bbox.max[0]) / 2,
      (bbox.min[1] + bbox.max[1]) / 2,
      (bbox.min[2] + bbox.max[2]) / 2,
    ];
    const diag = Math.hypot(
      bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2],
    );
    const s = diag * 0.46;
    const pts = [
      [center[0] - u[0] * s - v[0] * s, center[1] - u[1] * s - v[1] * s, center[2] - u[2] * s - v[2] * s],
      [center[0] + u[0] * s - v[0] * s, center[1] + u[1] * s - v[1] * s, center[2] + u[2] * s - v[2] * s],
      [center[0] + u[0] * s + v[0] * s, center[1] + u[1] * s + v[1] * s, center[2] + u[2] * s + v[2] * s],
      [center[0] - u[0] * s + v[0] * s, center[1] - u[1] * s + v[1] * s, center[2] - u[2] * s + v[2] * s],
    ];
    return pts;
  }

  drawPlane(ctx, project, w, h) {
    const pts = this.planeQuadWorld().map((p) => project(p));
    if (pts.some((p) => !p)) return;
    ctx.save();
    ctx.fillStyle = 'rgba(56,139,253,0.055)';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(31,111,235,0.55)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.restore();
  }

  /** Project a screen point onto the current section plane (n̂·p = d̂). */
  planePointAtScreen(px, py) {
    if (!this.section || !this.mesh) return null;
    const { w, h } = { w: this.width, h: this.height };
    const { project, basis } = this.camera.projector(w, h);
    const n = this.section.plane.nUnit;
    const dNorm = this.section.plane.dNormalized;
    // Build the ray through the pixel.
    const focal = h / 2 / Math.tan((this.camera.fovDeg * Math.PI) / 360);
    const dir = [
      basis.forward[0] + (basis.right[0] * (px - w / 2) + basis.up[0] * (h / 2 - py)) / focal,
      basis.forward[1] + (basis.right[1] * (px - w / 2) + basis.up[1] * (h / 2 - py)) / focal,
      basis.forward[2] + (basis.right[2] * (px - w / 2) + basis.up[2] * (h / 2 - py)) / focal,
    ];
    const denom = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
    if (Math.abs(denom) < 1e-9) return null;
    const t = (dNorm - (n[0] * basis.eye[0] + n[1] * basis.eye[1] + n[2] * basis.eye[2])) / denom;
    if (!(t > 0)) return null;
    const point = [basis.eye[0] + dir[0] * t, basis.eye[1] + dir[1] * t, basis.eye[2] + dir[2] * t];
    return { point, project };
  }

  drawSectionRings(ctx, project, w, h) {
    for (const loop of this.section.loops) {
      const color =
        loop.kind === 'solid' ? '#1f6feb' : loop.kind === 'hole' ? '#c2410c' : '#b91c1c';
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = loop.kind === 'open' ? 1.1 : 1.6;
      if (loop.kind === 'open') ctx.setLineDash([5, 4]);
      ctx.beginPath();
      let started = false;
      for (const p of loop.points3d) {
        const q = project(p);
        if (!q) { started = false; continue; }
        if (!started) { ctx.moveTo(q.x, q.y); started = true; }
        else ctx.lineTo(q.x, q.y);
      }
      if (loop.closed && started) ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }
}

function rgb(base, light) {
  const r = Math.round(base[0] * light);
  const g = Math.round(base[1] * light);
  const b = Math.round(base[2] * light);
  return `rgb(${r},${g},${b})`;
}
