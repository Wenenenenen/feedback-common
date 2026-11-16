import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Mat4, SceneState, Vec3 } from '../core/types';
import { linearInfo } from '../core/matrix';

export interface GizmoState {
  space: 'world' | 'local';
  mode: 'translate' | 'rotate';
  pivot: Vec3 | null;
  localAxes: { x: Vec3; y: Vec3; z: Vec3 } | null;
}

export interface ViewSnapshot {
  state: SceneState;
  worlds: Map<string, Mat4>;
  selection: Set<string>;
  active: string | null;
  gizmo: GizmoState;
  showLabels: boolean;
}

export interface ViewportCallbacks {
  onPick(id: string | null, additive: boolean, activeOnly: boolean): void;
  onGizmoPreview(mode: 'translate' | 'rotate', axis: 'x' | 'y' | 'z', value: number): void;
  onGizmoCommit(mode: 'translate' | 'rotate', axis: 'x' | 'y' | 'z', value: number): void;
  onGizmoCancel(): void;
}

interface NodeVisual {
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  label: CSS2DObject;
  labelEl: HTMLDivElement;
  boxKey: string;
}

const COLORS = {
  base: 0x8b97ab,
  baseEdge: 0x4b5668,
  selected: 0xf3b455,
  selectedEdge: 0xffd08a,
  active: 0x5fd4d6,
  activeEdge: 0xa6f2f3,
  hover: 0xb5c2d6,
  singular: 0xe06a6a,
  background: 0x0c1017,
  grid: 0x223042,
  gridFaint: 0x161f2b,
};

const AXIS_COLORS: Record<'x' | 'y' | 'z', number> = { x: 0xef6f6f, y: 0x7bd88f, z: 0x6ea8f7 };

/** Beyond this many nodes, non-selected labels are hidden to avoid overlap soup. */
const LABEL_BUDGET = 40;

function matrixFromRowMajor(m: Mat4): THREE.Matrix4 {
  return new THREE.Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]);
}

function vec3(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[1], v[2]);
}

function unitAxis(v: Vec3): THREE.Vector3 {
  const out = new THREE.Vector3(v[0], v[1], v[2]);
  if (out.lengthSq() === 0) return new THREE.Vector3(0, 1, 0);
  return out.normalize();
}

export class Viewport {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private callbacks: ViewportCallbacks;
  private nodeVisuals = new Map<string, NodeVisual>();
  private nodeRoot = new THREE.Group();
  private gizmoRoot = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private meshes: THREE.Mesh[] = [];
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private needsRender = true;
  private lastSnapshot: ViewSnapshot | null = null;
  private hovered: string | null = null;
  private dragState: {
    mode: 'translate' | 'rotate';
    axis: 'x' | 'y' | 'z';
    axisWorld: THREE.Vector3;
    pivot: THREE.Vector3;
    startParam: number;
    lastValue: number;
    lastAngle: number;
    accumulated: number;
    ringBasis?: { b1: THREE.Vector3; b2: THREE.Vector3 };
    pointerId: number;
    moved: boolean;
  } | null = null;
  private pointerDownInfo: { x: number; y: number; additive: boolean; shift: boolean } | null = null;
  private gizmoHitMeshes: Array<{ obj: THREE.Object3D; mode: 'translate' | 'rotate'; axis: 'x' | 'y' | 'z' }> = [];
  private activeDragAxis: 'x' | 'y' | 'z' | null = null;
  private handleBaseColors = new Map<string, number>();
  private dragReadout: HTMLDivElement | null = null;
  private translateHandles = new THREE.Group();
  private rotateHandles = new THREE.Group();
  private pivotMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffd08a, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  private sceneRadius = 4;
  private labelLayer: HTMLElement;

