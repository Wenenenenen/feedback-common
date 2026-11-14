/**
 * Orbit camera: spherical eye around a target, orthographic-free perspective
 * projection in plain JS. Used by both the 3-D canvas renderer and the 2-D
 * section canvas for consistent pan/zoom.
 */

const DEG = Math.PI / 180;

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export class OrbitCamera {
  constructor() {
    // yaw/pitch in radians; distance in millimetres.
    this.yaw = 0.6;
    this.pitch = 0.35;
    this.distance = 120;
    this.target = [0, 0, 0];
    this.fovDeg = 35;
  }

  /** Fit the camera to a bounding box, preserving the current direction. */
  fit(bbox, aspect = 1) {
    const center = [
      (bbox.min[0] + bbox.max[0]) / 2,
      (bbox.min[1] + bbox.max[1]) / 2,
      (bbox.min[2] + bbox.max[2]) / 2,
    ];
    this.target = center;
    // Distance is relative to the sphere radius; callers pass the box diagonal
    // so a tall thin part fits too.
    const diagonal = Math.hypot(
      bbox.max[0] - bbox.min[0],
      bbox.max[1] - bbox.min[1],
      bbox.max[2] - bbox.min[2],
    );
    const radius = Math.max(diagonal / 2, 1e-6);
    // The binding constraint is the narrower of the vertical and horizontal
    // fields of view; fit the bounding sphere to it.
    const halfV = (this.fovDeg * DEG) / 2;
    const halfH = Math.atan(Math.tan(halfV) * Math.max(aspect, 0.05));
    const half = Math.min(halfV, halfH);
    this.distance = (radius / Math.sin(half)) * 1.08;
  }

  eye() {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  /** Camera basis: forward (from eye toward target), right, up. */
  basis() {
    const eye = this.eye();
    let f = [
      this.target[0] - eye[0],
      this.target[1] - eye[1],
      this.target[2] - eye[2],
    ];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    f = [f[0] / fl, f[1] / fl, f[2] / fl];
    let right = [f[2], 0, -f[0]];
    const rl = Math.hypot(right[0], right[1], right[2]);
    if (rl < 1e-6) right = [1, 0, 0];
    else right = [right[0] / rl, right[1] / rl, right[2] / rl];
    const up = [
      f[1] * right[2] - f[2] * right[1],
      f[2] * right[0] - f[0] * right[2],
      f[0] * right[1] - f[1] * right[0],
    ];
    return { eye, forward: f, right, up };
  }

  /**
   * World -> view (x right, y up, z toward viewer) -> screen.
   * Returns a project function and a scale in px/mm at the target depth.
   */
  projector(width, height) {
    const b = this.basis();
    const focal = height / 2 / Math.tan((this.fovDeg * DEG) / 2);
    const project = (p) => {
      const dx = p[0] - b.eye[0];
      const dy = p[1] - b.eye[1];
      const dz = p[2] - b.eye[2];
      const zx = dx * b.right[0] + dy * b.right[1] + dz * b.right[2];
      const zy = dx * b.up[0] + dy * b.up[1] + dz * b.up[2];
      const zz = dx * b.forward[0] + dy * b.forward[1] + dz * b.forward[2];
      if (!(zz > 1e-6)) return null;
      return {
        x: width / 2 + (zx / zz) * focal,
        y: height / 2 - (zy / zz) * focal,
        depth: zz,
      };
    };
    return { project, focal, basis: b };
  }

  rotate(dxPx, dyPx) {
    this.yaw -= dxPx * 0.007;
    this.pitch = clamp(this.pitch + dyPx * 0.007, -1.5, 1.5);
  }

  zoom(factor) {
    this.distance = clamp(this.distance / factor, 0.01, 1e7);
  }

  pan(dxPx, dyPx, height) {
    const b = this.basis();
    const focal = height / 2 / Math.tan((this.fovDeg * DEG) / 2);
    const mmPerPx = this.distance / focal;
    for (let i = 0; i < 3; i++) {
      this.target[i] += (-b.right[i] * dxPx + b.up[i] * dyPx) * mmPerPx;
    }
  }
}

/** 2-D view transform for the section canvas (mm -> px). */
export class View2D {
  constructor() {
    this.center = [0, 0];   // mm at canvas centre
    this.scale = 8;         // px per mm
  }
  reset(bbox2d, width, height) {
    if (!bbox2d) {
      this.center = [0, 0];
      this.scale = Math.min(width, height) / 30;
      return;
    }
    const [minx, miny, maxx, maxy] = bbox2d;
    this.center = [(minx + maxx) / 2, (miny + maxy) / 2];
    const w = Math.max(maxx - minx, 1e-6);
    const h = Math.max(maxy - miny, 1e-6);
    this.scale = Math.min((width * 0.82) / w, (height * 0.82) / h);
  }
  toScreen(p, width, height) {
    return [
      width / 2 + (p[0] - this.center[0]) * this.scale,
      height / 2 - (p[1] - this.center[1]) * this.scale,
    ];
  }
  toWorld(x, y, width, height) {
    return [
      this.center[0] + (x - width / 2) / this.scale,
      this.center[1] - (y - height / 2) / this.scale,
    ];
  }
  zoomAt(factor, px, py, width, height) {
    const before = this.toWorld(px, py, width, height);
    this.scale = clamp(this.scale * factor, 1e-4, 1e6);
    const after = this.toWorld(px, py, width, height);
    this.center[0] += before[0] - after[0];
    this.center[1] += before[1] - after[1];
  }
  pan(dx, dy) {
    this.center[0] -= dx / this.scale;
    this.center[1] += dy / this.scale;
  }
}
