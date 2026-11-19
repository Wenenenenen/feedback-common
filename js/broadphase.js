/*
 * 宽阶段：整段运动的扫掠 AABB（t=0 与 t=dt 两帧 AABB 的并集）
 * 边界相交保留。提供 sweep-and-prune 实现与全量两两精测对照。
 */
(function (global) {
  'use strict';

  var engine = (function () {
    if (typeof module !== 'undefined' && module.exports) return require('./engine.js');
    return globalThis.SCL.engine;
  })();

  function aabbAt(body, t) {
    var px = body.position[0] + body.velocity[0] * t;
    var py = body.position[1] + body.velocity[1] * t;
    var mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (var i = 0; i < body.vertices.length; i++) {
      var x = body.vertices[i][0] + px;
      var y = body.vertices[i][1] + py;
      if (x < mnx) mnx = x;
      if (x > mxx) mxx = x;
      if (y < mny) mny = y;
      if (y > mxy) mxy = y;
    }
    return { minX: mnx, maxX: mxx, minY: mny, maxY: mxy };
  }

  // 整段运动的扫掠包围盒
  function sweptAABB(body, dt) {
    var a = aabbAt(body, 0);
    var b = aabbAt(body, dt);
    return {
      minX: Math.min(a.minX, b.minX),
      maxX: Math.max(a.maxX, b.maxX),
      minY: Math.min(a.minY, b.minY),
      maxY: Math.max(a.maxY, b.maxY)
    };
  }

  function aabbOverlap(a, b) {
    // 边界相交保留
    return a.minX <= b.maxX && b.minX <= a.maxX &&
           a.minY <= b.maxY && b.minY <= a.maxY;
  }

  function keyOf(idA, idB) { return idA < idB ? idA + '|' + idB : idB + '|' + idA; }

  // sweep-and-prune：x 轴扫掠 + y 区间复核
  function broadPhaseSAP(bodies, dt) {
    var items = bodies.map(function (b) {
      return { id: b.id, box: sweptAABB(b, dt) };
    }).sort(function (p, q) {
      return p.box.minX - q.box.minX || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
    });
    var active = [];
    var pairs = [];
    for (var i = 0; i < items.length; i++) {
      var cur = items[i];
      // 弹出 x 已分离（含边界：maxX < minX 才算不相交）的活动项
      active = active.filter(function (other) {
        return other.box.maxX >= cur.box.minX;
      });
      for (var k = 0; k < active.length; k++) {
        var o = active[k];
        if (cur.box.minY <= o.box.maxY && o.box.minY <= cur.box.maxY) {
          pairs.push(o.id < cur.id ? [o.id, cur.id] : [cur.id, o.id]);
        }
      }
      active.push(cur);
    }
    pairs.sort(function (p, q) {
      return p[0] < q[0] ? -1 : p[0] > q[0] ? 1 :
             p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0;
    });
    return pairs;
  }

  // 朴素 O(n^2) 宽阶段（测试对照用，验证 SAP 无漏报/一致）
  function broadPhaseBrute(bodies, dt) {
    var boxes = bodies.map(function (b) {
      return { id: b.id, box: sweptAABB(b, dt) };
    });
    var pairs = [];
    for (var i = 0; i < boxes.length; i++) {
      for (var j = i + 1; j < boxes.length; j++) {
        if (aabbOverlap(boxes[i].box, boxes[j].box)) {
          pairs.push(boxes[i].id < boxes[j].id
            ? [boxes[i].id, boxes[j].id]
            : [boxes[j].id, boxes[i].id]);
        }
      }
    }
    pairs.sort(function (p, q) {
      return p[0] < q[0] ? -1 : p[0] > q[0] ? 1 :
             p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0;
    });
    return pairs;
  }

  /*
   * 全量管线：
   *  - eligiblePairs：通过层/掩码的全部两两对
   *  - broadPairs：SAP 宽阶段候选（在 eligible 内）
   *  - contacts：精测接触记录（宽阶段候选中真正接触的对）
   *  - referenceContacts：全量两两精测（不经宽阶段），作为对照基准
   *  - falseNegatives：宽阶段漏掉的真实接触（漏报，正确实现应为空）
   *  - broadOnly：宽阶段候选但精测无接触（多报）
   */
  function runPipeline(scene) {
    var bodies = scene.bodies.slice().sort(function (x, y) {
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
    var byId = {};
    bodies.forEach(function (b) { byId[b.id] = b; });

    var eligiblePairs = [];
    for (var i = 0; i < bodies.length; i++) {
      for (var j = i + 1; j < bodies.length; j++) {
        if (engine.maskPairOk(bodies[i], bodies[j])) {
          eligiblePairs.push([bodies[i].id, bodies[j].id]);
        }
      }
    }

    var sapAll = broadPhaseSAP(bodies, scene.dt);
    var eligibleSet = {};
    eligiblePairs.forEach(function (p) { eligibleSet[keyOf(p[0], p[1])] = true; });
    var broadPairs = sapAll.filter(function (p) { return eligibleSet[keyOf(p[0], p[1])]; });
    var broadSet = {};
    broadPairs.forEach(function (p) { broadSet[keyOf(p[0], p[1])] = true; });

    var contacts = [];
    var broadOnly = [];
    broadPairs.forEach(function (p) {
      var rec = engine.detectPair(byId[p[0]], byId[p[1]], scene.dt);
      if (rec) contacts.push(rec);
      else broadOnly.push(p);
    });

    var referenceContacts = [];
    eligiblePairs.forEach(function (p) {
      var rec = engine.detectPair(byId[p[0]], byId[p[1]], scene.dt);
      if (rec) referenceContacts.push(rec);
    });

    var contactSet = {};
    referenceContacts.forEach(function (r) { contactSet[keyOf(r.a, r.b)] = true; });

    var falseNegatives = referenceContacts.filter(function (r) {
      return !broadSet[keyOf(r.a, r.b)];
    }).map(function (r) { return [r.a, r.b]; });

    return {
      eligiblePairs: eligiblePairs,
      broadPairs: broadPairs,
      contacts: contacts,
      referenceContacts: referenceContacts,
      falseNegatives: falseNegatives,
      broadOnly: broadOnly,
      sweptBoxes: bodies.map(function (b) {
        return { id: b.id, box: sweptAABB(b, scene.dt) };
      })
    };
  }

  var API = {
    aabbAt: aabbAt,
    sweptAABB: sweptAABB,
    aabbOverlap: aabbOverlap,
    broadPhaseSAP: broadPhaseSAP,
    broadPhaseBrute: broadPhaseBrute,
    runPipeline: runPipeline
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }
  global.SCL = global.SCL || {};
  global.SCL.broadphase = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
