/* 3D mesh view built on three.js r128 (global THREE + OrbitControls). */
(function (global) {
  'use strict';

  function ThreeView(container, callbacks) {
    this.container = container;
    this.cb = callbacks;
    this.faceCount = 0;
    this.selected = -1;
    this.hover = -1;
    this.cycleFaces = [];
    this.filterSet = null;
    this.showLabels = true;

    var w = Math.max(320, container.clientWidth);
    var h = Math.max(320, container.clientHeight);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, w / h, 1e-6, 1e6);
    this.camera.position.set(1.4, 1.1, 1.8);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 0.85));
    var dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(2, 3, 4);
    this.scene.add(dir);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._down = null;

    this._bindEvents();
    this._renderLoop();
    this._ro = new ResizeObserver(this._resize.bind(this));
    this._ro.observe(container);
  }

  ThreeView.prototype._bindEvents = function () {
    var el = this.renderer.domElement;
    el.addEventListener('pointerdown', function (e) {
      this._down = { x: e.clientX, y: e.clientY };
    }.bind(this));
    el.addEventListener('pointerup', function (e) {
      if (!this._down) return;
      var dx = e.clientX - this._down.x, dy = e.clientY - this._down.y;
      this._down = null;
      if (dx * dx + dy * dy > 25) return; // was an orbit drag
      this._pick(e);
    }.bind(this));
    el.addEventListener('pointermove', function (e) {
      var rect = el.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this._updateHover(e);
    }.bind(this));
    el.addEventListener('pointerleave', function () {
      if (this.hover !== -1) { this.hover = -1; this._refreshColors(); }
      this.cb.onHover(-1);
    }.bind(this));
  };

  ThreeView.prototype._resize = function () {
    var w = Math.max(320, this.container.clientWidth);
    var h = Math.max(320, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  ThreeView.prototype._renderLoop = function () {
    requestAnimationFrame(this._renderLoop.bind(this));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // data: {vertices, faces}; result: engine analysis output (may be null).
  ThreeView.prototype.setData = function (data, result, palette) {
    this._clearGroup();
    this.data = data;
    this.result = result;
    this.palette = palette;
    this.selected = -1;
    this.hover = -1;
    var n = data.faces.length;
    this.faceCount = n;

    var positions = new Float32Array(n * 9);
    var colors = new Float32Array(n * 9);
    var edgePos = [];
    for (var i = 0; i < n; i++) {
      var f = data.faces[i];
      for (var k = 0; k < 3; k++) {
        var v = data.vertices[f[k]];
        var o = (i * 3 + k) * 3;
        positions[o] = v[0]; positions[o + 1] = v[1]; positions[o + 2] = v[2];
      }
      for (k = 0; k < 3; k++) {
        var a = data.vertices[f[k]], b = data.vertices[f[(k + 1) % 3]];
        edgePos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.geo = geo;

    // Neutral fill while analysis is still running; _refreshColors repaints
    // once the result arrives.
    var neutral = new THREE.Color(palette.neutral);
    for (var ci = 0; ci < n; ci++) {
      for (var ck = 0; ck < 3; ck++) {
        colors[(ci * 3 + ck) * 3] = neutral.r;
        colors[(ci * 3 + ck) * 3 + 1] = neutral.g;
        colors[(ci * 3 + ck) * 3 + 2] = neutral.b;
      }
    }

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      flatShading: true,
      roughness: 0.72,
      metalness: 0.05,
      transparent: true,
      opacity: 0.96
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.group = new THREE.Group();
    this.group.add(this.mesh);

    var edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    this.edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({
      color: new THREE.Color(palette.edge),
      transparent: true,
      opacity: 0.35
    }));
    this.group.add(this.edges);

    // Dedicated wireframe for the selected face, repainted on selection change.
    var selPos = new Float32Array(18);
    var selGeo = new THREE.BufferGeometry();
    selGeo.setAttribute('position', new THREE.BufferAttribute(selPos, 3));
    this.selLines = new THREE.LineSegments(selGeo, new THREE.LineBasicMaterial({
      color: new THREE.Color(palette.sel3d),
      transparent: true,
      opacity: 0.95,
      linewidth: 2
    }));
    this.selLines.visible = false;
    this.group.add(this.selLines);

    this.scene.add(this.group);

    this._refreshColors();
    this.resetView();
  };

  ThreeView.prototype._clearGroup = function () {
    if (this.group) {
      this.scene.remove(this.group);
      this.geo.dispose();
      this.material.dispose();
      this.edges.geometry.dispose();
      this.edges.material.dispose();
      this.selLines.geometry.dispose();
      this.selLines.material.dispose();
      this.group = null;
      this._box = null;
    }
  };

  ThreeView.prototype._updateSelectionLines = function () {
    var lines = this.selLines;
    if (!lines) return;
    if (this.selected < 0 || !this.data) {
      lines.visible = false;
      return;
    }
    var f = this.data.faces[this.selected];
    var arr = lines.geometry.getAttribute('position').array;
    var o = 0;
    for (var k = 0; k < 3; k++) {
      var a = this.data.vertices[f[k]], b = this.data.vertices[f[(k + 1) % 3]];
      arr[o++] = a[0]; arr[o++] = a[1]; arr[o++] = a[2];
      arr[o++] = b[0]; arr[o++] = b[1]; arr[o++] = b[2];
    }
    lines.geometry.getAttribute('position').needsUpdate = true;
    lines.material.color.set(this.palette.sel3d);
    lines.visible = true;
  };

  ThreeView.prototype.resetView = function () {
    if (!this.geo) return;
    if (!this._box) {
      this._box = new THREE.Box3().setFromBufferAttribute(this.geo.getAttribute('position'));
      this._center = this._box.getCenter(new THREE.Vector3());
      this._size = this._box.getSize(new THREE.Vector3()).length() || 1;
    }
    var dirVec = new THREE.Vector3(1.25, 0.9, 1.5).normalize();
    this.camera.position.copy(this._center).addScaledVector(dirVec, this._size * 1.7);
    this.camera.near = Math.max(1e-5, this._size / 1000);
    this.camera.far = this._size * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(this._center);
    this.controls.update();
  };

  // Face status classification shared with the UV view.
  ThreeView.prototype._faceColor = function (i) {
    var p = this.palette, r = this.result;
    if (i === this.selected) return p.sel3d;
    if (i === this.hover) return p.hover;
    if (!r) return p.neutral;
    var m = r.metrics[i];
    var dim = this.filterSet && !this.filterSet.has(i);
    if (m.degenerate) return dim ? p.dim : p.degenerate;
    if (r.facePairs[i].length > 0) return dim ? p.dim : p.overlap;
    if (m.mirrored) return dim ? p.dim : p.mirror;
    if (m.outside) return dim ? p.dim : p.outside;
    if (this.stretchSet && this.stretchSet.has(i)) return dim ? p.dim : p.stretch;
    return dim ? p.dim : p.good;
  };

  ThreeView.prototype._refreshColors = function () {
    if (!this.geo || !this.result) return;
    var attr = this.geo.getAttribute('color');
    var col = new THREE.Color();
    for (var i = 0; i < this.faceCount; i++) {
      col.set(this._faceColor(i));
      for (var k = 0; k < 3; k++) {
        attr.array[(i * 3 + k) * 3] = col.r;
        attr.array[(i * 3 + k) * 3 + 1] = col.g;
        attr.array[(i * 3 + k) * 3 + 2] = col.b;
      }
    }
    attr.needsUpdate = true;
  };

  ThreeView.prototype.setFilter = function (filterSet, stretchSet) {
    this.filterSet = filterSet;
    this.stretchSet = stretchSet;
    this._refreshColors();
  };

  ThreeView.prototype.setSelection = function (faceId, cycleFaces) {
    this.selected = faceId;
    this.cycleFaces = cycleFaces || [];
    this._refreshColors();
    this._updateSelectionLines();
  };

  ThreeView.prototype._updateHover = function (e) {
    if (!this.mesh) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    var hits = this.raycaster.intersectObject(this.mesh, false);
    var id = hits.length ? Math.floor(hits[0].faceId / 1) : -1;
    if (id !== this.hover) {
      this.hover = id;
      this._refreshColors();
    }
    this.cb.onHover(id, e.clientX, e.clientY);
  };

  ThreeView.prototype._pick = function (e) {
    if (!this.mesh) return;
    var rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    var hits = this.raycaster.intersectObject(this.mesh, false);
    if (!hits.length) {
      this.cb.onPick(-1);
      return;
    }
    var id = hits[0].faceId;
    // A 3D face maps to one triangle, but its UV location may host several
    // faces; the controller decides the cycling list.
    this.cb.onPick(id);
  };

  global.ThreeView = ThreeView;
})(typeof window !== 'undefined' ? window : globalThis);