  constructor(container: HTMLElement, callbacks: ViewportCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(COLORS.background, 1);
    this.renderer.domElement.className = 'viewport-canvas';
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    this.labelLayer = this.labelRenderer.domElement;
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 5000);
    this.camera.position.set(6, 5, 8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.05;
    this.controls.maxDistance = 500;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener('change', () => {
      if (this.lastSnapshot) this.updateGizmo(this.lastSnapshot);
      this.requestRender();
    });

    this.scene.add(this.nodeRoot);
    this.scene.add(this.gizmoRoot);
    this.setupEnvironment();
    this.setupGizmo();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerUp);
    canvas.addEventListener('pointerleave', () => {
      if (this.hovered) {
        this.hovered = null;
        this.applyHighlights();
        this.requestRender();
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());

    this.loop();
  }

  private setupEnvironment(): void {
    const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x1a2230, 1.15);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff2dd, 1.65);
    key.position.set(7, 12, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 100;
    key.shadow.camera.left = -18;
    key.shadow.camera.right = 18;
    key.shadow.camera.top = 18;
    key.shadow.camera.bottom = -18;
    key.shadow.bias = -0.0008;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x8fb4ff, 0.5);
    rim.position.set(-8, 4, -7);
    this.scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x0f151d, roughness: 0.96, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(40, 40, COLORS.grid, COLORS.gridFaint);
    grid.position.y = 0.001;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.75;
    this.scene.add(grid);

