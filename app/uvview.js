/* 2D UV plane view on a plain canvas: square [0,1]^2 with bottom-left origin. */
(function (global) {
  'use strict';

  function UvView(canvas, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks;
    this.scale = 0;          // pixels per UV unit
    this.ox = 0; this.oy = 0; // origin (0,0) in canvas pixels
    this.hover = -1;
    this.selected = -1;
    this.cycleFaces = [];
    this.filterSet = null;
    this.stretchSet = null;
    this.showMask = false;
    this.showOverlapFill = true;
    this._down = null;
    this._moved = false;
    this._bind();
    this._resize();
    this._ro = new ResizeObserver(this._resize.bind(this));
    this._ro.observe(canvas);
  }

  UvView.prototype._bind = function () {
    var cv = this.canvas;
    cv.addEventListener('pointerdown', function (e) {
      this._down = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy };
      this._moved = false;
    }.bind(this));
    cv.addEventListener('pointermove', function (e) {
      if (this._down && (e.buttons & 1)) {
        var dx = e.clientX - this._down.x, dy = e.clientY - this._down.y;
        if (dx * dx + dy * dy > 36) this._moved = true;
        this.ox = this._down.ox + dx;
        this.oy = this._down.oy + dy;
        this.draw();
      } else {
        var uv = this._eventUv(e);
        var id = uv ? this._faceAt(uv) : -1;
        if (id !== this.hover) this.hover = id;
        this.draw();
        this.cb.onHover(id, e.clientX, e.clientY, uv);
      }
    }.bind(this));
    var endDrag = function (e) {
      if (!this._down) return;
      var wasDrag = this._moved;
      this._down = null;
      if (!wasDrag) {
        var uv = this._eventUv(e);
        this.cb.onPick(uv);
      }
    }.bind(this);
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', function () { this._down = null; }.bind(this));
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = cv.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var factor = Math.exp(-e.deltaY * 0.0012);
      var newScale = Math.min(40, Math.max(0.15, this.scale * factor));
      // keep the point under the cursor fixed
      var u = (mx - this.ox) / this.scale, v = (my - this.oy) / this.scale;
      this.scale = newScale;
      this.ox = mx - u * this.scale;
      this.oy = my - v * this.scale;
      this.draw();
    }, { passive: false });
  };

  UvView.prototype._resize = function () {
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    var rect = this.canvas.getBoundingClientRect();
    var size = Math.max(200, Math.min(rect.width, rect.height));
    this.cssSize = size;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this._userFramed) this.resetView();
    this.draw();
  };

  UvView.prototype.resetView = function () {
    var pad = 26;
    this.scale = (this.cssSize - pad * 2);
    this.ox = pad;
    this.oy = this.cssSize - pad; // y flipped: UV v grows upward
    this._userFramed = false;
    if (this.palette) this.draw();
  };

  UvView.prototype.setData = function (data, result, palette) {
    this.data = data;
    this.result = result;
    this.palette = palette;
    this.selected = -1;
    this.hover = -1;
    this._userFramed = false;
    this.resetView();
  };

  UvView.prototype.setFilters = function (filterSet, stretchSet) {
    this.filterSet = filterSet;
    this.stretchSet = stretchSet;
    this.draw();
  };

  UvView.prototype.setOverlay = function (showMask, showOverlapFill) {
    this.showMask = showMask;
    this.showOverlapFill = showOverlapFill;
    this.draw();
  };

  UvView.prototype.setSelection = function (faceId, cycleFaces) {
    this.selected = faceId;
    this.cycleFaces = cycleFaces || [];
    this.draw();
  };

  UvView.prototype._eventUv = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    return [(x - this.ox) / this.scale, (this.oy - y) / this.scale];
  };

  UvView.prototype.toCanvas = function (u, v) {
    return [this.ox + u * this.scale, this.oy - v * this.scale];
  };

  UvView.prototype._faceAt = function (uv) {
    if (!this.result) return -1;
    var hits = UVAudit.facesAtPoint(this.result, uv);
    // Prefer a face passing the active filter when several overlap.
    if (this.filterSet) {
      var filtered = hits.filter(function (id) { return this.filterSet.has(id); }, this);
      if (filtered.length) hits = filtered;
    }
    return hits.length ? hits[0] : -1;
  };

  UvView.prototype._faceFill = function (i) {
    var p = this.palette, r = this.result;
    if (i === this.selected) return p.selUv;
    if (i === this.hover) return p.hover;
    if (!r) return p.goodFill;
    var m = r.metrics[i];
    var dim = this.filterSet && !this.filterSet.has(i);
    if (m.degenerate) return dim ? p.dimFill : p.degenerateFill;
    if (r.facePairs[i].length > 0) return dim ? p.dimFill : p.overlapFill;
    if (m.mirrored) return dim ? p.dimFill : p.mirrorFill;
    if (m.outside) return dim ? p.dimFill : p.outsideFill;
    if (this.stretchSet && this.stretchSet.has(i)) return dim ? p.dimFill : p.stretchFill;
    return dim ? p.dimFill : p.goodFill;
  };

  UvView.prototype.draw = function () {
    var ctx = this.ctx, s = this.cssSize;
    if (!s || !this.palette) return;
    var p = this.palette;
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = p.planeBg;
    ctx.fillRect(0, 0, s, s);

    // 0..1 unit square
    var a = this.toCanvas(0, 0), b = this.toCanvas(1, 1);
    var x0 = a[0], y0 = b[1], w = b[0] - a[0], h = a[1] - b[1];
    ctx.fillStyle = p.unitBg;
    ctx.fillRect(x0, y0, w, h);

    // grid at 0.1 increments
    ctx.strokeStyle = p.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var g = 0; g <= 10; g++) {
      var t = g / 10;
      var p1 = this.toCanvas(t, 0), p2 = this.toCanvas(t, 1);
      ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
      var p3 = this.toCanvas(0, t), p4 = this.toCanvas(1, t);
      ctx.moveTo(p3[0], p3[1]); ctx.lineTo(p4[0], p4[1]);
    }
    ctx.stroke();

    if (!this.data) { this._drawFrame(x0, y0, w, h); return; }

    var r = this.result;
    // mask underlay (256x256 rule pixels)
    if (this.showMask && r) this._drawMask(x0, y0, w, h);

    // faces: degenerate last so valid triangles stay visible
    var n = this.data.uv.length;
    var order = [];
    for (var i = 0; i < n; i++) order.push(i);
    if (r) {
      order.sort(function (x, y) {
        var dx = r.metrics[x].degenerate ? 1 : 0, dy = r.metrics[y].degenerate ? 1 : 0;
        return dx - dy;
      });
    }
    for (var oi = 0; oi < order.length; oi++) {
      var fi = order[oi];
      var tri = this.data.uv[fi];
      ctx.beginPath();
      for (var k = 0; k < 3; k++) {
        var pt = this.toCanvas(tri[k][0], tri[k][1]);
        if (k === 0) ctx.moveTo(pt[0], pt[1]); else ctx.lineTo(pt[0], pt[1]);
      }
      ctx.closePath();
      ctx.fillStyle = this._faceFill(fi);
      ctx.fill();
      ctx.strokeStyle = (fi === this.selected) ? p.selStroke
        : (r && r.metrics[fi].degenerate) ? p.degenerateStroke : p.triStroke;
      ctx.lineWidth = fi === this.selected ? 2 : 0.6;
      ctx.stroke();
    }

    // overlap intersection polygons
    if (this.showOverlapFill && r) {
      ctx.fillStyle = p.ovlPoly;
      ctx.strokeStyle = p.ovlPolyStroke;
      ctx.lineWidth = 1;
      for (var op = 0; op < r.overlaps.length; op++) {
        var poly = r.overlaps[op].poly;
        ctx.beginPath();
        for (k = 0; k < poly.length; k++) {
          pt = this.toCanvas(poly[k][0], poly[k][1]);
          if (k === 0) ctx.moveTo(pt[0], pt[1]); else ctx.lineTo(pt[0], pt[1]);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // selected/cycle markers
    if (this.selected >= 0) this._drawFaceMarker(this.selected, true);
    for (var ci = 0; ci < this.cycleFaces.length; ci++) {
      if (this.cycleFaces[ci] !== this.selected) this._drawFaceMarker(this.cycleFaces[ci], false);
    }

    this._drawFrame(x0, y0, w, h);
  };

  UvView.prototype._drawFaceMarker = function (fi, primary) {
    var ctx = this.ctx, p = this.palette;
    var tri = this.data.uv[fi];
    var cu = 0, cv = 0;
    for (var k = 0; k < 3; k++) { cu += tri[k][0]; cv += tri[k][1]; }
    var c = this.toCanvas(cu / 3, cv / 3);
    ctx.beginPath();
    ctx.arc(c[0], c[1], primary ? 4.5 : 3.2, 0, Math.PI * 2);
    ctx.fillStyle = primary ? p.markerPrimary : p.markerCycle;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = p.markerRing;
    ctx.stroke();
  };

  UvView.prototype._drawMask = function (x0, y0, w, h) {
    var ctx = this.ctx, r = this.result;
    // The mask covers exactly the unit square; w and h are its on-screen size.
    var cellW = w / r.maskSize;
    var cellH = h / r.maskSize;
    ctx.fillStyle = this.palette.maskPixel;
    for (var row = 0; row < r.maskSize; row++) {
      for (var col = 0; col < r.maskSize; col++) {
        if (!r.mask[row * r.maskSize + col]) continue;
        // PNG row 0 is the top row; py = 1 - (r+.5)/256
        var px = x0 + col * cellW;
        var py = y0 + row * cellH;
        ctx.fillRect(px, py, Math.ceil(cellW), Math.ceil(cellH));
      }
    }
  };

  UvView.prototype._drawFrame = function (x0, y0, w, h) {
    var ctx = this.ctx, p = this.palette;
    ctx.strokeStyle = p.frameLine;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(x0, y0, w, h);
    ctx.fillStyle = p.axisLabel;
    ctx.font = '11px ' + p.monoFont;
    ctx.textAlign = 'center';
    ctx.fillText('u →', x0 + w / 2, y0 + h + 16);
    ctx.save();
    ctx.translate(x0 - 16, y0 + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('v →', 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.fillText('0', x0 - 2, y0 + h + 12);
    ctx.textAlign = 'right';
    ctx.fillText('1', x0 + w, y0 + h + 12);
  };

  global.UvView = UvView;
})(typeof window !== 'undefined' ? window : globalThis);
