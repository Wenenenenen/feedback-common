/*
 * 场景数据校验。返回 { ok, errors: [{bodyId?, message}] }
 * 规则依据 说明.txt：id 唯一；3~8 顶点；严格凸、逆时针、无重复；
 * layer 0..7；mask 0..255；dt 为正且不超过 2；上限 512 物体。
 */
(function (global) {
  'use strict';

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function cross(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  function validateBody(b, errors) {
    var tag = (b && b.id != null) ? String(b.id) : '?';
    if (!b || typeof b !== 'object') {
      errors.push({ bodyId: tag, message: '物体不是对象' });
      return;
    }
    if (typeof b.id !== 'string' || b.id.length === 0) {
      errors.push({ bodyId: tag, message: 'id 必须为非空字符串' });
    }
    ['position', 'velocity'].forEach(function (f) {
      if (!Array.isArray(b[f]) || b[f].length !== 2 ||
          !isNum(b[f][0]) || !isNum(b[f][1])) {
        errors.push({ bodyId: tag, message: f + ' 必须是两个有限数' });
      }
    });
    if (!isNum(b.layer) || b.layer < 0 || b.layer > 7 ||
        Math.floor(b.layer) !== b.layer) {
      errors.push({ bodyId: tag, message: 'layer 必须是 0..7 的整数' });
    }
    if (!isNum(b.mask) || b.mask < 0 || b.mask > 255 ||
        Math.floor(b.mask) !== b.mask) {
      errors.push({ bodyId: tag, message: 'mask 必须是 0..255 的整数' });
    }
    if (typeof b.sensor !== 'boolean') {
      errors.push({ bodyId: tag, message: 'sensor 必须是布尔值' });
    }
    var vs = b.vertices;
    if (!Array.isArray(vs) || vs.length < 3 || vs.length > 8) {
      errors.push({ bodyId: tag, message: '顶点数必须在 3..8 之间' });
      return;
    }
    for (var i = 0; i < vs.length; i++) {
      if (!Array.isArray(vs[i]) || vs[i].length !== 2 ||
          !isNum(vs[i][0]) || !isNum(vs[i][1])) {
        errors.push({ bodyId: tag, message: '顶点 ' + i + ' 不是两个有限数' });
        return;
      }
    }
    // 无重复
    var seen = {};
    for (var k = 0; k < vs.length; k++) {
      var key = vs[k][0] + ',' + vs[k][1];
      if (seen[key]) {
        errors.push({ bodyId: tag, message: '存在重复顶点 ' + key });
        return;
      }
      seen[key] = true;
    }
    // 严格凸、逆时针：所有相邻边叉积必须为正（CCW）
    var n = vs.length;
    for (var j = 0; j < n; j++) {
      var c = cross(vs[j], vs[(j + 1) % n], vs[(j + 2) % n]);
      if (!(c > 1e-10)) {
        errors.push({
          bodyId: tag,
          message: '顶点 ' + j + ' 处不是严格逆时针凸多边形（叉积=' +
            Number(c.toPrecision(6)) + '）'
        });
        return;
      }
    }
  }

  function validateScene(scene) {
    var errors = [];
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
      return { ok: false, errors: [{ bodyId: null, message: '场景必须是对象' }] };
    }
    if (!isNum(scene.dt) || scene.dt <= 0 || scene.dt > 2) {
      errors.push({ bodyId: null, message: 'dt 必须为正且不超过 2' });
    }
    if (!Array.isArray(scene.bodies)) {
      errors.push({ bodyId: null, message: 'bodies 必须是数组' });
      return { ok: false, errors: errors };
    }
    if (scene.bodies.length > 512) {
      errors.push({ bodyId: null, message: '物体数量超过上限 512' });
    }
    var ids = {};
    scene.bodies.forEach(function (b) {
      validateBody(b, errors);
      if (b && typeof b.id === 'string') {
        if (ids[b.id]) errors.push({ bodyId: b.id, message: 'id 重复' });
        ids[b.id] = true;
      }
    });
    return { ok: errors.length === 0, errors: errors };
  }

  var API = { validateScene: validateScene };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }
  global.SCL = global.SCL || {};
  global.SCL.validate = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
