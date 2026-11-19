/*
 * 调试台应用状态与控制逻辑（无框架，原生 JS）
 * 依赖 engine.js / broadphase.js / validate.js（经典脚本，全局 SCL）
 */
(function () {
  'use strict';

  var engine = SCL.engine;
  var broad = SCL.broadphase;
  var validate = SCL.validate;

  // 内置示例场景（摘自 cases.json，便于无文件环境直接体验）
  var BUILTIN_SCENES = [
    {
      name: '穿过薄墙',
      dt: 1,
      bodies: [
        { id: 'a', position: [-5, 0], velocity: [10, 0],
          vertices: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
          layer: 0, mask: 255, sensor: false },
        { id: 'b', position: [0, 0], velocity: [0, 0],
          vertices: [[-0.5, -2], [0.5, -2], [0.5, 2], [-0.5, 2]],
          layer: 0, mask: 255, sensor: false }
      ]
    },
    {
      name: '静止初始重叠',
      dt: 1,
      bodies: [
        { id: 'a', position: [0, 0], velocity: [0, 0],
          vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false },
        { id: 'b', position: [1, 0], velocity: [0, 0],
          vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
      ]
    },
    {
      name: '末端相切',
      dt: 1,
      bodies: [
        { id: 'a', position: [-4, 0], velocity: [2, 0],
          vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false },
        { id: 'b', position: [0, 0], velocity: [0, 0],
          vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
      ]
    },
    {
      name: '等速分离',
      dt: 1,
      bodies: [
        { id: 'a', position: [-4, 0], velocity: [2, 1],
          vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false },
        { id: 'b', position: [0, 0], velocity: [2, 1],
          vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
      ]
    },
    {
      name: '单向掩码不碰撞',
      dt: 1,
      bodies: [
        { id: 'a', position: [0, 0], velocity: [0, 0],
          vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 1, mask: 1, sensor: false },
        { id: 'b', position: [0, 0], velocity: [0, 0],
          vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 1, sensor: false }
      ]
    },
    {
      name: '传感器擦边',
      dt: 1,
      bodies: [
        { id: 'a', position: [-4, 2], velocity: [8, 0],
          vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: true },
        { id: 'b', position: [0, 0], velocity: [0, 0],
          vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], layer: 0, mask: 255, sensor: false }
      ]
    }
  ];

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  function App() {
    this.scene = deepCopy(BUILTIN_SCENES[0]);
    this.sceneName = BUILTIN_SCENES[0].name;
    this.time = 0;                 // 帧内时间
    this.playing = false;
    this.playSpeed = 1;
    this.selectedPair = null;      // [idA, idB]
    this.showSweptBoxes = true;
    this.showTrails = true;
    this.pipeline = null;
    this.lastFrameMs = null;
    this.importedResult = null;    // 导入的检测结果（用于外部结果对照）
    this._recompute();
  }

  App.prototype._recompute = function () {
    var v = validate.validateScene(this.scene);
    this.validation = v;
    if (v.ok) {
      this.pipeline = broad.runPipeline(this.scene);
    } else {
      this.pipeline = null;
    }
    // 选中对失效则清空
    if (this.selectedPair && this.pipeline) {
      var exists = this.pipeline.referenceContacts.some(function (r) {
        return r.a === this.selectedPair[0] && r.b === this.selectedPair[1];
      }, this);
      if (!exists) this.selectedPair = null;
    }
  };

  App.prototype.loadScene = function (scene, name) {
    this.scene = deepCopy(scene);
    this.sceneName = name || '自定义场景';
    this.time = 0;
    this.playing = false;
    this.selectedPair = null;
    this.importedResult = null;
    this._recompute();
  };

  App.prototype.setTime = function (t) {
    var max = this.scene.dt;
    this.time = Math.max(0, Math.min(max, Number(t) || 0));
  };

  App.prototype.togglePlay = function () {
    if (!this.validation.ok) return;
    this.playing = !this.playing;
    if (this.playing && this.time >= this.scene.dt - 1e-12) this.time = 0;
    this.lastFrameMs = null;
  };

  App.prototype.stepFrame = function (dir) {
    // 逐帧走：以 dt 为步长推进，并按 dt 循环，便于观察整段运动
    var next = this.time + dir * this.scene.dt;
    if (next > this.scene.dt) next = 0;
    if (next < 0) next = this.scene.dt;
    this.setTime(next);
  };

  App.prototype.tick = function (nowMs) {
    if (!this.playing) return;
    if (this.lastFrameMs == null) this.lastFrameMs = nowMs;
    var dtSec = (nowMs - this.lastFrameMs) / 1000 * this.playSpeed;
    this.lastFrameMs = nowMs;
    this.time += dtSec;
    if (this.time >= this.scene.dt) {
      this.time = this.scene.dt;
      this.playing = false;
    }
  };

  App.prototype.bodyById = function (id) {
    for (var i = 0; i < this.scene.bodies.length; i++) {
      if (this.scene.bodies[i].id === id) return this.scene.bodies[i];
    }
    return null;
  };

  App.prototype.selectedRecord = function () {
    if (!this.selectedPair || !this.pipeline) return null;
    var key = this.selectedPair[0] + '|' + this.selectedPair[1];
    for (var i = 0; i < this.pipeline.referenceContacts.length; i++) {
      var r = this.pipeline.referenceContacts[i];
      if (r.a + '|' + r.b === key) return r;
    }
    return null;
  };

  App.prototype.exportScene = function () {
    return JSON.stringify({ dt: this.scene.dt, bodies: this.scene.bodies }, null, 2);
  };

  App.prototype.exportResult = function () {
    if (!this.pipeline) return JSON.stringify({ error: '场景校验未通过', errors: this.validation.errors });
    return JSON.stringify({
      dt: this.scene.dt,
      generatedAt: new Date().toISOString(),
      contacts: this.pipeline.referenceContacts.map(engine.publicRecord)
    }, null, 2);
  };

  App.prototype.importResult = function (text) {
    var data = JSON.parse(text);
    if (!data || !Array.isArray(data.contacts)) {
      throw new Error('结果文件需包含 contacts 数组');
    }
    this.importedResult = data;
    return data;
  };

  // 当前场景接触对与导入结果的差异比对
  App.prototype.diffImported = function () {
    if (!this.importedResult || !this.pipeline) return null;
    var mine = {};
    this.pipeline.referenceContacts.forEach(function (r) {
      mine[r.a + '|' + r.b] = engine.publicRecord(r);
    });
    var theirs = {};
    this.importedResult.contacts.forEach(function (r) {
      theirs[r.a + '|' + r.b] = r;
    });
    var missing = [], extra = [], changed = [];
    Object.keys(theirs).forEach(function (k) {
      if (!mine[k]) missing.push(k);
      else {
        var a = mine[k], b = theirs[k];
        if (Math.abs(a.tEnter - b.tEnter) > 1e-9 ||
            Math.abs(a.tExit - b.tExit) > 1e-9 ||
            a.startOverlap !== b.startOverlap ||
            Math.abs(a.normal[0] - b.normal[0]) > 1e-8 ||
            Math.abs(a.normal[1] - b.normal[1]) > 1e-8 ||
            a.sensor !== b.sensor) {
          changed.push(k);
        }
      }
    });
    Object.keys(mine).forEach(function (k) {
      if (!theirs[k]) extra.push(k);
    });
    return { missing: missing, extra: extra, changed: changed };
  };

  App.prototype.addBody = function () {
    var n = this.scene.bodies.length;
    var id = 'body' + n;
    var base = 1;
    while (this.bodyById(id)) { id = 'body' + (++n); }
    this.scene.bodies.push({
      id: id,
      position: [0, 0],
      velocity: [1, 0],
      vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
      layer: 0, mask: 255, sensor: false
    });
    this._recompute();
    return id;
  };

  App.prototype.removeBody = function (id) {
    this.scene.bodies = this.scene.bodies.filter(function (b) { return b.id !== id; });
    if (this.selectedPair && this.selectedPair.indexOf(id) >= 0) this.selectedPair = null;
    this._recompute();
  };

  App.prototype.mutate = function (fn) {
    fn(this.scene);
    this._recompute();
  };

  SCL.App = App;
  SCL.BUILTIN_SCENES = BUILTIN_SCENES;
})();
