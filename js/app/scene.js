/* Three.js 场景：笼线框、碎片网格、笼点/碎片拖拽与归属拾取、非法单元与越界面高亮。 */
(function (global) {
  'use strict';

  const CELL_COLORS = [
    0x4fc3f7, 0x81c784, 0xffb74d, 0xe57373, 0xba68c8, 0x4db6ac,
    0xaed581, 0xffd54f, 0x64b5f6, 0xf06292, 0x7986cb, 0x4dd0e1,
  ];
  const colorOfCell = (id) => CELL_COLORS[id % CELL_COLORS.length];

  function createScene(container) {
    const THREE = global.THREE;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101418);

    const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 100000);
    camera.position.set(40, 35, 55);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(30, 50, 40);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-40, -20, -30);
    scene.add(fill);

    const cageGroup = new THREE.Group();
    const fragGroup = new THREE.Group();
    const markerGroup = new THREE.Group();
    scene.add(cageGroup, fragGroup, markerGroup);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const api = {
      THREE, scene, camera, renderer, controls,
      cageGroup, fragGroup, markerGroup, raycaster, mouse,
      cellPointMeshes: [], cagePointObjects: [], dragPlane: new THREE.Plane(),
      selected: null, onPick: null, onDragEnd: null,
    };

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    global.addEventListener('resize', resize);

    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();
    return api;
  }

  /* ---------------- 笼渲染 ---------------- */
  function renderCage(ctx, rest, pose, cells, badCells, opts) {
    const THREE = ctx.THREE;
    ctx.cageGroup.clear();
    ctx.cellPointMeshes = [];
    ctx.cagePointObjects = [];
    const showPose = opts && opts.showPose;
    const points = showPose ? pose : rest;
    const badSet = new Set(badCells);

    // 线框：单元 6 条边
    const edges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
    const linePos = [], lineColor = [];
    const cBad = new THREE.Color(0xff3b30), cOk = new THREE.Color(0x9fb4c7);
    cells.forEach((cell, ci) => {
      const col = badSet.has(ci) ? cBad : cOk;
      for (const [i, j] of edges) {
        const a = points[cell[i]], b = points[cell[j]];
        linePos.push(...a, ...b);
        lineColor.push(col.r, col.g, col.b, col.r, col.g, col.b);
      }
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(lineColor, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    ctx.cageGroup.add(lines);

    // 可拖拽笼点（顶点去重）
    const seen = new Set();
    const sphereGeo = new THREE.SphereGeometry(0.9, 16, 12);
    points.forEach((p, vi) => {
      if (seen.has(vi)) return;
      // 顶点编号即下标，rest/pose 同拓扑；仅为实际被引用的顶点建 marker
      const used = cells.some(c => c.includes(vi));
      if (!used) return;
      seen.add(vi);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffd54f, emissive: 0x553300, roughness: 0.4 });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.position.set(p[0], p[1], p[2]);
      mesh.userData = { kind: 'cagePoint', index: vi };
      ctx.cageGroup.add(mesh);
      ctx.cellPointMeshes.push(mesh);
      ctx.cagePointObjects.push({ vi, mesh });
    });
  }

  /* ---------------- 碎片渲染 ---------------- */
  function renderFragments(ctx, result, opts) {
    const THREE = ctx.THREE;
    ctx.fragGroup.clear();
    if (!result) return;
    const useDeformed = !(opts && opts.rest);
    const showNormals = opts && opts.normals;
    const positions = [], normals = [], colors = [];
    const perFragmentMeshes = [];

    for (const fr of result.fragments) {
      const base = positions.length / 3;
      const col = new THREE.Color(colorOfCell(fr.cellId));
      const ids = fr.vertIds;
      // 扇形三角化（碎片为凸多边形）
      for (let k = 1; k + 1 < ids.length; k++) {
        const tri = [ids[0], ids[k], ids[k + 1]];
        for (let c = 0; c < 3; c++) {
          const gvId = tri[c];
          const gv = result.verts[gvId];
          const p = useDeformed ? gv.deformed : gv.rest;
          positions.push(p[0], p[1], p[2]);
          let n;
          if (useDeformed && fr.deformedNormals) n = fr.deformedNormals[c];
          else n = fr.cornerNormals[c];
          normals.push(n[0], n[1], n[2]);
          colors.push(col.r, col.g, col.b);
        }
      }
      perFragmentMeshes.push({ fragment: fr, vertexBase: base, color: col.getHex() });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.05,
      transparent: opts && opts.opacity != null, opacity: opts && opts.opacity != null ? opts.opacity : 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { kind: 'fragmentMesh', perFragmentMeshes };
    ctx.fragGroup.add(mesh);
    ctx.fragmentMesh = mesh;

    // 法线辅助线
    if (showNormals) {
      const nPos = [];
      result.fragments.forEach(fr => {
        fr.vertIds.forEach((gvId, c) => {
          const gv = result.verts[gvId];
          const p = useDeformed ? gv.deformed : gv.rest;
          const n = useDeformed && fr.deformedNormals ? fr.deformedNormals[c] : fr.cornerNormals[c];
          nPos.push(p[0], p[1], p[2], p[0] + n[0] * 2, p[1] + n[1] * 2, p[2] + n[2] * 2);
        });
      });
      const ng = new THREE.BufferGeometry();
      ng.setAttribute('position', new THREE.Float32BufferAttribute(nPos, 3));
      ctx.fragGroup.add(new THREE.LineSegments(ng, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 })));
    }
  }

  /* ---------------- 越界面/非法单元标记 ---------------- */
  function renderMarkers(ctx, result, data, opts) {
    const THREE = ctx.THREE;
    ctx.markerGroup.clear();
    if (!result) return;
    // 越界原面：红色高亮三角形
    if (result.badFaces.length) {
      const pos = [];
      result.badFaces.forEach(fi => {
        const face = data.faces[fi];
        if (!face || !face.p) return;
        const tri = face.p;
        for (let k = 1; k + 1 < 3; k++) for (const idx of [0, k, k + 1]) pos.push(...tri[idx]);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.MeshBasicMaterial({ color: 0xff1744, side: THREE.DoubleSide, transparent: true, opacity: 0.55 });
      const mesh = new THREE.Mesh(g, m);
      mesh.userData = { kind: 'badFace' };
      ctx.markerGroup.add(mesh);
    }
  }

  /* ---------------- 拾取与拖拽 ---------------- */
  function bindInteraction(ctx, container, callbacks) {
    const THREE = ctx.THREE;
    let dragging = null;

    function setMouse(ev) {
      const rect = renderer_domRect(ctx);
      ctx.mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      ctx.mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    }
    function renderer_domRect(c) { return c.renderer.domElement.getBoundingClientRect(); }

    container.addEventListener('pointerdown', (ev) => {
      setMouse(ev);
      ctx.raycaster.setFromCamera(ctx.mouse, ctx.camera);
      const hitsCage = ctx.raycaster.intersectObjects(ctx.cellPointMeshes, false);
      if (hitsCage.length) {
        const obj = hitsCage[0].object;
        dragging = { kind: 'cagePoint', obj, index: obj.userData.index };
        controls_dragEnable(ctx, false);
        ev.preventDefault();
        return;
      }
      if (ctx.fragmentMesh) {
        const hits = ctx.raycaster.intersectObject(ctx.fragmentMesh, false);
        if (hits.length && callbacks.onFragmentPick) {
          const face = hits[0].face;
          callbacks.onFragmentPick(hits[0], ctx.fragmentMesh.userData.perFragmentMeshes);
        }
      }
    });

    container.addEventListener('pointermove', (ev) => {
      if (!dragging) {
        // 悬停光标反馈
        setMouse(ev);
        ctx.raycaster.setFromCamera(ctx.mouse, ctx.camera);
        const onCage = ctx.raycaster.intersectObjects(ctx.cellPointMeshes, false).length > 0;
        container.style.cursor = onCage ? 'grab' : (ctx.fragmentMesh ? 'pointer' : 'default');
        return;
      }
      setMouse(ev);
      ctx.raycaster.setFromCamera(ctx.mouse, ctx.camera);
      if (dragging.kind === 'cagePoint') {
        // 过拾取点、平行相机视平面的拖拽平面
        const normal = ctx.camera.getWorldDirection(new THREE.Vector3());
        ctx.dragPlane.setFromNormalAndCoplanarPoint(normal, dragging.obj.position);
        const pt = new THREE.Vector3();
        if (ctx.raycaster.ray.intersectPlane(ctx.dragPlane, pt)) {
          dragging.obj.position.copy(pt);
          if (callbacks.onCageDrag) callbacks.onCageDrag(dragging.index, [pt.x, pt.y, pt.z]);
        }
      }
    });

    const endDrag = () => {
      if (dragging) {
        if (callbacks.onDragEnd) callbacks.onDragEnd(dragging);
        dragging = null;
        controls_dragEnable(ctx, true);
      }
    };
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointerleave', endDrag);
  }
  function controls_dragEnable(ctx, en) { ctx.controls.enabled = en; }

  function highlightFragment(ctx, fragment) {
    const THREE = ctx.THREE;
    if (ctx._hl) { ctx._hl.geometry.dispose(); ctx.fragGroup.remove(ctx._hl); ctx._hl = null; }
    if (!fragment || !ctx._highlightVerts) return;
    const pts = fragment.vertIds.map(id => ctx._highlightVerts[id]);
    const pos = [];
    for (let k = 1; k + 1 < pts.length; k++) {
      for (const idx of [0, k, k + 1]) { const p = pts[idx]; pos.push(p[0], p[1], p[2]); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const hl = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffff00, side: THREE.DoubleSide, transparent: true, opacity: 0.35 }));
    ctx.fragGroup.add(hl);
    ctx._hl = hl;
  }

  global.TCScene = {
    createScene, renderCage, renderFragments, renderMarkers,
    bindInteraction, highlightFragment, colorOfCell,
    setHighlightVerts(ctx, verts) { ctx._highlightVerts = verts; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
