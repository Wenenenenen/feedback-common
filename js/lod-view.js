/* 三维视图：Three.js r128，左右两个渲染器共享相机视角 */
(function (global) {
  'use strict';

  // 材质编号 -> 确定性调色板（HSL 均匀取色，亮度适中，明暗主题都可读）
  function materialColor(matId) {
    var hue = (matId * 0.61803398875) % 1;
    var c = new THREE.Color();
    c.setHSL(hue, 0.55, 0.55);
    return c;
  }

  // 距离 -> 热图色（蓝 -> 青 -> 绿 -> 黄 -> 红）
  var HEAT_STOPS = [
    [0.00, [0.10, 0.20, 0.65]],
    [0.20, [0.10, 0.55, 0.85]],
    [0.40, [0.20, 0.75, 0.55]],
    [0.60, [0.85, 0.85, 0.25]],
    [0.80, [0.95, 0.50, 0.15]],
    [1.00, [0.85, 0.12, 0.12]]
  ];
  function heatColorRGB(t) {
    t = Math.max(0, Math.min(1, t));
    for (var i = 0; i < HEAT_STOPS.length - 1; i++) {
      var s0 = HEAT_STOPS[i], s1 = HEAT_STOPS[i + 1];
      if (t <= s1[0]) {
        var f = (t - s0[0]) / (s1[0] - s0[0]);
        return new THREE.Color(
          s0[1][0] + (s1[1][0] - s0[1][0]) * f,
          s0[1][1] + (s1[1][1] - s0[1][1]) * f,
          s0[1][2] + (s1[1][2] - s0[1][2]) * f
        );
      }
    }
    var last = HEAT_STOPS[HEAT_STOPS.length - 1][1];
    return new THREE.Color(last[0], last[1], last[2]);
  }

  function MeshView(container, opts) {
    this.container = container;
    this.opts = opts || {};
    this.showWire = true;
    this.showLocks = true;
    this.heatDistances = null; // 提供则按原顶点距离着色
    this.heatMax = 1;
    this.group = new THREE.Group();
    this._init();
  }

  MeshView.prototype._init = function () {
    var w = Math.max(50, this.container.clientWidth);
    var h = Math.max(50, this.container.clientHeight);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.001, 1000);
    this.camera.position.set(2.2, 1.6, 2.6);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    this.container.appendChild(this.renderer.domElement);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    // 灯光
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    var key = new THREE.DirectionalLight(0xffffff, 0.75);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    var fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-3, -1, -2);
    this.scene.add(fill);

    this.scene.add(this.group);
    this._bounding = new THREE.Box3();
  };

  MeshView.prototype._clear = function () {
    while (this.group.children.length) {
      var obj = this.group.children[0];
      this.group.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(function (m) { m.dispose(); });
        else obj.material.dispose();
      }
    }
  };

  /*
   * mesh: {vertices, faces, materials}
   * lockedOriginalIds / vertexMap: 锁定点需要原编号与输出顶点的映射
   */
  MeshView.prototype.setMesh = function (mesh, lockedOriginalIds, isSimplified) {
    this._clear();
    var self = this;
    var V = mesh.vertices.length;
    var positions = new Float32Array(V * 3);
    for (var i = 0; i < V; i++) {
      positions[i * 3] = mesh.vertices[i][0];
      positions[i * 3 + 1] = mesh.vertices[i][1];
      positions[i * 3 + 2] = mesh.vertices[i][2];
    }
    var nTri = mesh.faces.length;
    var indices = new Uint32Array(nTri * 3);
    var colors = new Float32Array(V * 3);
    for (var f = 0; f < nTri; f++) {
      indices[f * 3] = mesh.faces[f][0];
      indices[f * 3 + 1] = mesh.faces[f][1];
      indices[f * 3 + 2] = mesh.faces[f][2];
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();

    // 着色：热图优先，否则按材质编号
    if (this.heatDistances) {
      for (var vi = 0; vi < V; vi++) {
        var origId = isSimplified && mesh.vertexMap ? mesh.vertexMap[vi] : vi;
        var d = this.heatDistances[origId] || 0;
        var col = heatColorRGB(this.heatMax > 0 ? d / this.heatMax : 0);
        colors[vi * 3] = col.r; colors[vi * 3 + 1] = col.g; colors[vi * 3 + 2] = col.b;
      }
    } else {
      // 逐面材质 -> 顶点色（面内一致）
      var faceColor = mesh.materials.map(function (m) { return materialColor(m); });
      var acc = new Array(V);
      var cnt = new Uint16Array(V);
      for (var v2 = 0; v2 < V; v2++) acc[v2] = new THREE.Color(0, 0, 0);
      for (var f2 = 0; f2 < nTri; f2++) {
        var fc = faceColor[f2];
        mesh.faces[f2].forEach(function (vidx) {
          acc[vidx].r += fc.r; acc[vidx].g += fc.g; acc[vidx].b += fc.b;
          cnt[vidx]++;
        });
      }
      // 按邻接面数归一化，保证颜色落在 0..1，避免多面共享顶点被钳成白色
      acc.forEach(function (c, idx) {
        var n = cnt[idx] || 1;
        colors[idx * 3] = c.r / n; colors[idx * 3 + 1] = c.g / n; colors[idx * 3 + 2] = c.b / n;
      });
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    var mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      flatShading: true,
      roughness: 0.75,
      metalness: 0.05,
      transparent: true,
      opacity: this.heatDistances ? 0.92 : 1.0
    });
    this.solidMesh = new THREE.Mesh(geo, mat);
    this.group.add(this.solidMesh);

    // 线框颜色随主题：读取 CSS 变量（rgb 三元组），失败回退中性灰
    var wireColor = 0x6b7686;
    try {
      var raw = getComputedStyle(document.documentElement).getPropertyValue('--wire').trim();
      if (raw) {
        var parts = raw.split(/\s+/).map(function (x) { return parseFloat(x); });
        if (parts.length === 3 && parts.every(function (n) { return !isNaN(n); })) {
          wireColor = (parts[0] << 16) | (parts[1] << 8) | parts[2];
        }
      }
    } catch (e) { /* 回退默认 */ }
    var edges = new THREE.EdgesGeometry(geo, 1);
    var lineMat = new THREE.LineBasicMaterial({ color: wireColor, transparent: true, opacity: 0.6 });
    this.wire = new THREE.LineSegments(edges, lineMat);
    this.wire.visible = this.showWire;
    this.group.add(this.wire);

    // 锁定点（用原编号在输出网格中定位；原模型直接按编号）
    if (lockedOriginalIds && lockedOriginalIds.length) {
      var map = isSimplified && mesh.vertexMap
        ? (function () { var m = {}; mesh.vertexMap.forEach(function (o, n) { m[o] = n; }); return m; })()
        : null;
      var pts = [];
      lockedOriginalIds.forEach(function (orig) {
        var vid = map ? map[orig] : orig;
        if (vid === undefined || vid === null || vid >= V) return;
        pts.push(mesh.vertices[vid][0], mesh.vertices[vid][1], mesh.vertices[vid][2]);
      });
      if (pts.length) {
        var pg = new THREE.BufferGeometry();
        pg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        var pm = new THREE.PointsMaterial({
          color: 0xff4d4d, size: 0.055, sizeAttenuation: true
        });
        this.lockPoints = new THREE.Points(pg, pm);
        this.lockPoints.visible = this.showLocks;
        this.group.add(this.lockPoints);
      }
    }

    geo.computeBoundingBox();
    this._bounding = geo.boundingBox.clone();
    this.fitCamera(this._bounding);
  };

  MeshView.prototype.setWireVisible = function (v) {
    this.showWire = v;
    if (this.wire) this.wire.visible = v;
  };
  MeshView.prototype.setLocksVisible = function (v) {
    this.showLocks = v;
    if (this.lockPoints) this.lockPoints.visible = v;
  };
  MeshView.prototype.setHeat = function (distances, maxD) {
    this.heatDistances = distances;
    this.heatMax = maxD || 1;
  };

  MeshView.prototype.fitCamera = function (box) {
    if (!box || box.isEmpty()) return;
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var radius = Math.max(size.length() / 2, 1e-6);
    var dist = radius / Math.sin(Math.PI * this.camera.fov / 360);
    var dir = new THREE.Vector3(2.2, 1.6, 2.6).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist * 1.15);
    this.camera.near = Math.max(dist / 1000, 1e-5);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  };

  // 用另一个视图的相机位姿同步本视图
  MeshView.prototype.syncFrom = function (other) {
    this.camera.position.copy(other.camera.position);
    this.camera.quaternion.copy(other.camera.quaternion);
    this.controls.target.copy(other.controls.target);
    this.camera.near = other.camera.near;
    this.camera.far = other.camera.far;
    this.camera.updateProjectionMatrix();
  };

  MeshView.prototype.render = function () { this.controls.update(); this.renderer.render(this.scene, this.camera); };
  MeshView.prototype.resize = function () {
    var w = Math.max(50, this.container.clientWidth);
    var h = Math.max(50, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  global.LODView = {
    MeshView: MeshView,
    materialColor: materialColor,
    heatColorRGB: heatColorRGB,
    HEAT_STOPS: HEAT_STOPS
  };
})(typeof window !== 'undefined' ? window : globalThis);
