// 赛道与车辆渲染（Canvas 2D，无第三方库）。
// 只读 view 快照：渲染绝不写入逻辑状态；幽灵位置由 recorder 的插值结果提供。
(function (root) {
  'use strict';

  var THEMES = {
    dark: {
      bg: '#0b0f14',
      grid: 'rgba(122, 142, 163, 0.10)',
      gridMajor: 'rgba(122, 142, 163, 0.22)',
      road: '#141b23',
      roadEdge: 'rgba(126, 148, 170, 0.30)',
      roadCenter: 'rgba(126, 148, 170, 0.22)',
      fg: '#e6edf3',
      muted: '#8b9bab',
      line: '#26313d',
      gate: '#5d6f80',
      gatePassed: '#3fb97a',
      gateTarget: '#4cc2ff',
      gateViolation: '#ef6a6a',
      arrow: '#cfdae6',
      car: '#ffb347',
      carDark: '#c9761a',
      ghost: '#57e2d5',
      trail: 'rgba(255, 179, 71, 0.28)',
      ghostTrail: 'rgba(87, 226, 213, 0.30)',
      start: '#f472b6',
      labelBg: 'rgba(11, 15, 20, 0.72)',
    },
    light: {
      bg: '#eef1f5',
      grid: 'rgba(55, 75, 95, 0.09)',
      gridMajor: 'rgba(55, 75, 95, 0.18)',
      road: '#dfe5ec',
      roadEdge: 'rgba(80, 100, 120, 0.35)',
      roadCenter: 'rgba(80, 100, 120, 0.25)',
      fg: '#18212b',
      muted: '#5a6672',
      line: '#c6cdd6',
      gate: '#7b8896',
      gatePassed: '#1f8d55',
      gateTarget: '#0b76b8',
      gateViolation: '#c93a3a',
      arrow: '#3d4a57',
      car: '#e07b16',
      carDark: '#a9550a',
      ghost: '#0f9c92',
      trail: 'rgba(224, 123, 22, 0.25)',
      ghostTrail: 'rgba(15, 156, 146, 0.28)',
      start: '#c13584',
      labelBg: 'rgba(255, 255, 255, 0.78)',
    },
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) {
      return a - b;
    });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function createRenderer(canvas, minimap) {
    var ctx = canvas.getContext('2d');
    var mctx = minimap ? minimap.getContext('2d') : null;
    var themeName = 'dark';
    var palette = THEMES.dark;
    var track = null;
    var cam = { x: 0, y: 0, scale: 9, mode: 'follow' };
    var effects = [];
    var egoTrail = [];
    var ghostTrail = [];
    var lastCar = null;
    var lastTick = null;
    var needFit = true;
    var width = 1;
    var height = 1;
    var dpr = 1;

    // 估算路面半宽：优先用赛道自带的 roadHalfWidth；否则用门半长的中位数
    var roadHalf = 8;
    function estimateRoadHalf() {
      if (!track) return 8;
      if (track.roadHalfWidth > 0) {
        roadHalf = track.roadHalfWidth;
        return;
      }
      if (!track.gates.length) return 8;
      var half = track.gates.map(function (g) {
        return Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) / 2;
      });
      roadHalf = Math.max(2.5, median(half));
    }

    function resize() {
      dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      var rect = canvas.getBoundingClientRect();
      width = Math.max(320, rect.width || canvas.clientWidth || 800);
      height = Math.max(240, rect.height || canvas.clientHeight || 500);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      if (minimap) {
        var mrect = minimap.getBoundingClientRect();
        var mw = Math.max(120, mrect.width || 220);
        var mh = Math.max(80, mrect.height || 140);
        minimap.width = Math.round(mw * dpr);
        minimap.height = Math.round(mh * dpr);
      }
      // 全景模式在尺寸变化后必须重新适配，否则缩放会停留在旧尺寸
      if (cam.mode === 'fit' || needFit) fitToTrack();
    }

    function bounds() {
      if (!track) return { minX: -50, minY: -50, maxX: 50, maxY: 50 };
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      function add(x, y) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      track.gates.forEach(function (g) {
        add(g.a[0], g.a[1]);
        add(g.b[0], g.b[1]);
      });
      if (track.waypoints) {
        track.waypoints.forEach(function (p) {
          add(p[0], p[1]);
        });
      }
      add(track.initial.x, track.initial.y);
      var pad = Math.max(6, roadHalf);
      return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    }

    function fitToTrack() {
      if (!track) return;
      var b = bounds();
      var w = Math.max(1, b.maxX - b.minX);
      var h = Math.max(1, b.maxY - b.minY);
      // 给 HUD 与内嵌小地图留出边距
      var scale = Math.min((width - 90) / w, (height - 90) / h);
      cam.scale = clamp(scale, 1.4, 26);
      cam.x = (b.minX + b.maxX) / 2;
      cam.y = (b.minY + b.maxY) / 2;
      cam.mode = 'fit';
      needFit = false;
    }

    function worldToScreen(x, y) {
      return {
        x: (x - cam.x) * cam.scale + width / 2,
        y: height / 2 - (y - cam.y) * cam.scale,
      };
    }

    function setTrack(t) {
      track = t;
      egoTrail = [];
      ghostTrail = [];
      effects = [];
      lastCar = null;
      lastTick = null;
      estimateRoadHalf();
      needFit = true;
      fitToTrack();
    }

    function setTheme(name) {
      themeName = THEMES[name] ? name : 'dark';
      palette = THEMES[themeName];
    }

    function setCameraMode(mode) {
      if (mode === 'fit') fitToTrack();
      else cam.mode = 'follow';
    }
    function getCameraMode() {
      return cam.mode;
    }
    function zoomBy(factor) {
      cam.scale = clamp(cam.scale * factor, 1.2, 60);
      if (cam.mode === 'fit') cam.mode = 'follow';
    }

    function addEffect(x, y, kind) {
      effects.push({ x: x, y: y, kind: kind, age: 0 });
      if (effects.length > 40) effects.shift();
    }

    // view: session.getView() 的快照
    function draw(view, dtMs) {
      if (!track) return;
      var p = palette;
      // 相机跟随
      if (view && view.car) {
        var car = view.car;
        if (cam.mode === 'follow') {
          if (lastCar) {
            var k = 1 - Math.pow(0.001, (dtMs || 16) / 1000);
            cam.x += (car.x - cam.x) * k;
            cam.y += (car.y - cam.y) * k;
          } else {
            cam.x = car.x;
            cam.y = car.y;
          }
        }
        lastCar = { x: car.x, y: car.y };
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = p.bg;
      ctx.fillRect(0, 0, width, height);
      drawGrid(p);

      var passedCount = view && view.progress && view.progress.started ? view.progress.gatesThisLap : 0;
      var targetIdx = view && view.progress && view.progress.started ? view.progress.expectedGate : 0;
      var finished = view && view.progress && view.progress.finished;

      drawRoad(p);
      drawTrail(p, ghostTrail, p.ghostTrail, 1.6);
      drawTrail(p, egoTrail, p.trail, 2.2);
      drawGates(p, targetIdx, passedCount, finished, view);

      if (view && view.ghost && view.ghost.pos && view.ghost.visible !== false) {
        drawCar(p, view.ghost.pos, p.ghost, true);
        drawGhostLabel(p, view.ghost.pos, view.ghost);
      }
      if (view && view.car) drawCar(p, view.car, p.car, false);
      drawEffects(p, dtMs);

      // 目标门在屏幕外的指示器
      if (view && view.progress && view.progress.started && !finished) {
        drawOffscreenTarget(p, view.progress.expectedGate);
      }

      if (mctx) drawMinimap(p, view);
    }

    function drawGrid(p) {
      var spacing = 10;
      while (spacing * cam.scale < 34) spacing *= 2;
      var b = screenBounds();
      var startX = Math.floor(b.minX / spacing) * spacing;
      var startY = Math.floor(b.minY / spacing) * spacing;
      ctx.lineWidth = 1;
      for (var x = startX; x <= b.maxX; x += spacing) {
        var sx = worldToScreen(x, 0).x;
        var major = Math.abs(Math.round(x / spacing)) % 5 === 0;
        ctx.strokeStyle = major ? p.gridMajor : p.grid;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, height);
        ctx.stroke();
      }
      for (var y = startY; y <= b.maxY; y += spacing) {
        var sy = worldToScreen(0, y).y;
        var majorY = Math.abs(Math.round(y / spacing)) % 5 === 0;
        ctx.strokeStyle = majorY ? p.gridMajor : p.grid;
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(width, sy);
        ctx.stroke();
      }
      // 比例尺：放在左边缘垂直居中，避开四角的 HUD 浮层
      var barMeters = spacing;
      var barPx = barMeters * cam.scale;
      var barY = Math.round(height / 2);
      ctx.strokeStyle = p.muted;
      ctx.fillStyle = p.muted;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(18, barY);
      ctx.lineTo(18 + barPx, barY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(18, barY - 4);
      ctx.lineTo(18, barY + 4);
      ctx.moveTo(18 + barPx, barY - 4);
      ctx.lineTo(18 + barPx, barY + 4);
      ctx.stroke();
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(barMeters + ' m', 20, barY - 9);
    }

    function screenBounds() {
      var a = worldFromScreen(0, 0);
      var b = worldFromScreen(width, height);
      return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
    }
    function worldFromScreen(sx, sy) {
      return { x: (sx - width / 2) / cam.scale + cam.x, y: (height / 2 - sy) / cam.scale + cam.y };
    }

    function drawRoad(p) {
      if (!track.waypoints || track.waypoints.length < 3) return;
      var pts = track.waypoints;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      var outer = Math.max(6, roadHalf * 2 * cam.scale);
      // 路肩（描边色）
      ctx.strokeStyle = p.roadEdge;
      ctx.lineWidth = outer;
      ctx.beginPath();
      tracePolyline(pts, true);
      ctx.stroke();
      // 路面
      ctx.strokeStyle = p.road;
      ctx.lineWidth = Math.max(3, outer - 3);
      ctx.beginPath();
      tracePolyline(pts, true);
      ctx.stroke();
      // 中心虚线
      ctx.setLineDash([10, 14]);
      ctx.strokeStyle = p.roadCenter;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      tracePolyline(pts, true);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function tracePolyline(pts, close) {
      for (var i = 0; i < pts.length; i++) {
        var s = worldToScreen(pts[i][0], pts[i][1]);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      }
      if (close) ctx.closePath();
    }

    function drawTrail(p, trail, color, w) {
      if (trail.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (var i = 0; i < trail.length; i++) {
        var s = worldToScreen(trail[i].x, trail[i].y);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
    }

    function drawGates(p, targetIdx, passedCount, finished, view) {
      var now = performance.now();
      for (var i = 0; i < track.gates.length; i++) {
        var g = track.gates[i];
        var a = worldToScreen(g.a[0], g.a[1]);
        var b = worldToScreen(g.b[0], g.b[1]);
        var isTarget = !finished && i === targetIdx;
        var passed = finished || i < passedCount;
        var color = isTarget ? p.gateTarget : passed ? p.gatePassed : p.gate;
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        var baseW = isTarget ? 5 : 3;

        if (isTarget) {
          var pulse = 0.5 + 0.5 * Math.sin(now / 240);
          ctx.save();
          ctx.globalAlpha = 0.25 + 0.25 * pulse;
          ctx.strokeStyle = p.gateTarget;
          ctx.lineWidth = baseW + 8 + pulse * 4;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.restore();
        }

        ctx.lineWidth = baseW;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        // 端点短桩
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x, a.y);
        ctx.stroke();
        drawGatePost(a, color);
        drawGatePost(b, color);

        // 方向箭头（normal 方向）
        var mx = (a.x + b.x) / 2;
        var my = (a.y + b.y) / 2;
        var nlen = 12;
        var nx = g.normal[0];
        var ny = -g.normal[1]; // 屏幕 y 向下
        ctx.strokeStyle = isTarget ? p.gateTarget : p.arrow;
        ctx.fillStyle = isTarget ? p.gateTarget : p.arrow;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mx - nx * nlen * 0.4, my - ny * nlen * 0.4);
        ctx.lineTo(mx + nx * nlen, my + ny * nlen);
        ctx.stroke();
        var ang = Math.atan2(ny, nx);
        ctx.beginPath();
        ctx.moveTo(mx + nx * nlen, my + ny * nlen);
        ctx.lineTo(
          mx + nx * nlen - Math.cos(ang - 0.45) * 7,
          my + ny * nlen - Math.sin(ang - 0.45) * 7
        );
        ctx.lineTo(
          mx + nx * nlen - Math.cos(ang + 0.45) * 7,
          my + ny * nlen - Math.sin(ang + 0.45) * 7
        );
        ctx.closePath();
        ctx.fill();

        // 编号
        var labelX = mx + nx * 18;
        var labelY = my + ny * 18;
        ctx.font = '600 11px ui-monospace, monospace';
        var text = String(i);
        var tw = ctx.measureText(text).width;
        ctx.fillStyle = p.labelBg;
        ctx.fillRect(labelX - tw / 2 - 4, labelY - 9, tw + 8, 16);
        ctx.fillStyle = isTarget ? p.gateTarget : passed ? p.gatePassed : p.fg;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, labelX, labelY + 0.5);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';

        if (i === 0) {
          // 起终点门额外标记
          ctx.fillStyle = p.start;
          ctx.font = '600 10px ui-monospace, monospace';
          ctx.fillText('START', labelX - tw / 2 - 4, labelY + 22);
        }
      }

      // 违规过的门打叉
      if (view && view.violations) {
        var seen = {};
        for (var k = Math.max(0, view.violations.length - 8); k < view.violations.length; k++) {
          var v = view.violations[k];
          if (seen[v.gate]) continue;
          seen[v.gate] = true;
          var vg = track.gates[v.gate];
          if (!vg) continue;
          var va = worldToScreen(vg.a[0], vg.a[1]);
          var vb = worldToScreen(vg.b[0], vg.b[1]);
          ctx.strokeStyle = p.gateViolation;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.moveTo(va.x, va.y);
          ctx.lineTo(vb.x, vb.y);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    function drawGatePost(s, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawCar(p, car, color, isGhost) {
      var s = worldToScreen(car.x, car.y);
      var ang = -car.yaw;
      var bodyL = Math.max(14, 4.3 * cam.scale);
      var bodyW = Math.max(8, 1.9 * cam.scale);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(ang);
      ctx.globalAlpha = isGhost ? 0.55 : 1;

      // 影子
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      roundRect(-bodyL / 2 + 2, -bodyW / 2 + 3, bodyL, bodyW, 4);
      ctx.fill();

      // 车身
      ctx.fillStyle = color;
      roundRect(-bodyL / 2, -bodyW / 2, bodyL, bodyW, 4);
      ctx.fill();
      ctx.strokeStyle = isGhost ? 'rgba(255,255,255,0.7)' : p.carDark;
      ctx.lineWidth = isGhost ? 1.2 : 1.6;
      ctx.stroke();

      // 前挡风
      ctx.fillStyle = 'rgba(10, 16, 24, 0.55)';
      roundRect(bodyL * 0.02, -bodyW * 0.34, bodyL * 0.26, bodyW * 0.68, 2);
      ctx.fill();

      // 车头指示
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(bodyL / 2 - 1, 0);
      ctx.lineTo(bodyL / 2 - 6, -bodyW * 0.28);
      ctx.lineTo(bodyL / 2 - 6, bodyW * 0.28);
      ctx.closePath();
      ctx.fill();

      if (isGhost) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1;
        roundRect(-bodyL / 2 - 2, -bodyW / 2 - 2, bodyL + 4, bodyW + 4, 5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    function roundRect(x, y, w, h, r) {
      var rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    function drawGhostLabel(p, pos, ghost) {
      var s = worldToScreen(pos.x, pos.y);
      var text = '幽灵';
      if (ghost.lapTime != null) text += ' ' + ghost.lapTime.toFixed(2) + 's';
      ctx.font = '600 10px ui-monospace, monospace';
      var tw = ctx.measureText(text).width;
      ctx.fillStyle = p.labelBg;
      ctx.fillRect(s.x + 12, s.y - 24, tw + 10, 15);
      ctx.fillStyle = p.ghost;
      ctx.fillText(text, s.x + 17, s.y - 13);
    }

    function drawEffects(p, dtMs) {
      var dt = Math.min(0.1, (dtMs || 16) / 1000);
      for (var i = effects.length - 1; i >= 0; i--) {
        var e = effects[i];
        e.age += dt;
        if (e.age > 0.7) {
          effects.splice(i, 1);
          continue;
        }
        var k = e.age / 0.7;
        var s = worldToScreen(e.x, e.y);
        var r = 6 + k * 26;
        ctx.strokeStyle =
          e.kind === 'violation'
            ? p.gateViolation
            : e.kind === 'lap'
            ? p.start
            : e.kind === 'start'
            ? p.start
            : p.gatePassed;
        ctx.globalAlpha = (1 - k) * 0.9;
        ctx.lineWidth = 2 + (1 - k) * 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    function drawOffscreenTarget(p, gateIdx) {
      var g = track.gates[gateIdx];
      if (!g) return;
      var mx = (g.a[0] + g.b[0]) / 2;
      var my = (g.a[1] + g.b[1]) / 2;
      var s = worldToScreen(mx, my);
      var margin = 34;
      if (s.x >= margin && s.x <= width - margin && s.y >= margin && s.y <= height - margin) return;
      var cx = width / 2;
      var cy = height / 2;
      var ang = Math.atan2(s.y - cy, s.x - cx);
      var rx = 0.5 * width - margin;
      var ry = 0.5 * height - margin;
      // 椭圆边缘定位
      var t = Math.min(
        Math.abs(rx / Math.cos(ang)),
        Math.abs(ry / Math.sin(ang))
      );
      var px = cx + Math.cos(ang) * t;
      var py = cy + Math.sin(ang) * t;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.fillStyle = p.gateTarget;
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(-6, -7);
      ctx.lineTo(-6, 7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function drawMinimap(p, view) {
      var mw = minimap.clientWidth || 220;
      var mh = minimap.clientHeight || 140;
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mctx.clearRect(0, 0, mw, mh);
      mctx.fillStyle = p.bg;
      mctx.fillRect(0, 0, mw, mh);
      mctx.strokeStyle = p.line;
      mctx.lineWidth = 1;
      mctx.strokeRect(0.5, 0.5, mw - 1, mh - 1);
      var b = bounds();
      var pad = 8;
      var sc = Math.min((mw - pad * 2) / Math.max(1, b.maxX - b.minX), (mh - pad * 2) / Math.max(1, b.maxY - b.minY));
      var ox = mw / 2 - ((b.minX + b.maxX) / 2) * sc;
      var oy = mh / 2 + ((b.minY + b.maxY) / 2) * sc;
      function m(x, y) {
        return { x: ox + x * sc, y: oy - y * sc };
      }
      // 路面
      if (track.waypoints && track.waypoints.length > 2) {
        mctx.strokeStyle = p.road;
        mctx.lineWidth = Math.max(4, roadHalf * 2 * sc);
        mctx.lineJoin = 'round';
        mctx.beginPath();
        for (var i = 0; i < track.waypoints.length; i++) {
          var q = m(track.waypoints[i][0], track.waypoints[i][1]);
          if (i === 0) mctx.moveTo(q.x, q.y);
          else mctx.lineTo(q.x, q.y);
        }
        mctx.closePath();
        mctx.stroke();
      }
      // 门
      var targetIdx = view && view.progress && view.progress.started ? view.progress.expectedGate : 0;
      var passed = view && view.progress && view.progress.started ? view.progress.gatesThisLap : 0;
      for (var k = 0; k < track.gates.length; k++) {
        var g = track.gates[k];
        var a = m(g.a[0], g.a[1]);
        var b2 = m(g.b[0], g.b[1]);
        var isT = view && view.progress && !view.progress.finished && k === targetIdx;
        mctx.strokeStyle = isT ? p.gateTarget : k < passed ? p.gatePassed : p.gate;
        mctx.lineWidth = isT ? 2.4 : 1.2;
        mctx.beginPath();
        mctx.moveTo(a.x, a.y);
        mctx.lineTo(b2.x, b2.y);
        mctx.stroke();
      }
      if (view && view.ghost && view.ghost.pos) {
        var gp = m(view.ghost.pos.x, view.ghost.pos.y);
        mctx.fillStyle = p.ghost;
        mctx.beginPath();
        mctx.arc(gp.x, gp.y, 3, 0, Math.PI * 2);
        mctx.fill();
      }
      if (view && view.car) {
        var cp = m(view.car.x, view.car.y);
        mctx.fillStyle = p.car;
        mctx.beginPath();
        mctx.arc(cp.x, cp.y, 3.4, 0, Math.PI * 2);
        mctx.fill();
        mctx.strokeStyle = 'rgba(0,0,0,0.6)';
        mctx.lineWidth = 1;
        mctx.stroke();
      }
    }

    function pushTrail(view, dtMs) {
      if (!view || !view.car) return;
      // 每个新 tick 记录一个点，避免渲染帧率影响轨迹密度
      if (view.tick !== lastTick) {
        lastTick = view.tick;
        egoTrail.push({ x: view.car.x, y: view.car.y });
        if (egoTrail.length > 900) egoTrail.shift();
      }
      if (view.ghost && view.ghost.pos) {
        var g = view.ghost.pos;
        var lastG = ghostTrail[ghostTrail.length - 1];
        if (!lastG || Math.hypot(g.x - lastG.x, g.y - lastG.y) > 0.6) {
          ghostTrail.push({ x: g.x, y: g.y });
          if (ghostTrail.length > 2000) ghostTrail.shift();
        }
      }
    }

    return {
      resize: resize,
      setTrack: setTrack,
      setTheme: setTheme,
      setCameraMode: setCameraMode,
      getCameraMode: getCameraMode,
      zoomBy: zoomBy,
      fitToTrack: fitToTrack,
      addEffect: addEffect,
      pushTrail: pushTrail,
      draw: draw,
      clearTrails: function () {
        egoTrail = [];
        ghostTrail = [];
        effects = [];
        lastTick = null;
        lastCar = null;
      },
      get roadHalf() {
        return roadHalf;
      },
    };
  }

  root.RallyRender = { createRenderer: createRenderer };
})(typeof globalThis !== 'undefined' ? globalThis : this);
