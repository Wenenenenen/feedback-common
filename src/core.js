/*
 * Shared-label outline core.
 * Plain UMD-style module: works in a browser <script> and in Node tests.
 *
 * Coordinate convention:
 *   grid cell (row=r, col=c) occupies the square whose corners are
 *   (c,r), (c+1,r), (c+1,r+1), (c,r+1). Thus coordinates are [x=col, y=row].
 *   SVG/Canvas use y-down. "left side" means visual left on screen.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LabelOutlineCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SIDE = 512;
  const MAX_UNIT_EDGES = 60000;

  class LabelOutlineError extends Error {
    constructor(message, code, details) {
      super(message);
      this.name = 'LabelOutlineError';
      this.code = code || 'INVALID_INPUT';
      this.details = details;
    }
  }

  function vertexId(x, y, width) {
    return y * (width + 1) + x;
  }

  function vertexXY(id, width) {
    const stride = width + 1;
    return [id % stride, Math.floor(id / stride)];
  }

  function crossPoints(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  function absTriangleDoubleArea(a, b, c) {
    return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  }

  /* ----------------------------- Input / model ---------------------------- */

  function parseLabelData(raw) {
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (err) {
        throw new LabelOutlineError('文件不是合法 JSON：' + err.message, 'BAD_JSON');
      }
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.labels)) {
      throw new LabelOutlineError('JSON 必须包含二维 labels 数组。', 'MISSING_LABELS');
    }

    const rows = raw.labels;
    const height = rows.length;
    if (height === 0) throw new LabelOutlineError('labels 不能为空。', 'EMPTY_GRID');
    if (height > MAX_SIDE) {
      throw new LabelOutlineError(`行数 ${height} 超过每边 ${MAX_SIDE} 格上限。`, 'SIDE_LIMIT', { height });
    }

    let width = 0;
    const cells = [];
    for (let r = 0; r < height; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) {
        throw new LabelOutlineError(`第 ${r} 行必须是数组。`, 'BAD_ROW', { row: r });
      }
      if (r === 0) {
        width = row.length;
        if (width === 0) throw new LabelOutlineError('labels 不能为空。', 'EMPTY_GRID');
        if (width > MAX_SIDE) {
          throw new LabelOutlineError(`列数 ${width} 超过每边 ${MAX_SIDE} 格上限。`, 'SIDE_LIMIT', { width });
        }
      } else if (row.length !== width) {
        throw new LabelOutlineError(`第 ${r} 行长度为 ${row.length}，与首行 ${width} 不一致。`, 'BAD_SHAPE');
      }

      for (let c = 0; c < width; c++) {
        const value = row[c];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          throw new LabelOutlineError(
            `标签必须是非负整数；位置 [${r}][${c}] 的值无效。`,
            'BAD_LABEL',
            { row: r, col: c, value }
          );
        }
        cells.push(value);
      }
    }

    return {
      width,
      height,
      cells: new Int32Array(cells),
      palette: raw.palette && typeof raw.palette === 'object' ? raw.palette : {},
      name: raw.name || '',
    };
  }

  class LabelGridModel {
    constructor(raw) {
      const parsed = parseLabelData(raw);
      this.width = parsed.width;
      this.height = parsed.height;
      this.cells = parsed.cells;
      this.palette = parsed.palette;
      this.name = parsed.name;
      this.undoStack = [];
      this.redoStack = [];
      this.batch = null;
      this.historyLimit = 200;
    }

    index(r, c) {
      return r * this.width + c;
    }

    inBounds(r, c) {
      return Number.isInteger(r) && Number.isInteger(c) &&
        r >= 0 && c >= 0 && r < this.height && c < this.width;
    }

    get(r, c) {
      if (!this.inBounds(r, c)) return 0; // 图外也是 0
      return this.cells[this.index(r, c)];
    }

    _pushCommand(command) {
      this.undoStack.push(command);
      if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
      this.redoStack.length = 0;
    }

    editCell(r, c, label) {
      if (!this.inBounds(r, c)) {
        throw new LabelOutlineError(`单元格 (${r},${c}) 超出栅格。`, 'OUT_OF_BOUNDS');
      }
      if (!Number.isInteger(label) || label < 0) {
        throw new LabelOutlineError('新标签必须是非负整数。', 'BAD_LABEL');
      }
      const i = this.index(r, c);
      const before = this.cells[i];
      if (before === label) return null;
      this.cells[i] = label;
      const command = { changes: [{ i, r, c, before, after: label }] };
      this._pushCommand(command);
      return command;
    }

    beginBatch() {
      this.batch = new Map();
    }

    paintInBatch(r, c, label) {
      if (!this.inBounds(r, c) || !Number.isInteger(label) || label < 0) return false;
      const i = this.index(r, c);
      const current = this.cells[i];
      if (current === label) return false;
      const existing = this.batch.get(i);
      if (existing) {
        this.cells[i] = label;
        existing.after = label;
        return true;
      }
      this.batch.set(i, { i, r, c, before: current, after: label });
      this.cells[i] = label;
      return true;
    }

    commitBatch() {
      if (!this.batch || this.batch.size === 0) {
        this.batch = null;
        return null;
      }
      const changes = Array.from(this.batch.values()).filter(ch => ch.before !== ch.after);
      this.batch = null;
      if (changes.length === 0) return null;
      const command = { changes };
      this._pushCommand(command);
      return command;
    }

    cancelBatch() {
      if (!this.batch) return;
      for (const ch of this.batch.values()) this.cells[ch.i] = ch.before;
      this.batch = null;
    }

    undo() {
      const command = this.undoStack.pop();
      if (!command) return false;
      for (const ch of command.changes) this.cells[ch.i] = ch.before;
      this.redoStack.push(command);
      return true;
    }

    redo() {
      const command = this.redoStack.pop();
      if (!command) return false;
      for (const ch of command.changes) this.cells[ch.i] = ch.after;
      this.undoStack.push(command);
      return true;
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
  }

  /* ------------------------------ Unit edges ------------------------------ */

  function countBoundaryEdges(cells, width, height) {
    let count = 0;
    const get = (r, c) => {
      if (r < 0 || c < 0 || r >= height || c >= width) return 0;
      return cells[r * width + c];
    };

    // Vertical grid segments: x = c, from row r to r+1.
    for (let r = 0; r < height; r++) {
      for (let c = 0; c <= width; c++) {
        if (get(r, c - 1) !== get(r, c)) count++;
      }
    }
    // Horizontal grid segments: y = r, from col c to c+1.
    for (let r = 0; r <= height; r++) {
      for (let c = 0; c < width; c++) {
        if (get(r - 1, c) !== get(r, c)) count++;
      }
    }
    return count;
  }

  function buildUnitEdges(cells, width, height) {
    const edges = [];
    const get = (r, c) => {
      if (r < 0 || c < 0 || r >= height || c >= width) return 0;
      return cells[r * width + c];
    };

    const push = (x1, y1, x2, y2, left, right) => {
      edges.push({
        id: edges.length,
        a: vertexId(x1, y1, width),
        b: vertexId(x2, y2, width),
        x1, y1, x2, y2,
        left, right,
        unit: true,
      });
    };

    for (let r = 0; r < height; r++) {
      for (let c = 0; c <= width; c++) {
        const west = get(r, c - 1);
        const east = get(r, c);
        if (west === east) continue;
        if (east < west) {
          // Base direction is down; screen-left of down is east.
          push(c, r, c, r + 1, east, west);
        } else {
          // Lower label is west; walk up so west is screen-left.
          push(c, r + 1, c, r, west, east);
        }
      }
    }

    for (let r = 0; r <= height; r++) {
      for (let c = 0; c < width; c++) {
        const north = get(r - 1, c);
        const south = get(r, c);
        if (north === south) continue;
        if (north < south) {
          // Base direction is right; screen-left of right is north.
          push(c, r, c + 1, r, north, south);
        } else {
          // Lower label is south; walk left so south is screen-left.
          push(c + 1, r, c, r, south, north);
        }
      }
    }

    return edges;
  }

  /* ----------------------- Exact geometry intrusion ----------------------- */

  function fracCmp(n1, d1, n2, d2) {
    // Coordinates are small, but clipped coefficients can grow enough that
    // cross-multiplying two fractions exceeds Number.MAX_SAFE_INTEGER.
    const lhs = BigInt(n1) * BigInt(d2);
    const rhs = BigInt(n2) * BigInt(d1);
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  function fracPointEquals(p, q, n, d, pt) {
    const dx = BigInt(q.x - p.x);
    const dy = BigInt(q.y - p.y);
    const denom = BigInt(d);
    const num = BigInt(n);
    const xNum = BigInt(p.x) * denom + num * dx;
    const yNum = BigInt(p.y) * denom + num * dy;
    return xNum === BigInt(pt.x) * denom && yNum === BigInt(pt.y) * denom;
  }

  function clipLowerBound(lo, n, d) {
    return fracCmp(n, d, lo.n, lo.d) > 0 ? { n, d } : lo;
  }

  function clipUpperBound(hi, n, d) {
    return fracCmp(n, d, hi.n, hi.d) < 0 ? { n, d } : hi;
  }

  // Returns true if segment PQ intersects closed segment AB at any point
  // other than A or B.
  function segmentIntrudesSegment(P, Q, A, B) {
    const rx = B.x - A.x;
    const ry = B.y - A.y;
    const len2 = rx * rx + ry * ry;
    if (len2 === 0) return false;

    const dx = Q.x - P.x;
    const dy = Q.y - P.y;
    const c0 = rx * (P.y - A.y) - ry * (P.x - A.x);
    const cD = rx * dy - ry * dx;

    if (cD !== 0) {
      let n = -c0;
      let d = cD;
      if (d < 0) { n = -n; d = -d; }
      if (n < 0 || n > d) return false;

      const u0 = (P.x - A.x) * rx + (P.y - A.y) * ry;
      const uD = dx * rx + dy * ry;
      const uNum = u0 * d + n * uD;
      if (uNum < 0 || uNum > len2 * d) return false;

      if (fracPointEquals(P, Q, n, d, A) || fracPointEquals(P, Q, n, d, B)) {
        return false;
      }
      return true;
    }

    if (c0 !== 0) return false;

    // Collinear overlap. Clip PQ's parameter interval by 0 <= dot(X-A,R) <= len2.
    let lo = { n: 0, d: 1 };
    let hi = { n: 1, d: 1 };
    const u0 = (P.x - A.x) * rx + (P.y - A.y) * ry;
    const uD = dx * rx + dy * ry;

    // u0 + t*uD >= 0
    let a = uD;
    let b = u0;
    if (a === 0) {
      if (b < 0) return false;
    } else if (a > 0) {
      lo = clipLowerBound(lo, -b, a);
    } else {
      hi = clipUpperBound(hi, b, -a);
    }

    // len2 - u0 - t*uD >= 0
    a = -uD;
    b = len2 - u0;
    if (a === 0) {
      if (b < 0) return false;
    } else if (a > 0) {
      lo = clipLowerBound(lo, -b, a);
    } else {
      hi = clipUpperBound(hi, b, -a);
    }

    if (fracCmp(lo.n, lo.d, hi.n, hi.d) > 0) return false;
    if (fracCmp(lo.n, lo.d, hi.n, hi.d) < 0) return true;

    if (fracPointEquals(P, Q, lo.n, lo.d, A) || fracPointEquals(P, Q, lo.n, lo.d, B)) {
      return false;
    }
    return true;
  }

  // True if segment PQ has any point in closed triangle AVB except possibly
  // the chord endpoints A and B. AV and VB are the two old edges; callers skip
  // their IDs, but this predicate itself is general.
  function segmentIntrudesTriangle(P, Q, A, V, B) {
    const w = crossPoints(A, V, B);

    if (w === 0) {
      // Valid removable collinear vertex has V between A and B, making the
      // degenerate closed triangle exactly segment AB.
      return segmentIntrudesSegment(P, Q, A, B);
    }

    let lo = { n: 0, d: 1 };
    let hi = { n: 1, d: 1 };
    const sides = [[A, V], [V, B], [B, A]];
    const dx = Q.x - P.x;
    const dy = Q.y - P.y;

    for (const [S, E] of sides) {
      const sx = E.x - S.x;
      const sy = E.y - S.y;
      const c0 = sx * (P.y - S.y) - sy * (P.x - S.x);
      const cD = sx * dy - sy * dx;
      const aa = w * cD;
      const bb = w * c0;

      if (aa === 0) {
        if (bb < 0) return false;
        continue;
      }
      if (aa > 0) {
        lo = clipLowerBound(lo, -bb, aa);
      } else {
        hi = clipUpperBound(hi, bb, -aa);
      }
      if (fracCmp(lo.n, lo.d, hi.n, hi.d) > 0) return false;
    }

    if (fracCmp(lo.n, lo.d, hi.n, hi.d) < 0) return true; // positive-length overlap

    // Tangent/singleton contact is allowed only when it is A or B.
    if (fracPointEquals(P, Q, lo.n, lo.d, A) || fracPointEquals(P, Q, lo.n, lo.d, B)) {
      return false;
    }
    return true;
  }

  function pointBetweenCollinear(V, A, B) {
    const area = absTriangleDoubleArea(A, V, B);
    if (area !== 0) return false;
    return V.x >= Math.min(A.x, B.x) && V.x <= Math.max(A.x, B.x) &&
           V.y >= Math.min(A.y, B.y) && V.y <= Math.max(A.y, B.y);
  }

  /* ----------------------------- Simplification --------------------------- */

  function simplifyBoundaries(unitEdges, width, height, maxDoubleArea = 0, options = {}) {
    if (!Number.isFinite(maxDoubleArea) || maxDoubleArea < 0) maxDoubleArea = 0;
    const tileSize = options.tileSize || 16;
    const stride = width + 1;
    const vertexCount = stride * (height + 1);
    const vx = new Int16Array(vertexCount);
    const vy = new Int16Array(vertexCount);
    for (let y = 0; y <= height; y++) {
      for (let x = 0; x <= width; x++) {
        const id = y * stride + x;
        vx[id] = x;
        vy[id] = y;
      }
    }

    const edges = [];
    const incident = new Map();
    const spatial = new Map();
    const testedStamp = [];
    let stamp = 0;

    function vertexPoint(v) {
      return { x: vx[v], y: vy[v] };
    }

    function addIncident(v, id) {
      let arr = incident.get(v);
      if (!arr) {
        arr = [];
        incident.set(v, arr);
      }
      arr.push(id);
    }

    function removeIncident(v, id) {
      const arr = incident.get(v);
      if (!arr) return;
      const i = arr.indexOf(id);
      if (i >= 0) {
        arr[i] = arr[arr.length - 1];
        arr.pop();
      }
    }

    function tileKey(tx, ty) {
      return ty * 2048 + tx;
    }

    function eachTileInBox(minX, minY, maxX, maxY, callback) {
      const tx0 = Math.floor(minX / tileSize);
      const ty0 = Math.floor(minY / tileSize);
      const tx1 = Math.floor(maxX / tileSize);
      const ty1 = Math.floor(maxY / tileSize);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) callback(tileKey(tx, ty));
      }
    }

    function spatialAdd(edge) {
      eachTileInBox(
        Math.min(edge.x1, edge.x2), Math.min(edge.y1, edge.y2),
        Math.max(edge.x1, edge.x2), Math.max(edge.y1, edge.y2),
        key => {
          let set = spatial.get(key);
          if (!set) {
            set = new Set();
            spatial.set(key, set);
          }
          set.add(edge.id);
        }
      );
    }

    function spatialRemove(edge) {
      eachTileInBox(
        Math.min(edge.x1, edge.x2), Math.min(edge.y1, edge.y2),
        Math.max(edge.x1, edge.x2), Math.max(edge.y1, edge.y2),
        key => {
          const set = spatial.get(key);
          if (set) set.delete(edge.id);
        }
      );
    }

    function makeEdge(a, b, left, right) {
      const id = edges.length;
      const edge = {
        id,
        a, b,
        x1: vx[a], y1: vy[a],
        x2: vx[b], y2: vy[b],
        left, right,
        alive: true,
        unit: false,
      };
      edges.push(edge);
      testedStamp[id] = 0;
      return edge;
    }

    for (const u of unitEdges) {
      const id = edges.length;
      const edge = {
        id,
        a: u.a != null ? u.a : vertexId(u.x1, u.y1, width),
        b: u.b != null ? u.b : vertexId(u.x2, u.y2, width),
        x1: u.x1, y1: u.y1, x2: u.x2, y2: u.y2,
        left: u.left, right: u.right,
        alive: true,
        unit: true,
      };
      edges.push(edge);
      testedStamp[id] = 0;
      addIncident(edge.a, id);
      addIncident(edge.b, id);
      spatialAdd(edge);
    }

    function topologyBlocked(eIn, eOut, A, V, B) {
      const pa = vertexPoint(A);
      const pv = vertexPoint(V);
      const pb = vertexPoint(B);
      const minX = Math.min(pa.x, pv.x, pb.x);
      const minY = Math.min(pa.y, pv.y, pb.y);
      const maxX = Math.max(pa.x, pv.x, pb.x);
      const maxY = Math.max(pa.y, pv.y, pb.y);
      stamp++;
      let blocked = false;

      eachTileInBox(minX, minY, maxX, maxY, key => {
        if (blocked) return;
        const set = spatial.get(key);
        if (!set) return;
        for (const id of set) {
          if (id === eIn.id || id === eOut.id) continue;
          const other = edges[id];
          if (!other || !other.alive || testedStamp[id] === stamp) continue;
          testedStamp[id] = stamp;
          const P = { x: other.x1, y: other.y1 };
          const Q = { x: other.x2, y: other.y2 };
          if (segmentIntrudesTriangle(P, Q, pa, pv, pb)) {
            blocked = true;
            break;
          }
        }
      });

      return blocked;
    }

    let removedCount = 0;
    let blockedTopologyCount = 0;
    let rejectedAreaCount = 0;

    function tryRemoveVertex(v) {
      const arr = incident.get(v);
      if (!arr || arr.length !== 2) return false;
      const e0 = edges[arr[0]];
      const e1 = edges[arr[1]];
      if (!e0.alive || !e1.alive) return false;

      // Canonical edges have the smaller label on the visual left. A continuous
      // degree-2 pair therefore has one edge ending at V and one starting at V.
      let eIn = null;
      let eOut = null;
      if (e0.b === v && e1.a === v) {
        eIn = e0; eOut = e1;
      } else if (e1.b === v && e0.a === v) {
        eIn = e1; eOut = e0;
      } else {
        return false;
      }

      // Both side labels must continue through the replacement.
      if (eIn.left !== eOut.left || eIn.right !== eOut.right) return false;

      const A = eIn.a;
      const B = eOut.b;
      if (A === B || A === v || B === v) return false; // chord cannot collapse

      const pa = vertexPoint(A);
      const pv = vertexPoint(v);
      const pb = vertexPoint(B);
      const area2 = absTriangleDoubleArea(pa, pv, pb);
      if (area2 > maxDoubleArea) {
        rejectedAreaCount++;
        return false;
      }

      if (area2 === 0) {
        if (!pointBetweenCollinear(pv, pa, pb)) {
          blockedTopologyCount++;
          return false;
        }
        // The chord is exactly the union of the two old edges. The maintained
        // planar-edge invariant already rules out another edge touching their
        // interiors, and degree === 2 rules out a contact at V.
      } else if (topologyBlocked(eIn, eOut, A, v, B)) {
        blockedTopologyCount++;
        return false;
      }

      spatialRemove(eIn);
      spatialRemove(eOut);
      removeIncident(eIn.a, eIn.id);
      removeIncident(eIn.b, eIn.id);
      removeIncident(eOut.a, eOut.id);
      removeIncident(eOut.b, eOut.id);
      eIn.alive = false;
      eOut.alive = false;

      const replacement = makeEdge(A, B, eIn.left, eIn.right);
      addIncident(A, replacement.id);
      addIncident(B, replacement.id);
      spatialAdd(replacement);
      removedCount++;
      return true;
    }

    const passes = options.passes || ['row', 'column'];
    for (const pass of passes) {
      if (pass === 'row') {
        for (let y = 0; y <= height; y++) {
          for (let x = 0; x <= width; x++) {
            tryRemoveVertex(vertexId(x, y, width));
          }
        }
      } else if (pass === 'column') {
        for (let x = 0; x <= width; x++) {
          for (let y = 0; y <= height; y++) {
            tryRemoveVertex(vertexId(x, y, width));
          }
        }
      }
    }

    const aliveEdges = edges
      .filter(e => e.alive)
      .map(e => ({
        id: e.id,
        a: e.a,
        b: e.b,
        x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2,
        left: e.left, right: e.right,
        unit: e.unit,
      }));

    return {
      edges: aliveEdges,
      removedCount,
      rejectedAreaCount,
      blockedTopologyCount,
      maxDoubleArea,
      passes: passes.slice(),
    };
  }

  /* ---------------------------- Chain tracing ----------------------------- */

  function buildChains(edges, width, height) {
    const stride = width + 1;
    const incident = new Map();
    for (const e of edges) {
      if (!incident.has(e.a)) incident.set(e.a, []);
      if (!incident.has(e.b)) incident.set(e.b, []);
      incident.get(e.a).push(e.id);
      incident.get(e.b).push(e.id);
    }
    const byId = new Map(edges.map(e => [e.id, e]));
    const degree = v => (incident.get(v) ? incident.get(v).length : 0);
    const visited = new Set();
    const chains = [];

    function point(v) {
      return vertexXY(v, width);
    }

    function follow(startEdge) {
      const ids = [];
      const pts = [];
      let e = startEdge;
      let first = true;
      let closed = false;

      while (e) {
        if (visited.has(e.id)) {
          if (e.id === startEdge.id && ids.length > 0) closed = true;
          break;
        }
        visited.add(e.id);
        ids.push(e.id);
        if (first) {
          pts.push([e.x1, e.y1]);
          first = false;
        }
        pts.push([e.x2, e.y2]);

        const endV = e.b;
        if (degree(endV) !== 2) break;

        const arr = incident.get(endV);
        let nextId = null;
        for (const id of arr) {
          if (id === e.id) continue;
          const candidate = byId.get(id);
          // Canonical continuation must leave the current endpoint.
          if (candidate.a === endV) {
            nextId = id;
            break;
          }
        }
        if (nextId == null) break;
        e = byId.get(nextId);
        if (e.id === startEdge.id) {
          closed = true;
          break;
        }
      }

      if (closed && pts.length > 1) pts.pop(); // SVG/path consumers close explicitly
      return {
        id: `chain-${chains.length + 1}`,
        left: startEdge.left,
        right: startEdge.right,
        closed,
        points: pts,
        edgeIds: ids.slice(),
      };
    }

    // Open chains: begin at a canonical edge whose start is a junction/end.
    for (const e of edges) {
      if (visited.has(e.id)) continue;
      if (degree(e.a) !== 2) {
        chains.push(follow(e));
      }
    }

    // Closed degree-2 loops.
    for (const e of edges) {
      if (visited.has(e.id)) continue;
      chains.push(follow(e));
    }

    return chains;
  }

  /* --------------------------- Half-edge cycles --------------------------- */

  function buildBoundaryCycles(edges) {
    const halves = [];
    const byHalfId = new Map();
    const outgoing = new Map();
    const position = new Map();

    function addHalf(edge, index, forward) {
      const id = `${edge.id}:${forward ? 'f' : 'r'}`;
      const half = forward ? {
        id,
        edgeId: edge.id,
        twinId: `${edge.id}:r`,
        from: edge.a,
        to: edge.b,
        x1: edge.x1, y1: edge.y1, x2: edge.x2, y2: edge.y2,
        left: edge.left, right: edge.right,
        index,
      } : {
        id,
        edgeId: edge.id,
        twinId: `${edge.id}:f`,
        from: edge.b,
        to: edge.a,
        x1: edge.x2, y1: edge.y2, x2: edge.x1, y2: edge.y1,
        left: edge.right, right: edge.left,
        index,
      };
      halves.push(half);
      byHalfId.set(id, half);
      if (!outgoing.has(half.from)) outgoing.set(half.from, []);
      outgoing.get(half.from).push(half);
      return half;
    }

    edges.forEach((e, i) => {
      addHalf(e, i, true);
      addHalf(e, i, false);
    });

    function angleCompare(a, b) {
      // Convert screen y-down delta into Cartesian y-up delta.
      const ax = a.x2 - a.x1;
      const ay = -(a.y2 - a.y1);
      const bx = b.x2 - b.x1;
      const by = -(b.y2 - b.y1);
      const ha = (ay > 0 || (ay === 0 && ax >= 0)) ? 0 : 1;
      const hb = (by > 0 || (by === 0 && bx >= 0)) ? 0 : 1;
      if (ha !== hb) return ha - hb;
      const cr = ax * by - ay * bx;
      if (cr !== 0) return cr > 0 ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }

    for (const [v, list] of outgoing) {
      list.sort(angleCompare);
      list.forEach((h, i) => position.set(h.id, i));
    }

    for (const h of halves) {
      const twin = byHalfId.get(h.twinId);
      const list = outgoing.get(h.to);
      const idx = position.get(twin.id);
      // First outgoing direction encountered clockwise from the twin.
      h.nextId = list[(idx - 1 + list.length) % list.length].id;
    }

    const visited = new Set();
    const cycles = [];
    for (const start of halves) {
      if (visited.has(start.id)) continue;
      const points = [];
      const halfIds = [];
      let cur = start;
      let left = cur.left;
      let labelsConsistent = true;

      while (cur && !visited.has(cur.id)) {
        visited.add(cur.id);
        halfIds.push(cur.id);
        points.push([cur.x1, cur.y1]);
        if (cur.left !== left) labelsConsistent = false;
        cur = byHalfId.get(cur.nextId);
      }

      cycles.push({
        left,
        right: start.right,
        labelsConsistent,
        closed: true,
        points,
        halfIds,
      });
    }

    return cycles;
  }

  function cyclesToPathData(cycles, label) {
    const parts = [];
    for (const cycle of cycles) {
      if (cycle.left !== label || cycle.points.length < 3) continue;
      let d = '';
      cycle.points.forEach(([x, y], i) => {
        d += `${i === 0 ? 'M' : 'L'}${x} ${y}`;
      });
      d += 'Z';
      parts.push(d);
    }
    return parts.join(' ');
  }

  /* -------------------------------- Colors -------------------------------- */

  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function defaultColor(label) {
    if (label === 0) return 'transparent';
    const hue = (label * 137.508 + 12) % 360;
    return hslToHex(hue, 58, 56);
  }

  function resolveColor(palette, label) {
    if (label === 0) return 'transparent';
    if (palette && Object.prototype.hasOwnProperty.call(palette, label)) return palette[label];
    if (palette && Object.prototype.hasOwnProperty.call(palette, String(label))) return palette[String(label)];
    return defaultColor(label);
  }

  function parseColorToRgb(value) {
    if (!value || typeof value !== 'string') return null;
    let s = value.trim();
    if (s.startsWith('#')) {
      let hex = s.slice(1);
      if (hex.length === 3 || hex.length === 4) {
        hex = hex.split('').map(ch => ch + ch).join('');
      }
      if (hex.length === 8) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const a = parseInt(hex.slice(6, 8), 16) / 255;
        if ([r, g, b].some(Number.isNaN)) return null;
        return a === 0 ? null : { r, g, b, a: Number.isNaN(a) ? 1 : a };
      }
      if (hex.length !== 6) return null;
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].some(Number.isNaN)) return null;
      return { r, g, b, a: 1 };
    }
    const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i);
    if (m) {
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
    }
    return null;
  }

  /* ------------------------------- Process -------------------------------- */

  function uniqueLabels(cells) {
    const set = new Set();
    for (const v of cells) if (v !== 0) set.add(v);
    return Array.from(set).sort((a, b) => a - b);
  }

  function processGrid(source, options = {}) {
    let model;
    if (source instanceof LabelGridModel) {
      model = source;
    } else if (source && source.cells && source.width && source.height) {
      model = source;
    } else {
      model = new LabelGridModel(source);
    }

    const width = model.width;
    const height = model.height;
    const cells = model.cells;
    const maxDoubleArea = options.maxDoubleArea == null ? 0 : options.maxDoubleArea;

    const boundaryCount = countBoundaryEdges(cells, width, height);
    if (boundaryCount > MAX_UNIT_EDGES && !options.ignoreEdgeLimit) {
      throw new LabelOutlineError(
        `分界单位边有 ${boundaryCount.toLocaleString('zh-CN')} 条，超过 ${MAX_UNIT_EDGES.toLocaleString('zh-CN')} 条上限。`,
        'EDGE_LIMIT',
        { boundaryCount, limit: MAX_UNIT_EDGES }
      );
    }

    const unitEdges = buildUnitEdges(cells, width, height);
    const simplification = simplifyBoundaries(unitEdges, width, height, maxDoubleArea, options);
    const cycles = buildBoundaryCycles(simplification.edges);
    const chains = buildChains(simplification.edges, width, height);
    const labels = uniqueLabels(cells);

    return {
      width,
      height,
      cells,
      palette: model.palette || {},
      labels,
      boundaryCount,
      unitEdges,
      edges: simplification.edges,
      chains,
      cycles,
      removedCount: simplification.removedCount,
      blockedTopologyCount: simplification.blockedTopologyCount,
      rejectedAreaCount: simplification.rejectedAreaCount,
      maxDoubleArea,
    };
  }

  /* ------------------------------- Exporters ------------------------------- */

  function buildSharedEdgesJSON(result) {
    return {
      format: 'shared-label-outline/shared-edges',
      version: 1,
      grid: {
        width: result.width,
        height: result.height,
        transparentLabel: 0,
        outsideLabel: 0,
      },
      maxDoubleArea: result.maxDoubleArea,
      counts: {
        unitEdges: result.unitEdges.length,
        edges: result.edges.length,
        chains: result.chains.length,
        labels: result.labels.length,
      },
      palette: result.palette,
      labels: result.labels,
      unitEdgeCount: result.unitEdges.length,
      edges: result.edges.map(e => ({
        id: `e${e.id}`,
        start: [e.x1, e.y1],
        end: [e.x2, e.y2],
        left: e.left,
        right: e.right,
      })),
      chains: result.chains.map(ch => ({
        id: ch.id,
        left: ch.left,
        right: ch.right,
        closed: ch.closed,
        start: ch.points[0] || null,
        end: ch.closed ? (ch.points[0] || null) : (ch.points[ch.points.length - 1] || null),
        points: ch.points,
      })),
    };
  }

  function buildLabelSVG(result, options = {}) {
    const scale = options.scale == null ? 16 : options.scale;
    const width = result.width;
    const height = result.height;
    const paths = [];

    for (const label of result.labels) {
      const d = cyclesToPathData(result.cycles, label);
      if (!d) continue;
      const fill = resolveColor(result.palette, label);
      paths.push(
        `    <path data-label="${label}" fill="${fill}" fill-rule="evenodd" d="${d}"/>`
      );
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `width="${width * scale}" height="${height * scale}" ` +
      `viewBox="0 0 ${width} ${height}" ` +
      `shape-rendering="geometricPrecision" stroke="none">\n` +
      `  <g stroke="none" stroke-width="0" fill-rule="evenodd">\n` +
      paths.join('\n') + `\n  </g>\n` +
      `</svg>\n`;
  }

  /* ------------------------------ Verification ----------------------------- */

  // Expand axis-aligned merged segments back to undirected unit grid locations.
  // Used to prove areaLimit=0 does not move any boundary.
  function expandAxisAlignedEdgesToUnitKeys(edges) {
    const keys = new Set();
    for (const e of edges) {
      if (e.y1 === e.y2) {
        const y = e.y1;
        const x0 = Math.min(e.x1, e.x2);
        const x1 = Math.max(e.x1, e.x2);
        for (let x = x0; x < x1; x++) keys.add(`H:${x},${y}`);
      } else if (e.x1 === e.x2) {
        const x = e.x1;
        const y0 = Math.min(e.y1, e.y2);
        const y1 = Math.max(e.y1, e.y2);
        for (let y = y0; y < y1; y++) keys.add(`V:${x},${y}`);
      } else {
        throw new LabelOutlineError('面积上限为 0 时不应出现斜弦。', 'UNEXPECTED_DIAGONAL');
      }
    }
    return keys;
  }

  function unitEdgeKeys(unitEdges) {
    const keys = new Set();
    for (const e of unitEdges) {
      if (e.y1 === e.y2) keys.add(`H:${Math.min(e.x1, e.x2)},${e.y1}`);
      else keys.add(`V:${e.x1},${Math.min(e.y1, e.y2)}`);
    }
    return keys;
  }

  function areaZeroBoundariesMatch(result) {
    const a = unitEdgeKeys(result.unitEdges);
    const b = expandAxisAlignedEdgesToUnitKeys(result.edges);
    if (a.size !== b.size) return false;
    for (const key of a) if (!b.has(key)) return false;
    return true;
  }

  function distancePointToSegment(x, y, e) {
    const dx = e.x2 - e.x1;
    const dy = e.y2 - e.y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(x - e.x1, y - e.y1);
    let t = ((x - e.x1) * dx + (y - e.y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = e.x1 + t * dx;
    const py = e.y1 + t * dy;
    return Math.hypot(x - px, y - py);
  }

  function hitTestEdge(edges, x, y, tolerance) {
    let best = null;
    let bestDistance = tolerance;
    for (const e of edges) {
      const d = distancePointToSegment(x, y, e);
      if (d <= bestDistance) {
        bestDistance = d;
        best = e;
      }
    }
    return best ? { edge: best, distance: bestDistance } : null;
  }

  return {
    MAX_SIDE,
    MAX_UNIT_EDGES,
    LabelOutlineError,
    LabelGridModel,
    vertexId,
    vertexXY,
    crossPoints,
    absTriangleDoubleArea,
    parseLabelData,
    countBoundaryEdges,
    buildUnitEdges,
    segmentIntrudesSegment,
    segmentIntrudesTriangle,
    pointBetweenCollinear,
    simplifyBoundaries,
    buildChains,
    buildBoundaryCycles,
    cyclesToPathData,
    processGrid,
    buildSharedEdgesJSON,
    buildLabelSVG,
    areaZeroBoundariesMatch,
    unitEdgeKeys,
    expandAxisAlignedEdgesToUnitKeys,
    hitTestEdge,
    distancePointToSegment,
    defaultColor,
    resolveColor,
    parseColorToRgb,
    hslToHex,
  };
});
