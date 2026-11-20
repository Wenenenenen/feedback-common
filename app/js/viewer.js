// 三维场景：扫掠网格、路径、逐点切线与两条截面轴、问题标记。
import * as THREE from 'three';
import { OrbitRig } from './orbit-rig.js';
import { v3 } from './sweep.js';

const toV = (p) => new THREE.Vector3(p[0], p[1], p[2]);

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.001, 2000);
    this.camera.position.set(3, 2, 4);
    this.rig = new OrbitRig(this.camera, canvas);

    // 光照：中性环境 + 两个方向光，保证两面都可读
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(4, 6, 5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
    fill.position.set(-5, -2, -4);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(4, 20, 0x8a93a6, 0x5b6270);
    (this.grid.material).transparent = true;
    this.grid.material.opacity = 0.25;
    this.scene.add(this.grid);

    this.modelGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.scene.add(this.modelGroup, this.overlayGroup);

    this.showFrames = true;
    this.showPath = true;
    this.showWire = false;
    this._axisScale = 0;
    this._frameOnInput = null;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const w = this.canvas.clientWidth || 600;
    const h = this.canvas.clientHeight || 400;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    for (const g of [this.modelGroup, this.overlayGroup]) {
      for (const child of [...g.children]) {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
        else child.material?.dispose?.();
        g.remove(child);
      }
    }
  }

  // result: buildSweep 输出（可能 invalid）；input: 当前输入（用于路径线与标记）
  update(result, input) {
    this.clear();
    this._frameOnInput = input;
    if (!result || !result.valid) {
      // 无效输入仍画路径点，方便定位零长段
      if (input) this._buildPathOnly(input, result?.diagnostics);
      this._renderOnce();
      return;
    }
    this._buildMesh(result, input);
    if (this.showPath) this._buildPath(input, result);
    if (this.showFrames) this._buildFrames(result);
    this._renderOnce();
  }

  _buildMesh(result, input) {
    const positions = [];
    const normals = [];
    result.sideVerts.forEach((p, i) => {
      positions.push(...p);
      normals.push(...result.sideNormals[i]);
    });
    const indices = result.sideTris.flat();

    if (result.capVerts.length) {
      const off = result.sideVerts.length;
      result.capVerts.forEach((p, i) => {
        positions.push(...p);
        normals.push(...result.capNormals[i]);
      });
      for (const tri of result.capTris) {
        indices.push(tri[0] + off, tri[1] + off, tri[2] + off);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    geo.computeBoundingBox();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x4f8cff,
      metalness: 0.15,
      roughness: 0.45,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
    });
    const mesh = new THREE.Mesh(geo, mat);
    this.modelGroup.add(mesh);

    if (this.showWire) {
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x16233a, transparent: true, opacity: 0.35 })
      );
      this.modelGroup.add(wire);
    }

    // 退化面红色高亮
    const degSide = result.diagnostics.degenerateFaces
      .filter((f) => f.where === 'side');
    if (degSide.length) {
      const dv = [];
      const allVerts = result.sideVerts;
      for (const f of degSide) {
        const tri = result.sideTris[f.triangle];
        if (!tri) continue;
        dv.push(...allVerts[tri[0]], ...allVerts[tri[1]], ...allVerts[tri[2]]);
      }
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.Float32BufferAttribute(dv, 3));
      this.overlayGroup.add(new THREE.LineSegments(
        dg, new THREE.LineBasicMaterial({ color: 0xff4d4d })));
    }

    // 自交面橙色高亮（几何法线指向管轴的穿插面）
    const selfInt = result.diagnostics.selfIntersectingFaces || [];
    if (selfInt.length) {
      const sv = [];
      for (const f of selfInt) {
        const tri = result.sideTris[f.triangle];
        if (!tri) continue;
        sv.push(...result.sideVerts[tri[0]], ...result.sideVerts[tri[1]],
          ...result.sideVerts[tri[1]], ...result.sideVerts[tri[2]],
          ...result.sideVerts[tri[2]], ...result.sideVerts[tri[0]]);
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(sv, 3));
      this.overlayGroup.add(new THREE.LineSegments(
        sg, new THREE.LineBasicMaterial({ color: 0xff9f1c })));
    }

    // 标架轴长度按半径量级自适应
    const maxR = Math.max(...input.radii);
    this._axisScale = maxR * 1.5;
    this._lastBox = geo.boundingBox;
  }

  _buildPath(input, result) {
    const pts = input.points.map(toV);
    if (input.closed && pts.length > 2) pts.push(pts[0].clone());
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({
        color: 0xffb020, dashSize: 0.06, gapSize: 0.04,
        transparent: true, opacity: 0.9,
      })
    );
    line.computeLineDistances();
    this.overlayGroup.add(line);

    // 路径点小球；框架跳变点用警示色
    const jumpSet = new Set(result.diagnostics.frameJumps.map((j) => j.at));
    const zeroSet = new Set(result.diagnostics.zeroSegments);
    const baseR = Math.max(Math.max(...input.radii) * 0.18, 0.012);
    input.points.forEach((p, i) => {
      let color = 0xffb020;
      if (jumpSet.has(i)) color = 0xff5d5d;
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(baseR, 14, 10),
        new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.25 })
      );
      s.position.copy(toV(p));
      this.overlayGroup.add(s);
    });

    // 零长段标记（在重复点处画叉）
    for (const k of zeroSet) {
      const p = toV(input.points[k]);
      const r = baseR * 2.2;
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(p.x - r, p.y - r, p.z), new THREE.Vector3(p.x + r, p.y + r, p.z),
        new THREE.Vector3(p.x - r, p.y + r, p.z), new THREE.Vector3(p.x + r, p.y - r, p.z),
      ]);
      this.overlayGroup.add(new THREE.LineSegments(
        g, new THREE.LineBasicMaterial({ color: 0xff3b3b })));
    }
  }

  _buildPathOnly(input, diag) {
    const pts = input.points.map(toV);
    if (pts.length > 1) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x8893a8 })
      );
      this.overlayGroup.add(line);
    }
    const zeroSet = new Set(diag?.zeroSegments ?? []);
    const baseR = 0.03;
    input.points.forEach((p, i) => {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(baseR, 12, 8),
        new THREE.MeshStandardMaterial({
          color: zeroSet.has(i) ? 0xff3b3b : 0x8893a8,
          emissive: zeroSet.has(i) ? 0x551010 : 0x000000,
        })
      );
      s.position.copy(toV(p));
      this.overlayGroup.add(s);
    });
  }

  _buildFrames(result) {
    const scale = this._axisScale || 0.1;
    const pos = [];
    const col = [];
    const pushArrow = (origin, dir, len, color) => {
      const o = toV(origin);
      const e = o.clone().addScaledVector(toV(dir), len);
      pos.push(o.x, o.y, o.z, e.x, e.y, e.z);
      col.push(...color, ...color);
    };
    const cT = [0.95, 0.35, 0.35];   // 切线 红
    const cN = [0.4, 0.85, 0.45];    // n 轴 绿
    const cB = [0.45, 0.65, 1.0];    // b 轴 蓝
    for (let i = 0; i < result.n; i++) {
      const p = result.rings[i][0] && this._frameOnInput.points[i];
      pushArrow(p, result.tangents[i], scale * 1.15, cT);
      pushArrow(p, result.ringNormals[i], scale, cN);
      pushArrow(p, result.ringBinormals[i], scale, cB);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.overlayGroup.add(new THREE.LineSegments(
      g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 })));
  }

  frameView() {
    if (this._lastBox) this.rig.frame(this._lastBox);
    this._renderOnce();
  }

  setShowFrames(on) { this.showFrames = on; }
  setShowPath(on) { this.showPath = on; }
  setShowWire(on) { this.showWire = on; }

  _renderOnce() {
    this.rig._apply();
    this.renderer.render(this.scene, this.camera);
  }

  // 交互后持续渲染由主循环驱动
  startLoop() {
    const tick = () => {
      this._resize();
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(tick);
    };
    tick();
  }
}
