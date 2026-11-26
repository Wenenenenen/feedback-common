/*
 * vertex-stream-reel 核心引擎
 * 纯逻辑，无 DOM 依赖；浏览器经典脚本与 Node require 均可加载。
 * 全局名：VSR
 */
(function (global) {
  'use strict';

  var LIMIT_INITIAL_BYTES = 16 * 1024 * 1024;   // 初始缓冲合计 16 MiB
  var LIMIT_COMMANDS = 50000;                   // 命令条数
  var LIMIT_REWRITE_BYTES = 64 * 1024 * 1024;   // write/copy 目的字节累计 64 MiB
  var LIMIT_PROBES = 256;
  var INT31_MAX = 2147483647;

  var FIELD_SIZE = {
    u16: 2,
    u32: 4,
    f32x2: 8,
    snorm16x2: 4,
    unorm8x4: 4,
    rgb10a2unorm: 4
  };

  var ATTR_TYPES = {
    position: ['f32x2', 'snorm16x2'],
    color: ['unorm8x4', 'rgb10a2unorm'],
    offset: ['f32x2', 'snorm16x2']
  };

  function CaptureError(message, ref) {
    var err = new Error(message);
    err.name = 'CaptureError';
    err.ref = ref || null; // {kind:'buffer'|'command'|'probe', index}
    return err;
  }

  function isNonnegInt(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= INT31_MAX;
  }

  function isInt31(v) {
    return typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= INT31_MAX;
  }

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  var HEX_RE = /^[0-9a-fA-F]*$/;

  function decodeHex(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      s += h.length === 1 ? '0' + h : h;
    }
    return s;
  }

  function fail(msg, kind, index) {
    throw CaptureError(msg, kind === undefined ? null : { kind: kind, index: index });
  }

  /* ------------------------------------------------------------------ *
   * 抓帧解析与全量校验：任何非法项拒绝整份抓帧并指出编号
   * ------------------------------------------------------------------ */
  function parseCapture(json) {
    if (!isPlainObject(json)) fail('抓帧根节点必须是对象');
    if (!isPlainObject(json.buffers)) fail('缺少 buffers 对象');
    if (!Array.isArray(json.commands)) fail('缺少 commands 数组');

    var bufs = Object.create(null);
    var names = Object.keys(json.buffers);
    var totalInitial = 0;

    for (var bi = 0; bi < names.length; bi++) {
      var name = names[bi];
      if (typeof name !== 'string' || name.length === 0) {
        fail('缓冲编号必须是非空字符串', 'buffer', name);
      }
      var hex = json.buffers[name];
      if (typeof hex !== 'string' || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
        fail('缓冲 "' + name + '" 不是偶数长度的合法十六进制串', 'buffer', name);
      }
      var bytes = decodeHex(hex);
      totalInitial += bytes.length;
      if (totalInitial > LIMIT_INITIAL_BYTES) {
        fail('初始缓冲字节总数超过 16 MiB 上限', 'buffer', name);
      }
      bufs[name] = bytes;
    }

    var cmds = json.commands;
    if (cmds.length > LIMIT_COMMANDS) {
      fail('命令数 ' + cmds.length + ' 超过 50000 条上限', 'command', cmds.length);
    }

    var rewriteTotal = 0;

    function requireBuffer(ref, ci, role) {
      if (typeof ref !== 'string' || !Object.prototype.hasOwnProperty.call(bufs, ref)) {
        fail(role + '引用了未知缓冲 "' + ref + '"', 'command', ci);
      }
    }

    for (var ci = 0; ci < cmds.length; ci++) {
      var c = cmds[ci];
      if (!isPlainObject(c) || typeof c.op !== 'string') {
        fail('命令必须是带 op 字符串的对象', 'command', ci);
      }

      if (c.op === 'write') {
        requireBuffer(c.b, ci, 'write');
        if (!isNonnegInt(c.at)) fail('write 的 at 非法', 'command', ci);
        if (typeof c.hex !== 'string' || c.hex.length % 2 !== 0 || !HEX_RE.test(c.hex)) {
          fail('write 的 hex 不是偶数长度合法十六进制串', 'command', ci);
        }
        var wlen = c.hex.length / 2;
        if (BigInt(c.at) + BigInt(wlen) > BigInt(bufs[c.b].length)) {
          fail('write 目的区间越界', 'command', ci);
        }
        rewriteTotal += wlen;
        if (rewriteTotal > LIMIT_REWRITE_BYTES) {
          fail('write/copy 累计目的字节超过 64 MiB 上限', 'command', ci);
        }
      } else if (c.op === 'copy') {
        requireBuffer(c.src, ci, 'copy 源');
        requireBuffer(c.dst, ci, 'copy 目的');
        if (!isNonnegInt(c.from)) fail('copy 的 from 非法', 'command', ci);
        if (!isNonnegInt(c.at)) fail('copy 的 at 非法', 'command', ci);
        if (!isNonnegInt(c.size)) fail('copy 的 size 非法', 'command', ci);
        if (BigInt(c.from) + BigInt(c.size) > BigInt(bufs[c.src].length)) {
          fail('copy 源区间越界', 'command', ci);
        }
        if (BigInt(c.at) + BigInt(c.size) > BigInt(bufs[c.dst].length)) {
          fail('copy 目的区间越界', 'command', ci);
        }
        rewriteTotal += c.size;
        if (rewriteTotal > LIMIT_REWRITE_BYTES) {
          fail('write/copy 累计目的字节超过 64 MiB 上限', 'command', ci);
        }
      } else if (c.op === 'draw') {
        validateDraw(c, ci, bufs);
      } else {
        fail('未知 op "' + c.op + '"', 'command', ci);
      }
    }

    // 写负载在解析期预解码一次，避免 64MiB 级别重复十六进制解析
    var writeBytes = new Array(cmds.length);
    for (var wi = 0; wi < cmds.length; wi++) {
      if (cmds[wi].op === 'write') writeBytes[wi] = decodeHex(cmds[wi].hex);
    }

    return { buffers: bufs, commands: cmds, _writeBytes: writeBytes };
  }

  function validateDraw(c, ci, bufs) {
    if (!isPlainObject(c.index)) fail('draw 缺少 index', 'command', ci);
    if (typeof c.index.b !== 'string' ||
        !Object.prototype.hasOwnProperty.call(bufs, c.index.b)) {
      fail('draw 索引缓冲未知', 'command', ci);
    }
    if (c.index.type !== 'u16' && c.index.type !== 'u32') {
      fail('draw 索引 type 只能是 u16/u32', 'command', ci);
    }
    if (!isNonnegInt(c.index.at)) fail('draw 索引 at 非法', 'command', ci);

    if (!isNonnegInt(c.firstIndex)) fail('firstIndex 非法', 'command', ci);
    if (!isNonnegInt(c.count) || c.count === 0 || c.count % 3 !== 0 || c.count > 6000) {
      fail('count 必须是不超过 6000 的正的 3 的倍数', 'command', ci);
    }
    if (!isInt31(c.baseVertex)) fail('baseVertex 非法', 'command', ci);
    if (!isNonnegInt(c.firstInstance)) fail('firstInstance 非法', 'command', ci);
    if (!isNonnegInt(c.instances) || c.instances < 1 || c.instances > 128) {
      fail('instances 必须在 1..128 之间', 'command', ci);
    }
    if (c.count * c.instances > 120000) {
      fail('count × instances 超过 120000', 'command', ci);
    }
    if (!isPlainObject(c.attrs)) fail('draw 缺少 attrs', 'command', ci);
    if (!c.attrs.position || !c.attrs.color) {
      fail('attrs 必须含 position 和 color', 'command', ci);
    }
    var keys = Object.keys(c.attrs);
    for (var ai = 0; ai < keys.length; ai++) {
      var key = keys[ai];
      if (!ATTR_TYPES[key]) fail('attrs 含未知属性 "' + key + '"', 'command', ci);
      var a = c.attrs[key];
      if (!isPlainObject(a)) fail('属性 "' + key + '" 必须是对象', 'command', ci);
      if (typeof a.b !== 'string' ||
          !Object.prototype.hasOwnProperty.call(bufs, a.b)) {
        fail('属性 "' + key + '" 引用未知缓冲', 'command', ci);
      }
      if (!isNonnegInt(a.at)) fail('属性 "' + key + '" 的 at 非法', 'command', ci);
      if (!isNonnegInt(a.stride)) fail('属性 "' + key + '" 的 stride 非法', 'command', ci);
      if (!isNonnegInt(a.divisor)) fail('属性 "' + key + '" 的 divisor 非法', 'command', ci);
      if (ATTR_TYPES[key].indexOf(a.type) < 0) {
        fail('属性 "' + key + '" 不接受类型 "' + a.type + '"', 'command', ci);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 解码
   * ------------------------------------------------------------------ */
  function decodeField(type, bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (type === 'u16') return { value: dv.getUint16(0, true), finite: true };
    if (type === 'u32') return { value: dv.getUint32(0, true), finite: true };
    if (type === 'f32x2') {
      var x = dv.getFloat32(0, true);
      var y = dv.getFloat32(4, true);
      return { value: [x, y], finite: Number.isFinite(x) && Number.isFinite(y) };
    }
    if (type === 'snorm16x2') {
      var n0 = dv.getInt16(0, true);
      var n1 = dv.getInt16(2, true);
      return { value: [Math.max(-1, n0 / 32767), Math.max(-1, n1 / 32767)], finite: true };
    }
    if (type === 'unorm8x4') {
      return {
        value: [bytes[0] / 255, bytes[1] / 255, bytes[2] / 255, bytes[3] / 255],
        finite: true
      };
    }
    if (type === 'rgb10a2unorm') {
      var u = dv.getUint32(0, true);
      return {
        value: [
          (u & 0x3ff) / 1023,
          ((u >>> 10) & 0x3ff) / 1023,
          ((u >>> 20) & 0x3ff) / 1023,
          (u >>> 30) / 3
        ],
        finite: true
      };
    }
    throw new Error('unknown type ' + type);
  }

  /* ------------------------------------------------------------------ *
   * 回放器：同一组缓冲反复更新，逐字节记录最后改写命令号
   * ------------------------------------------------------------------ */
  function Replayer(capture) {
    this.cap = capture;
    this.bufs = Object.create(null);
    this.writers = Object.create(null);
    var names = Object.keys(capture.buffers);
    for (var i = 0; i < names.length; i++) {
      var src = capture.buffers[names[i]];
      this.bufs[names[i]] = new Uint8Array(src); // 拷贝
      this.writers[names[i]] = new Int32Array(src.length).fill(-1);
    }
    this.pos = 0; // 已执行命令数
  }

  Replayer.prototype.reset = function () {
    var names = Object.keys(this.cap.buffers);
    for (var i = 0; i < names.length; i++) {
      this.bufs[names[i]].set(this.cap.buffers[names[i]]);
      this.writers[names[i]].fill(-1);
    }
    this.pos = 0;
  };

  Replayer.prototype._step = function (ci) {
    var c = this.cap.commands[ci];
    if (c.op === 'write') {
      var data = this.cap._writeBytes[ci];
      this.bufs[c.b].set(data, c.at);
      this.writers[c.b].fill(ci, c.at, c.at + data.length);
    } else if (c.op === 'copy') {
      var srcBuf = this.bufs[c.src];
      // 重叠拷贝一律先取命令前源字节
      var snap = srcBuf.slice(c.from, c.from + c.size);
      this.bufs[c.dst].set(snap, c.at);
      this.writers[c.dst].fill(ci, c.at, c.at + c.size);
    }
  };

  // 让回放器恰好执行完 target 条命令（draw 不修改缓冲，状态即该 draw 执行时）
  Replayer.prototype.seek = function (target) {
    if (target < this.pos) this.reset();
    while (this.pos < target) {
      this._step(this.pos);
      this.pos++;
    }
  };

  Replayer.prototype._readField = function (bname, addrBig, type) {
    var size = FIELD_SIZE[type];
    var buf = this.bufs[bname];
    var endBig = addrBig + BigInt(size);
    var rec = {
      buffer: bname,
      address: Number(addrBig),
      hex: null,
      value: null,
      writers: null,
      error: ''
    };
    if (addrBig < 0n || endBig > BigInt(buf.length)) {
      rec.error = '字段读取越界（缓冲长度 ' + buf.length + ' 字节）';
      return rec;
    }
    var addr = Number(addrBig);
    var slice = buf.subarray(addr, addr + size);
    rec.hex = toHex(slice);
    rec.writers = Array.from(this.writers[bname].subarray(addr, addr + size));
    var dec = decodeField(type, slice);
    if (!dec.finite) {
      rec.error = '解码出非有限值（NaN/Infinity）';
      // value 保持 null，hex/writers 保留
    } else {
      rec.value = dec.value;
    }
    return rec;
  };

  // 评估一个角；triangles 跳过状态由 evalTriangle 汇总
  Replayer.prototype.evalCorner = function (cmd, ci, j, k) {
    var out = { vertex: null, fields: {}, errors: [] };

    // ---- 索引 ----
    var idxSize = FIELD_SIZE[cmd.index.type];
    var idxAddr = BigInt(cmd.index.at) +
      BigInt(cmd.firstIndex + k) * BigInt(idxSize);
    var idxRec = this._readField(cmd.index.b, idxAddr, cmd.index.type);
    out.fields.index = idxRec;

    var stopAttrs = false;
    if (idxRec.error) {
      out.errors.push('index: ' + idxRec.error);
      stopAttrs = true;
    } else {
      var vertex = idxRec.value + cmd.baseVertex;
      out.vertex = vertex;
      if (vertex < 0) {
        idxRec.error = '索引值 ' + idxRec.value + ' 加基点 ' + cmd.baseVertex +
          ' 后顶点槽号为负';
        out.errors.push('index: ' + idxRec.error);
        stopAttrs = true;
      }
    }

    if (!stopAttrs) {
      var attrNames = Object.keys(cmd.attrs);
      for (var ai = 0; ai < attrNames.length; ai++) {
        var key = attrNames[ai];
        var a = cmd.attrs[key];
        var slot = a.divisor === 0
          ? out.vertex
          : Math.floor((cmd.firstInstance + j) / a.divisor);
        // 零字节步长 => 地址恒为 at，重复同址
        var addr = BigInt(a.at) + BigInt(a.stride) * BigInt(slot);
        var rec = this._readField(a.b, addr, a.type);
        out.fields[key] = rec;
        if (rec.error) out.errors.push(key + ': ' + rec.error);
      }
    }
    return out;
  };

  // 评估整个三角形（连续每三角），返回三个角与 skipped
  Replayer.prototype.evalTriangle = function (cmd, ci, j, tri) {
    var base = tri * 3;
    var corners = [];
    var skipped = false;
    for (var kk = 0; kk < 3; kk++) {
      var r = this.evalCorner(cmd, ci, j, base + kk);
      if (r.errors.length) skipped = true;
      corners.push(r);
    }
    return { corners: corners, skipped: skipped };
  };

  /* ------------------------------------------------------------------ *
   * 探针：单遍单调回放，256 条交替前后半段也只扫一次
   * ------------------------------------------------------------------ */
  function validateProbe(p, cap, pi) {
    if (!isPlainObject(p)) fail('探针必须是对象', 'probe', pi);
    if (!isNonnegInt(p.draw)) fail('探针 draw 非法', 'probe', pi);
    if (!isNonnegInt(p.instance)) fail('探针 instance 非法', 'probe', pi);
    if (!isNonnegInt(p.corner)) fail('探针 corner 非法', 'probe', pi);
    if (p.draw >= cap.commands.length || cap.commands[p.draw].op !== 'draw') {
      fail('draw ' + p.draw + ' 不是有效的绘制命令号', 'probe', pi);
    }
    var d = cap.commands[p.draw];
    if (p.instance >= d.instances) {
      fail('instance ' + p.instance + ' 超出范围（共 ' + d.instances + ' 个实例）', 'probe', pi);
    }
    if (p.corner >= d.count) {
      fail('corner ' + p.corner + ' 超出范围（共 ' + d.count + ' 个角）', 'probe', pi);
    }
  }

  function parseProbes(json, cap) {
    if (!Array.isArray(json)) fail('探针输入必须是 JSON 数组', 'probe', null);
    if (json.length > LIMIT_PROBES) {
      fail('探针数量 ' + json.length + ' 超过 256 条上限', 'probe', json.length);
    }
    for (var i = 0; i < json.length; i++) validateProbe(json[i], cap, i);
    return json.slice();
  }

  Replayer.prototype.runProbes = function (probes) {
    var order = probes.map(function (p, i) { return i; })
      .sort(function (a, b) { return probes[a].draw - probes[b].draw; });
    var results = new Array(probes.length);

    for (var oi = 0; oi < order.length; oi++) {
      var idx = order[oi];
      var p = probes[idx];
      this.seek(p.draw); // 单调：排序后整体只前进一遍
      var cmd = this.cap.commands[p.draw];
      var tri = Math.floor(p.corner / 3);
      var t = this.evalTriangle(cmd, p.draw, p.instance, tri);
      var corner = t.corners[p.corner - tri * 3];

      results[idx] = {
        draw: p.draw,
        instance: p.instance,
        corner: p.corner,
        vertex: corner.vertex,
        skipped: t.skipped,
        fields: corner.fields
      };
    }
    return results;
  };

  /* ------------------------------------------------------------------ *
   * 线框几何：position + offset，缺省 offset 为零
   * ------------------------------------------------------------------ */
  function cornerPoint(corner) {
    var pos = corner.fields.position;
    if (!pos || pos.error || !pos.value) return null;
    var x = pos.value[0];
    var y = pos.value[1];
    var off = corner.fields.offset;
    if (off && !off.error && off.value) {
      x += off.value[0];
      y += off.value[1];
    }
    return [x, y];
  }

  global.VSR = {
    LIMIT_INITIAL_BYTES: LIMIT_INITIAL_BYTES,
    LIMIT_COMMANDS: LIMIT_COMMANDS,
    LIMIT_REWRITE_BYTES: LIMIT_REWRITE_BYTES,
    LIMIT_PROBES: LIMIT_PROBES,
    FIELD_SIZE: FIELD_SIZE,
    ATTR_TYPES: ATTR_TYPES,
    CaptureError: CaptureError,
    parseCapture: parseCapture,
    parseProbes: parseProbes,
    Replayer: Replayer,
    decodeField: decodeField,
    decodeHex: decodeHex,
    toHex: toHex,
    cornerPoint: cornerPoint
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VSR;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