    const axes = new THREE.AxesHelper(1.4);
    axes.position.y = 0.002;
    this.scene.add(axes);
  }

  private setupGizmo(): void {
    this.gizmoRoot.add(this.translateHandles, this.rotateHandles);
    this.pivotMarker.renderOrder = 999;
    this.gizmoRoot.add(this.pivotMarker);
    this.gizmoRoot.visible = false;
  }

  private requestRender(): void {
    this.needsRender = true;
  }

  private loop = (): void => {
    this.frame = requestAnimationFrame(this.loop);
    this.controls.update();
    if (this.needsRender) {
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
    }
  };

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
    this.dragReadout?.remove();
    for (const id of [...this.nodeVisuals.keys()]) this.removeVisual(id);
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.container;
    const width = Math.max(1, clientWidth);
    const height = Math.max(1, clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);
    this.requestRender();
  }

  /**
   * On narrow screens compact labels are shown for selected/active nodes only,
   * otherwise overlapping labels cover the entire viewport.
   */
  private labelVisibleFor(id: string): boolean {
    if (!this.lastSnapshot) return true;
    const priority = this.lastSnapshot.selection.has(id) || this.lastSnapshot.active === id;
    if (priority) return true;
    if (!this.lastSnapshot.showLabels) return false;
    if (this.container.clientWidth <= 720) return false;
    // Declutter dense scenes: selected/active always show, otherwise cap labels.
    return this.nodeVisuals.size <= LABEL_BUDGET;
  }

  setShowLabels(show: boolean): void {
    if (this.lastSnapshot) {
      this.lastSnapshot.showLabels = show;
      for (const visual of this.nodeVisuals.values()) visual.label.visible = show;
      this.requestRender();
    }
  }

  setSnapshot(snapshot: ViewSnapshot): void {
    this.lastSnapshot = snapshot;
    const ids = new Set(snapshot.state.order);
    for (const id of [...this.nodeVisuals.keys()]) {
      if (!ids.has(id)) this.removeVisual(id);
    }

    let radius = 1;
    for (const id of snapshot.state.order) {
      const node = snapshot.state.nodes.get(id)!;
      const world = snapshot.worlds.get(id);
      if (!world) continue;
      const boxKey = `${node.box[0]},${node.box[1]},${node.box[2]}`;
      let visual = this.nodeVisuals.get(id);
      if (!visual) {
        visual = this.createVisual(id, node.box);
        this.nodeVisuals.set(id, visual);
      } else if (visual.boxKey !== boxKey) {
        visual.mesh.geometry.dispose();
        visual.mesh.geometry = new THREE.BoxGeometry(node.box[0], node.box[1], node.box[2]);
        visual.edges.geometry.dispose();
        visual.edges.geometry = new THREE.EdgesGeometry(visual.mesh.geometry);
        visual.boxKey = boxKey;
      }
      const matrix = matrixFromRowMajor(world);
      visual.mesh.matrix.copy(matrix);
      visual.mesh.matrixAutoUpdate = false;
      visual.mesh.matrixWorldNeedsUpdate = true;
      visual.mesh.updateMatrixWorld(true);
      visual.edges.matrix.copy(matrix);
      visual.edges.matrixAutoUpdate = false;
      visual.edges.matrixWorldNeedsUpdate = true;
      visual.edges.updateMatrixWorld(true);
      const labelPos = new THREE.Vector3(world[3], world[7], world[11]);
      visual.label.position.copy(labelPos);
      visual.label.visible = snapshot.showLabels && this.labelVisibleFor(id);
      const info = linearInfo(world);
      const scale = Math.max(node.box[0], node.box[1], node.box[2]);
      const reach = Math.max(scale, Math.hypot(world[3], world[7], world[11]));
      radius = Math.max(radius, reach + scale);
      visual.labelEl.dataset.flags = `${info.singular ? 'S' : ''}${info.mirrored ? 'M' : ''}`;
      visual.labelEl.title = `${id}${info.singular ? ' · 世界矩阵奇异' : ''}${info.mirrored ? ' · 镜像' : ''}${info.sheared ? ' · 剪切' : ''}`;
    }
    this.sceneRadius = Math.max(1, radius);
    this.meshes = [...this.nodeVisuals.values()].map((v) => v.mesh);
    this.updateGizmo(snapshot);
    this.applyHighlights(snapshot);
    this.requestRender();
  }

  private createVisual(id: string, box: Vec3): NodeVisual {
    const geometry = new THREE.BoxGeometry(box[0], box[1], box[2]);
    const material = new THREE.MeshStandardMaterial({
      color: COLORS.base,
      roughness: 0.55,
      metalness: 0.08,
      transparent: true,
      opacity: 0.94,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.userData.nodeId = id;
    this.nodeRoot.add(mesh);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: COLORS.baseEdge }));
    edges.matrixAutoUpdate = false;
    edges.raycast = () => undefined;
    this.nodeRoot.add(edges);

    const labelEl = document.createElement('div');
    labelEl.className = 'node-label';
    labelEl.textContent = id;
    const label = new CSS2DObject(labelEl);
    label.center.set(0.5, 0.5);
    this.nodeRoot.add(label);

    return { mesh, edges, label, labelEl, boxKey: `${box[0]},${box[1]},${box[2]}` };
  }

  private removeVisual(id: string): void {
    const visual = this.nodeVisuals.get(id);
    if (!visual) return;
    this.nodeRoot.remove(visual.mesh, visual.edges, visual.label);
    visual.mesh.geometry.dispose();
    visual.mesh.material.dispose();
    visual.edges.geometry.dispose();
    visual.edges.material.dispose();
    visual.labelEl.remove();
    this.nodeVisuals.delete(id);
  }

  private applyHighlights(snapshot = this.lastSnapshot): void {
    if (!snapshot) return;
    for (const [id, visual] of this.nodeVisuals) {
      const isActive = snapshot.active === id;
      const isSelected = snapshot.selection.has(id);
      const isHovered = this.hovered === id;
      const info = linearInfo(snapshot.worlds.get(id) ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      if (isActive) {
        visual.mesh.material.color.setHex(COLORS.active);
        visual.mesh.material.emissive.setHex(0x0d3a3b);
        visual.mesh.material.opacity = 1;
        visual.mesh.material.depthWrite = true;
        visual.edges.material.color.setHex(COLORS.activeEdge);
        visual.labelEl.classList.add('active');
      } else if (isSelected) {
        visual.mesh.material.color.setHex(COLORS.selected);
        visual.mesh.material.emissive.setHex(0x3a2a0c);
        visual.mesh.material.opacity = 1;
        visual.edges.material.color.setHex(COLORS.selectedEdge);
        visual.labelEl.classList.remove('active');
      } else if (isHovered) {
        visual.mesh.material.color.setHex(COLORS.hover);
        visual.mesh.material.emissive.setHex(0x101820);
        visual.mesh.material.opacity = 0.98;
        visual.edges.material.color.setHex(0x76859b);
        visual.labelEl.classList.remove('active');
      } else {
        visual.mesh.material.color.setHex(info.singular ? COLORS.singular : COLORS.base);
        visual.mesh.material.emissive.setHex(0x000000);
        visual.mesh.material.opacity = info.singular ? 0.55 : 0.9;
        visual.edges.material.color.setHex(info.singular ? 0x9d4141 : COLORS.baseEdge);
        visual.labelEl.classList.remove('active');
      }
      visual.labelEl.classList.toggle('selected', isSelected);
      visual.labelEl.classList.toggle('singular', info.singular);
      visual.label.visible = snapshot.showLabels && this.labelVisibleFor(id);
    }
    this.requestRender();
  }

  private updateGizmo(snapshot: ViewSnapshot): void {
    const { gizmo } = snapshot;
    if (!gizmo.pivot) {
      this.gizmoRoot.visible = false;
      return;
    }
    this.gizmoRoot.visible = true;
    const pivotVec = gizmo.pivot;
    const pivot = new THREE.Vector3(pivotVec[0], pivotVec[1], pivotVec[2]);
    // Keep the gizmo a constant apparent size regardless of zoom.
    const cameraDistance = this.camera.position.distanceTo(pivot);
    const radius = Math.max(0.05, cameraDistance * 0.13);
    this.pivotMarker.position.copy(pivot);
    this.pivotMarker.material.color.setHex(gizmo.mode === 'rotate' ? 0xa6f2f3 : 0xffd08a);

    const worldAxis: Record<'x' | 'y' | 'z', THREE.Vector3> = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
    };
    const axes = gizmo.space === 'local' && gizmo.localAxes ? gizmo.localAxes : { x: [1, 0, 0] as Vec3, y: [0, 1, 0] as Vec3, z: [0, 0, 1] as Vec3 };

    for (const mode of ['translate', 'rotate'] as const) {
      const group = mode === 'translate' ? this.translateHandles : this.rotateHandles;
      group.visible = gizmo.mode === mode;
      const scale = mode === 'translate' ? radius : radius * 0.85;
      group.position.copy(pivot);
      group.scale.setScalar(scale);
      for (const key of ['x', 'y', 'z'] as const) {
        const object = group.getObjectByName(`${mode}-${key}`);
        if (!object) continue;
        const dir = unitAxis(axes[key]);
        if (mode === 'translate') {
          object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        } else {
          object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        }
      }
    }
    // Keep unused worldAxis reference meaningful for TypeScript/linters.
    void worldAxis;
    this.requestRender();
  }

  private buildHandle(
    mode: 'translate' | 'rotate',
    axis: 'x' | 'y' | 'z',
    color: number,
  ): THREE.Object3D {
    const group = new THREE.Group();
    group.name = `${mode}-${axis}`;
    const visibleMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: mode === 'translate' ? 0.95 : 0.8, depthTest: false });
    const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    if (mode === 'translate') {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.72, 8), visibleMat);
      shaft.position.y = 0.36;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 12), visibleMat);
      head.position.y = 0.81;
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.95, 8), hitMat);
      hit.position.y = 0.45;
      for (const m of [shaft, head]) m.renderOrder = 1000;
      hit.renderOrder = 1000;
      group.add(shaft, head, hit);
      hit.userData.gizmo = { mode, axis };
      this.gizmoHitMeshes.push({ obj: hit, mode, axis });
    } else {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.012, 8, 64), visibleMat);
      ring.renderOrder = 1000;
      const hit = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.07, 8, 48), hitMat);
      hit.renderOrder = 1000;
      hit.userData.gizmo = { mode, axis };
      group.add(ring, hit);
      this.gizmoHitMeshes.push({ obj: hit, mode, axis });
    }
    return group;
  }

  ensureHandles(): void {
    if (this.translateHandles.children.length > 0) return;
    for (const axis of ['x', 'y', 'z'] as const) {
      this.translateHandles.add(this.buildHandle('translate', axis, AXIS_COLORS[axis]));
      this.rotateHandles.add(this.buildHandle('rotate', axis, AXIS_COLORS[axis]));
    }
  }

  /** Dims the other axes while dragging, so the active axis reads clearly. */
  private setHandleEmphasis(mode: 'translate' | 'rotate' | null, axis: 'x' | 'y' | 'z' | null): void {
    for (const group of [this.translateHandles, this.rotateHandles]) {
      for (const child of group.children) {
        const key = (child as THREE.Group).name;
        const [childMode, childAxis] = key.split('-') as ['translate' | 'rotate', 'x' | 'y' | 'z'];
        if (!childMode || childMode !== mode) continue;
        const active = child.name === `${mode}-${axis}`;
        for (const sub of child.children) {
          const material = (sub as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
          if (!material || !material.color) continue;
          if (material.transparent === false) continue;
          if (material.opacity === 0) continue; // invisible hit proxy
          if (!this.handleBaseColors.has(sub.uuid)) this.handleBaseColors.set(sub.uuid, material.color.getHex());
          const base = this.handleBaseColors.get(sub.uuid)!;
          material.color.setHex(active ? 0xffffff : base);
          material.opacity = active ? 1 : 0.28;
        }
      }
    }
    this.requestRender();
  }

  private isHandleShown(object: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  }

  private setRayFromEvent(event: PointerEvent | MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.ensureHandles();
    this.setRayFromEvent(event);
    // THREE.Raycaster ignores Object3D.visible, so filter to the active mode's
    // handles explicitly. Otherwise hidden rings would swallow clicks on the scene.
    const mode = this.lastSnapshot?.gizmo.mode;
    const activeHandles = this.gizmoHitMeshes
      .filter((handle) => handle.mode === mode && this.isHandleShown(handle.obj))
      .map((handle) => handle.obj);
    const hits = activeHandles.length > 0 ? this.raycaster.intersectObjects(activeHandles, false) : [];
    if (hits.length > 0) {
      const hit = hits[0].object.userData.gizmo as { mode: 'translate' | 'rotate'; axis: 'x' | 'y' | 'z' } | undefined;
      if (hit) {
        this.beginGizmoDrag(hit.mode, hit.axis, event);
        return;
      }
    }
    this.pointerDownInfo = { x: event.clientX, y: event.clientY, additive: event.shiftKey, shift: event.shiftKey };
  };

  private beginGizmoDrag(mode: 'translate' | 'rotate', axis: 'x' | 'y' | 'z', event: PointerEvent): void {
    if (!this.lastSnapshot?.gizmo.pivot) return;
    const snapshot = this.lastSnapshot;
    const pivotVec = snapshot.gizmo.pivot;
    if (!pivotVec) return;
    const pivot = vec3(pivotVec);
    const axes = snapshot.gizmo.space === 'local' && snapshot.gizmo.localAxes
      ? snapshot.gizmo.localAxes
      : { x: [1, 0, 0] as Vec3, y: [0, 1, 0] as Vec3, z: [0, 0, 1] as Vec3 };
    const axisWorld = unitAxis(axes[axis]);
    this.setRayFromEvent(event);
    this.controls.enabled = false;
    // Keep the gizmo on screen during the drag; the active axis is emphasized and
    // other axes dim, which reads better than making the whole gizmo vanish.
    this.activeDragAxis = axis;
    this.setHandleEmphasis(mode, axis);
    this.renderer.domElement.setPointerCapture(event.pointerId);

    if (mode === 'translate') {
      // Plane through the pivot that contains the drag axis and faces the camera
      // as much as possible; this keeps projection onto the axis stable even when
      // the axis is close to the view direction.
      const viewDir = new THREE.Vector3();
      this.camera.getWorldDirection(viewDir);
      const normal = viewDir.clone().addScaledVector(axisWorld, -viewDir.dot(axisWorld));
      if (normal.lengthSq() < 1e-8) normal.copy(viewDir);
      normal.normalize();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pivot);
      const point = new THREE.Vector3();
      const ok = this.raycaster.ray.intersectPlane(plane, point);
      const param = ok ? point.clone().sub(pivot).dot(axisWorld) : 0;
      this.dragState = {
        mode,
        axis,
        axisWorld,
        pivot,
        startParam: param,
        lastValue: 0,
        lastAngle: 0,
        accumulated: 0,
        pointerId: event.pointerId,
        moved: false,
      };
    } else {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axisWorld, pivot);
      const point = new THREE.Vector3();
      const ok = this.raycaster.ray.intersectPlane(plane, point);
      if (!ok) {
        this.controls.enabled = true;
        return;
      }
      const radial = point.clone().sub(pivot);
      radial.addScaledVector(axisWorld, -radial.dot(axisWorld));
      if (radial.lengthSq() < 1e-10) {
        radial.set(1, 0, 0).addScaledVector(axisWorld, -axisWorld.x);
      }
      radial.normalize();
      const b1 = radial.clone();
      const b2 = new THREE.Vector3().crossVectors(axisWorld, b1).normalize();
      this.dragState = {
        mode,
        axis,
        axisWorld,
        pivot,
        startParam: 0,
        lastValue: 0,
        lastAngle: 0,
        accumulated: 0,
        ringBasis: { b1, b2 },
        pointerId: event.pointerId,
        moved: false,
      };
    }
    // Add a floating value readout that follows the pointer while dragging.
    if (!this.dragReadout) {
      this.dragReadout = document.createElement('div');
      this.dragReadout.className = 'drag-readout';
      this.container.append(this.dragReadout);
    }
    this.dragReadout.textContent = mode === 'translate' ? '平移 0 m' : '旋转 0°';
    this.dragReadout.style.display = 'block';
    this.positionReadout(event);
    event.preventDefault();
    event.stopPropagation();
  }

  private positionReadout(event: PointerEvent): void {
    if (!this.dragReadout) return;
    const rect = this.container.getBoundingClientRect();
    this.dragReadout.style.left = `${event.clientX - rect.left + 16}px`;
    this.dragReadout.style.top = `${event.clientY - rect.top + 14}px`;
  }

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.dragState) {
      this.updateDrag(event);
      return;
    }
    if (this.pointerDownInfo) return;
    this.setRayFromEvent(event);
    const hits = this.raycaster.intersectObjects(this.meshes, false);
    const nextHover = hits.length > 0 ? (hits[0].object.userData.nodeId as string) : null;
    if (nextHover !== this.hovered) {
      this.hovered = nextHover;
      this.applyHighlights();
      this.renderer.domElement.style.cursor = nextHover ? 'pointer' : '';
    }
  };

  private updateDrag(event: PointerEvent): void {
    const drag = this.dragState;
    if (!drag) return;
    this.setRayFromEvent(event);
    let value = drag.lastValue;
    if (drag.mode === 'translate') {
      const viewDir = new THREE.Vector3();
      this.camera.getWorldDirection(viewDir);
      const normal = viewDir.clone().addScaledVector(drag.axisWorld, -viewDir.dot(drag.axisWorld));
      if (normal.lengthSq() < 1e-8) normal.copy(viewDir);
      normal.normalize();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, drag.pivot);
      const point = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, point)) {
        const param = point.clone().sub(drag.pivot).dot(drag.axisWorld);
        value = param - drag.startParam;
        if (event.shiftKey) value = Math.round(value * 20) / 20; // 0.05 m snap
        else value = Math.round(value * 1000) / 1000;
      }
    } else if (drag.ringBasis) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(drag.axisWorld, drag.pivot);
      const point = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, point)) {
        const radial = point.clone().sub(drag.pivot);
        const angle = Math.atan2(radial.dot(drag.ringBasis.b2), radial.dot(drag.ringBasis.b1));
        let delta = angle - drag.lastAngle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        if (!Number.isFinite(delta) || Math.abs(delta) < 1e-7) delta = 0;
        drag.lastAngle = angle;
        drag.accumulated += (delta * 180) / Math.PI;
        value = event.shiftKey ? Math.round(drag.accumulated / 15) * 15 : Math.round(drag.accumulated * 10) / 10;
      }
    }
    if (Math.abs(value - drag.lastValue) > 1e-9) {
      drag.lastValue = value;
      drag.moved = true;
      this.callbacks.onGizmoPreview(drag.mode, drag.axis, value);
    }
    if (this.dragReadout) {
      const sign = value >= 0 ? '+' : '';
      this.dragReadout.textContent = `${drag.mode === 'translate' ? '平移' : '旋转'} ${drag.axis.toUpperCase()} ${sign}${value.toFixed(3)}${drag.mode === 'rotate' ? '°' : ' m'}`;
      this.positionReadout(event);
    }
    this.requestRender();
  }

  private endDrag(commit: boolean): void {
    const drag = this.dragState;
    if (!drag) return;
    this.dragState = null;
    this.controls.enabled = true;
    this.activeDragAxis = null;
    this.setHandleEmphasis(null, null);
    if (this.dragReadout) this.dragReadout.style.display = 'none';
    if (this.renderer.domElement.hasPointerCapture(drag.pointerId)) {
      this.renderer.domElement.releasePointerCapture(drag.pointerId);
    }
    this.gizmoRoot.visible = true;
    if (this.lastSnapshot) this.updateGizmo(this.lastSnapshot);
    this.gizmoRoot.visible = !!this.lastSnapshot?.gizmo.pivot;
    if (commit && drag.moved) this.callbacks.onGizmoCommit(drag.mode, drag.axis, drag.lastValue);
    else this.callbacks.onGizmoCancel();
    this.requestRender();
  }

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.dragState) {
      this.endDrag(true);
      return;
    }
    const downInfo = this.pointerDownInfo;
    this.pointerDownInfo = null;
    if (!downInfo) return;
    const moved = Math.hypot(event.clientX - downInfo.x, event.clientY - downInfo.y);
    if (moved > 5) return; // orbit drag, not a click
    this.setRayFromEvent(event);
    const hits = this.raycaster.intersectObjects(this.meshes, false);
    if (hits.length > 0) {
      const id = hits[0].object.userData.nodeId as string;
      this.callbacks.onPick(id, downInfo.additive, downInfo.shift && false);
    } else {
      this.callbacks.onPick(null, downInfo.additive, false);
    }
  };

  cancelDrag(): void {
    if (this.dragState) this.endDrag(false);
    this.pointerDownInfo = null;
  }

  isDragging(): boolean {
    return this.dragState !== null;
  }

  frameAll(snapshot: ViewSnapshot): void {
    const center = new THREE.Vector3();
    let count = 0;
    const box = new THREE.Box3();
    for (const id of snapshot.state.order) {
      const world = snapshot.worlds.get(id);
      const node = snapshot.state.nodes.get(id);
      if (!world || !node) continue;
      const m = matrixFromRowMajor(world);
      for (const sx of [-0.5, 0.5]) {
        for (const sy of [-0.5, 0.5]) {
          for (const sz of [-0.5, 0.5]) {
            const p = new THREE.Vector3(node.box[0] * sx, node.box[1] * sy, node.box[2] * sz).applyMatrix4(m);
            box.expandByPoint(p);
            center.add(p);
            count += 1;
          }
        }
      }
    }
    if (count === 0) {
      this.controls.target.set(0, 0, 0);
      this.camera.position.set(6, 5, 8);
      this.controls.update();
      this.requestRender();
      return;
    }
    center.multiplyScalar(1 / count);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.5);
    this.controls.target.copy(sphere.center);
    const dir = new THREE.Vector3(0.85, 0.72, 1.05).normalize();
    // Account for vertical FOV and aspect so the bounding sphere always fits,
    // including on short/portrait viewports.
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const fitDistance = radius / Math.sin(Math.min(vFov, hFov) / 2);
    this.camera.position.copy(sphere.center).addScaledVector(dir, Math.max(fitDistance * 1.08, radius * 1.6));
    this.camera.near = Math.max(0.01, radius / 500);
    this.camera.far = Math.max(1000, radius * 200);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /** Screen (client) coordinates of a world point; used by tooltips and tests. */
  projectPoint(point: Vec3 | [number, number, number]): { x: number; y: number } | null {
    const v = new THREE.Vector3(point[0], point[1], point[2]).project(this.camera);
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    };
  }

  /** Current world-space gizmo axis direction for a given axis key. */
  gizmoAxisWorld(axis: 'x' | 'y' | 'z'): [number, number, number] | null {
    const snapshot = this.lastSnapshot;
    if (!snapshot?.gizmo.pivot) return null;
    const axes = snapshot.gizmo.space === 'local' && snapshot.gizmo.localAxes
      ? snapshot.gizmo.localAxes
      : { x: [1, 0, 0] as Vec3, y: [0, 1, 0] as Vec3, z: [0, 0, 1] as Vec3 };
    const unit = unitAxis(axes[axis]);
    return [unit.x, unit.y, unit.z];
  }

  /** Screen-space distance covered by one gizmo radius. */
  gizmoRadiusPx(): number {
    const snapshot = this.lastSnapshot;
    if (!snapshot?.gizmo.pivot) return 0;
    const pivot = snapshot.gizmo.pivot;
    const center = this.projectPoint(pivot);
    if (!center) return 0;
    const cameraDistance = this.camera.position.distanceTo(new THREE.Vector3(pivot[0], pivot[1], pivot[2]));
    const r = Math.max(0.05, cameraDistance * 0.13);
    const dir = this.camera.up.clone().normalize();
    const edge = this.projectPoint([pivot[0] + dir.x * r, pivot[1] + dir.y * r, pivot[2] + dir.z * r]);
    if (!edge) return 0;
    return Math.hypot(edge.x - center.x, edge.y - center.y);
  }

  /**
   * Pans the orbit target to a node without changing zoom, so selecting in the
   * tree never yanks the camera into a box. `zoom` is used for double-click.
   */
  focusNode(id: string, zoom = false): void {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return;
    const world = snapshot.worlds.get(id);
    if (!world) return;
    const target = new THREE.Vector3(world[3], world[7], world[11]);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const currentDistance = offset.length();
    const node = snapshot.state.nodes.get(id);
    const size = node ? Math.max(node.box[0], node.box[1], node.box[2]) : 1;
    const minDistance = size * 2.2;
    const distance = zoom ? Math.max(minDistance, this.sceneRadius * 0.35) : Math.max(minDistance, currentDistance);
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(offset.normalize(), distance);
    this.controls.update();
    this.requestRender();
  }
}

export { matrixFromRowMajor };
