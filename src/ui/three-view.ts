import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Edge } from '../core/types.js';
import { chartColor, rampColor, SEQUENTIAL } from './colors.js';
import type { MeshInput, Store } from './state.js';

const SEAM_COLOR = 0xfbbf24;
const BOUNDARY_COLOR = 0x7dd3fc;
const SPLIT_COLOR = 0x7dd3fc;
const HOVER_COLOR = 0xffffff;
const FLIP_COLOR = '#d03b3b';
const NEAR_ZERO_COLOR = '#fab219';
const INVALID_COLOR = '#5b6472';
const NEUTRAL_COLOR = '#8b98ab';

interface Pick {
  face: number;
  edge: Edge;
  point: THREE.Vector3;
}

export class ThreeView {
  private readonly wrap: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly hud: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly store: Store;
  private readonly group = new THREE.Group();

  private mesh: THREE.Mesh | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private seamLines: THREE.LineSegments | null = null;
  private boundaryLines: THREE.LineSegments | null = null;
  private splitPoints: THREE.Points | null = null;
  private hoverLine: THREE.Line | null = null;
  private hoverEdge: Edge | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private pointerDownAt: { x: number; y: number } | null = null;
  private readonly resizeObserver: ResizeObserver;
  private needsRender = true;
  private fitted = false;
  private disposed = false;
  private maxResidual = 0;
  private residualByCut = new Map<number, number>();

  constructor(args: {
    wrap: HTMLElement;
    canvas: HTMLCanvasElement;
    hud: HTMLElement;
    legend: HTMLElement;
    empty: HTMLElement;
    store: Store;
  }) {
    this.wrap = args.wrap;
    this.canvas = args.canvas;
    this.hud = args.hud;
    this.legend = args.legend;
    this.empty = args.empty;
    this.store = args.store;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.add(this.group);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
    this.camera.position.set(2.4, 1.8, 2.4);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.invalidate());

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9bb8ff, 0.55);
    fill.position.set(-4, -3, -2);
    this.scene.add(fill);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.wrap);
    this.resize();

    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverEdge = null;
      if (this.store.hover.face === null && this.store.hover.edge === null) return;
      this.store.hover = { face: null, edge: null };
      this.updateHoverLine();
      this.refreshColors();
      this.updateHud();
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.pointerDownAt = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));

    this.store.subscribe((event) => {
      if (event === 'input') {
        this.fitted = false;
        this.rebuild();
      } else if (event === 'seams' || event === 'result') {
        this.rebuildOverlays();
      } else if (event === 'view') {
        this.applyFlags();
      } else if (event === 'selection') {
        this.refreshColors();
      }
    });

    this.animate();
  }

  // ---------------------------------------------------------------- lifecycle

  private resize(): void {
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  invalidate(): void {
    this.needsRender = true;
  }

  fit(): void {
    const box = new THREE.Box3();
    if (this.geometry) {
      this.geometry.computeBoundingBox();
      if (this.geometry.boundingBox && !this.geometry.boundingBox.isEmpty()) {
        box.copy(this.geometry.boundingBox);
      }
    }
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 1e-6);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.2;
    const dir = new THREE.Vector3(1, 0.72, 1.05).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 2000, 1e-6);
    this.camera.far = dist * 200;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.minDistance = radius * 0.05;
    this.controls.maxDistance = radius * 50;
    this.controls.update();
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }

  private animate = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    const changed = this.controls.update();
    if (this.needsRender || changed) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  };

  // ---------------------------------------------------------------- building

  private disposeObject(obj: THREE.Object3D | null): void {
    if (!obj) return;
    this.group.remove(obj);
    const anyObj = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    anyObj.geometry?.dispose();
    if (Array.isArray(anyObj.material)) anyObj.material.forEach((m) => m.dispose());
    else anyObj.material?.dispose();
  }

  private clearScene(): void {
    for (const obj of [this.mesh, this.seamLines, this.boundaryLines, this.splitPoints, this.hoverLine]) {
      this.disposeObject(obj);
    }
    this.mesh = null;
    this.seamLines = null;
    this.boundaryLines = null;
    this.splitPoints = null;
    this.hoverLine = null;
    this.geometry?.dispose();
    this.geometry = null;
  }

  /** Per-corner world positions (split vertices coincide with their original). */
  private cornerPositions(input: MeshInput): Float32Array {
    const positions = new Float32Array(input.faces.length * 9);
    input.faces.forEach((face, fi) => {
      for (let c = 0; c < 3; c++) {
        const p = input.vertices[face[c]];
        positions.set(p, fi * 9 + c * 3);
      }
    });
    return positions;
  }

  private rebuild(): void {
    this.clearScene();
    const input = this.store.input;
    if (!input) {
      this.empty.classList.remove('hidden');
      this.hud.textContent = '';
      this.legend.innerHTML = '';
      this.invalidate();
      return;
    }
    this.empty.classList.add('hidden');

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.cornerPositions(input), 3));
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(input.faces.length * 9).fill(1), 3),
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    this.geometry = geometry;

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.62,
      metalness: 0.02,
      flatShading: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.userData.faceCount = input.faces.length;
    this.group.add(this.mesh);

    this.cacheResiduals();
    this.buildSeamLines();
    this.buildChartOverlays();
    this.refreshColors();
    this.applyFlags();
    this.updateLegend();
    this.updateHud();
    if (!this.fitted) {
      this.fitted = true;
      this.fit();
    }
    this.invalidate();
  }

  private cacheResiduals(): void {
    const result = this.store.result;
    this.maxResidual = 0;
    this.residualByCut = new Map();
    if (!result) return;
    for (const chart of result.charts) {
      for (const r of chart.residuals.interior) {
        this.residualByCut.set(r.cutVertex, r.normalized);
        if (r.normalized > this.maxResidual) this.maxResidual = r.normalized;
      }
    }
  }

  private buildSeamLines(): void {
    const input = this.store.input;
    if (!input || this.store.seams.length === 0) return;
    const pts: number[] = [];
    for (const [a, b] of this.store.seams) pts.push(...input.vertices[a], ...input.vertices[b]);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.seamLines = new THREE.LineSegments(
      geom,
      new THREE.LineBasicMaterial({ color: SEAM_COLOR, depthTest: false, transparent: true }),
    );
    this.seamLines.renderOrder = 10;
    this.group.add(this.seamLines);
  }

  private buildChartOverlays(): void {
    const input = this.store.input;
    const result = this.store.result;
    if (!input || !result) return;

    const boundary: number[] = [];
    for (const chart of result.charts) {
      for (const loop of chart.boundaryLoops) {
        for (let i = 0; i < loop.length; i++) {
          const a = result.cutVertices[loop[i]];
          const b = result.cutVertices[loop[(i + 1) % loop.length]];
          if (!a || !b) continue;
          boundary.push(...input.vertices[a.originalVertex], ...input.vertices[b.originalVertex]);
        }
      }
    }
    if (boundary.length > 0) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(boundary, 3));
      this.boundaryLines = new THREE.LineSegments(
        geom,
        new THREE.LineBasicMaterial({ color: BOUNDARY_COLOR, depthTest: false, transparent: true, opacity: 0.95 }),
      );
      this.boundaryLines.renderOrder = 8;
      this.group.add(this.boundaryLines);
    }

    const counts = new Map<number, number>();
    for (const cv of result.cutVertices) {
      counts.set(cv.originalVertex, (counts.get(cv.originalVertex) ?? 0) + 1);
    }
    const split: number[] = [];
    for (const [original, n] of counts) {
      if (n > 1) split.push(...input.vertices[original]);
    }
    if (split.length > 0) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(split, 3));
      this.splitPoints = new THREE.Points(
        geom,
        new THREE.PointsMaterial({ color: SPLIT_COLOR, size: 9, sizeAttenuation: false, depthTest: false }),
      );
      this.splitPoints.renderOrder = 12;
      this.group.add(this.splitPoints);
    }
  }

  private applyFlags(): void {
    const flags = this.store.flags;
    if (this.boundaryLines) this.boundaryLines.visible = flags.boundary;
    if (this.splitPoints) this.splitPoints.visible = flags.split;
    if (this.mesh) {
      const mat = this.mesh.material as THREE.MeshStandardMaterial;
      mat.wireframe = flags.wire;
      mat.needsUpdate = true;
    }
    this.refreshColors();
    this.invalidate();
  }

  private faceColorHex(fi: number): string {
    const result = this.store.result;
    const flags = this.store.flags;
    if (!result) return NEUTRAL_COLOR;
    const chartIndex = result.faceChart[fi] ?? -1;
    const chart = chartIndex >= 0 ? result.charts[chartIndex] : undefined;
    if (chart) {
      if (chart.flippedFaces.includes(fi)) return FLIP_COLOR;
      if (chart.nearZeroFaces.includes(fi)) return NEAR_ZERO_COLOR;
      if (!chart.valid) return INVALID_COLOR;
    }
    if (flags.residual && result) {
      let localMax = 0;
      for (let c = 0; c < 3; c++) {
        const cv = result.cornerCutVertex[fi * 3 + c] ?? -1;
        if (cv >= 0) localMax = Math.max(localMax, this.residualByCut.get(cv) ?? 0);
      }
      if (localMax > 0) {
        const t = Math.log1p(localMax) / (Math.log1p(this.maxResidual) || 1);
        return rampColor(t);
      }
    }
    if (flags.chartColor) return chartColor(chartIndex);
    return NEUTRAL_COLOR;
  }

  private refreshColors(): void {
    if (!this.mesh || !this.geometry) return;
    const attr = this.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const input = this.store.input;
    if (!input) return;
    const sel = this.store.selection;
    const hovered = this.store.hover.face;
    const color = new THREE.Color();
    const white = new THREE.Color('#ffffff');

    for (let fi = 0; fi < input.faces.length; fi++) {
      color.set(this.faceColorHex(fi));
      const dimmed = sel.face !== null && sel.face !== fi;
      if (dimmed) color.multiplyScalar(0.45);
      if (sel.face === fi) color.lerp(white, 0.3);
      else if (hovered === fi) color.lerp(white, 0.15);
      for (let c = 0; c < 3; c++) attr.setXYZ(fi * 3 + c, color.r, color.g, color.b);
    }
    attr.needsUpdate = true;
    this.invalidate();
  }

  private updateLegend(): void {
    const result = this.store.result;
    if (!result) {
      this.legend.innerHTML = '';
      return;
    }
    const parts: string[] = [];
    if (this.store.flags.residual) {
      const stops = SEQUENTIAL.map((c) => `<span class="chip" style="background:${c}"></span>`).join('');
      parts.push(
        `<span class="item">残差 0</span><span class="item">${stops}</span>` +
          `<span class="item">${result.stats.maxResidual.toExponential(1)}</span>`,
      );
      this.legend.innerHTML = parts.join('');
      return;
    }
    for (let i = 0; i < Math.min(result.charts.length, 8); i++) {
      parts.push(
        `<span class="item"><span class="chip" style="background:${chartColor(i)}"></span>图表 ${i}</span>`,
      );
    }
    parts.push(`<span class="item"><span class="chip" style="background:#fbbf24"></span>切缝</span>`);
    parts.push(
      `<span class="item"><span class="chip" style="background:#7dd3fc"></span>图表边界</span>`,
    );
    if (result.stats.flippedFaces > 0)
      parts.push(`<span class="item"><span class="chip" style="background:${FLIP_COLOR}"></span>翻转 ${result.stats.flippedFaces}</span>`);
    if (result.stats.nearZeroFaces > 0)
      parts.push(`<span class="item"><span class="chip" style="background:${NEAR_ZERO_COLOR}"></span>近零 ${result.stats.nearZeroFaces}</span>`);
    this.legend.innerHTML = parts.join('');
  }

  private updateHud(): void {
    const input = this.store.input;
    if (!input) {
      this.hud.textContent = '';
      return;
    }
    const result = this.store.result;
    const lines = [`${input.vertices.length} 顶点 · ${input.faces.length} 面 · ${this.store.seams.length} 切缝`];
    if (result) {
      lines.push(`${result.stats.charts} 图表 · ${result.stats.cutVertices} cut 顶点`);
      lines.push(`残差 ${result.stats.maxResidual.toExponential(1)} · 翻转 ${result.stats.flippedFaces}`);
    }
    this.hud.innerHTML = lines.join('<br>');
  }

  // ---------------------------------------------------------------- picking

  private updateRay(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pick(e: PointerEvent): Pick | null {
    const input = this.store.input;
    if (!this.mesh || !input) return null;
    this.updateRay(e);
    const hits = this.raycaster.intersectObject(this.mesh, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const rawFaceIndex: number | null | undefined = hit.faceIndex;
    if (rawFaceIndex === undefined || rawFaceIndex === null) return null;
    const fi = Math.floor(rawFaceIndex);
    const face = input.faces[fi];
    if (!face) return null;
    let best: { edge: Edge; dist: number } | null = null;
    for (let c = 0; c < 3; c++) {
      const a = face[c];
      const b = face[(c + 1) % 3];
      const pa = new THREE.Vector3(...input.vertices[a]);
      const pb = new THREE.Vector3(...input.vertices[b]);
      const dist = hit.point.distanceTo(closestOnSegment(hit.point, pa, pb));
      if (!best || dist < best.dist) best = { edge: a < b ? [a, b] : [b, a], dist };
    }
    if (!best) return null;
    return { face: fi, edge: best.edge, point: hit.point };
  }

  private isSeam(edge: Edge): boolean {
    const [a, b] = edge;
    return this.store.seams.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }

  private onPointerMove(e: PointerEvent): void {
    const picked = this.pick(e);
    const prevFace = this.store.hover.face;
    const prevEdge = this.store.hover.edge;
    const nextFace = picked?.face ?? null;
    const nextEdge = picked?.edge ?? null;
    const changed =
      prevFace !== nextFace ||
      prevEdge?.[0] !== nextEdge?.[0] ||
      prevEdge?.[1] !== nextEdge?.[1];
    this.hoverEdge = nextEdge;
    if (changed) {
      this.store.hover = { face: nextFace, edge: nextEdge };
      this.refreshColors();
    }
    this.updateHoverLine();
    if (picked) {
      const result = this.store.result;
      const chart = result?.faceChart[picked.face] ?? -1;
      const seamText = this.isSeam(picked.edge) ? '切缝（点击移除）' : '无切缝（点击添加）';
      this.hud.innerHTML =
        `面 ${picked.face}` +
        (chart >= 0 ? ` · 图表 ${chart}` : '') +
        `<br>边 (${picked.edge[0]}, ${picked.edge[1]}) · ${seamText}`;
    } else {
      this.updateHud();
    }
  }

  private updateHoverLine(): void {
    this.disposeObject(this.hoverLine);
    this.hoverLine = null;
    const edge = this.hoverEdge ?? this.store.hoveredSeam;
    const input = this.store.input;
    if (!edge || !input) {
      this.invalidate();
      return;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([...input.vertices[edge[0]], ...input.vertices[edge[1]]], 3),
    );
    this.hoverLine = new THREE.Line(
      geom,
      new THREE.LineBasicMaterial({
        color: this.isSeam(edge) ? 0xfff3d6 : HOVER_COLOR,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.hoverLine.renderOrder = 20;
    this.group.add(this.hoverLine);
    this.invalidate();
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button !== 0) return;
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    if (!down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const picked = this.pick(e);
    if (!picked) {
      this.store.select({ face: null, faces: [], chart: null, cutVertex: null });
      return;
    }
    if (e.shiftKey) {
      const result = this.store.result;
      const chartIndex = result?.faceChart[picked.face] ?? -1;
      const faces = result && chartIndex >= 0 ? result.charts[chartIndex].faces : [picked.face];
      this.store.select({ face: picked.face, chart: chartIndex >= 0 ? chartIndex : null, faces, cutVertex: null });
      return;
    }
    const next = this.isSeam(picked.edge)
      ? this.store.seams.filter(
          ([a, b]) =>
            !((a === picked.edge[0] && b === picked.edge[1]) || (a === picked.edge[1] && b === picked.edge[0])),
        )
      : [...this.store.seams, picked.edge];
    this.store.setSeams(next);
  }

  /** Rebuild only overlays (seams / boundary / split markers) after a recompute. */
  private rebuildOverlays(): void {
    this.disposeObject(this.seamLines);
    this.seamLines = null;
    this.disposeObject(this.boundaryLines);
    this.boundaryLines = null;
    this.disposeObject(this.splitPoints);
    this.splitPoints = null;
    this.cacheResiduals();
    this.buildSeamLines();
    this.buildChartOverlays();
    this.refreshColors();
    this.applyFlags();
    this.updateLegend();
    this.updateHud();
    this.invalidate();
  }

  /** Reset to a fitted isometric-ish view. */
  resetCamera(): void {
    this.fitted = false;
    this.fit();
    this.fitted = true;
  }

  /** Highlight a seam from the sidebar without changing selection. */
  highlightSeam(edge: Edge | null): void {
    this.store.hoveredSeam = edge;
    this.hoverEdge = edge;
    this.updateHoverLine();
  }
}

function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  if (lenSq === 0) return a.clone();
  const t = Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / lenSq));
  return a.clone().addScaledVector(ab, t);
}
