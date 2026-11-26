/*
 * case.json / PGM 解析与严格校验。
 * 所有错误抛出带文件或字段名的中文信息；调用方保证错误时保留当前项目。
 */
(function (global) {
  'use strict';

  function pad2(i) { return (i < 10 ? '0' : '') + i; }

  function isInt(x) { return typeof x === 'number' && Number.isInteger(x); }

  function requireField(obj, field, frameIdx) {
    if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, field)) {
      throw new Error('case.json: frames[' + frameIdx + '] 缺少字段 "' + field + '"');
    }
    return obj[field];
  }

  /**
   * 校验 case.json 文本，返回 { width, height, frames: [...] }。
   */
  function parseCase(textBytes) {
    var root;
    var text;
    try {
      if (typeof TextDecoder !== 'undefined') text = new TextDecoder('utf-8', { fatal: true }).decode(textBytes);
      else text = utf8Fallback(textBytes);
    } catch (e) {
      throw new Error('case.json: 不是合法 UTF-8 文本');
    }
    try {
      root = JSON.parse(text);
    } catch (e) {
      throw new Error('case.json: JSON 解析失败（' + e.message + '）');
    }
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      throw new Error('case.json: 顶层必须是 JSON 对象');
    }
    if (!isInt(root.width) || root.width < 1 || root.width > 256) {
      throw new Error('case.json: 字段 "width" 必须是 1 到 256 的整数');
    }
    if (!isInt(root.height) || root.height < 1 || root.height > 256) {
      throw new Error('case.json: 字段 "height" 必须是 1 到 256 的整数');
    }
    if (!Array.isArray(root.frames)) {
      throw new Error('case.json: 字段 "frames" 必须是数组');
    }
    var n = root.frames.length;
    if (n < 4 || n > 12) {
      throw new Error('case.json: frames 数量必须在 4 到 12 之间，当前为 ' + n);
    }
    var seenDir = new Set();
    var frames = [];
    for (var i = 0; i < n; i++) {
      var f = root.frames[i];
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        throw new Error('case.json: frames[' + i + '] 必须是对象');
      }
      var u = requireField(f, 'u', i);
      var v = requireField(f, 'v', i);
      var gain = requireField(f, 'gain', i);
      var offset = requireField(f, 'offset', i);
      var weight = requireField(f, 'weight', i);
      if (!isInt(u) || u < -5 || u > 5) throw new Error('case.json: frames[' + i + '].u 必须是 -5 到 5 的整数');
      if (!isInt(v) || v < -5 || v > 5) throw new Error('case.json: frames[' + i + '].v 必须是 -5 到 5 的整数');
      if (u * u + v * v !== 25) {
        throw new Error('case.json: frames[' + i + '] 必须满足 u²+v²=25，当前 (u,v)=(' + u + ',' + v + ')');
      }
      var dirKey = u + ',' + v;
      if (seenDir.has(dirKey)) {
        throw new Error('case.json: frames[' + i + '] 的方向 (' + u + ',' + v + ') 与另一帧重复，同一 (u,v) 必须唯一');
      }
      seenDir.add(dirKey);
      if (!isInt(gain) || gain < 1 || gain > 16) {
        throw new Error('case.json: frames[' + i + '].gain 必须是 1 到 16 的整数');
      }
      if (!isInt(offset) || offset < -4096 || offset > 4096) {
        throw new Error('case.json: frames[' + i + '].offset 必须是 -4096 到 4096 的整数');
      }
      if (!isInt(weight) || weight < 1 || weight > 8) {
        throw new Error('case.json: frames[' + i + '].weight 必须是 1 到 8 的整数');
      }
      var mask = false;
      if (Object.prototype.hasOwnProperty.call(f, 'mask')) {
        if (typeof f.mask !== 'boolean') {
          throw new Error('case.json: frames[' + i + '].mask 必须是布尔值');
        }
        mask = f.mask;
      }
      frames.push({ u: u, v: v, gain: gain, offset: offset, weight: weight, mask: mask });
    }
    return { width: root.width, height: root.height, frames: frames };
  }

  function utf8Fallback(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; ) {
      var b = bytes[i++];
      var cp;
      if (b < 0x80) cp = b;
      else if ((b & 0xe0) === 0xc0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
      else if ((b & 0xf0) === 0xe0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      if (cp > 0xffff) {
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else s += String.fromCharCode(cp);
    }
    return s;
  }

  /**
   * 读取一个 PGM 头部 token。头固定为 P5\n<w> <h>\n<maxval>\n，
   * 这里仍按空白 token 解析，并严格核对结构。
   */
  function readHeader(bytes, expectedMax) {
    var pos = 0;
    function token() {
      // 跳过空白与注释（PGM 允许 # 注释行；本项目头固定无注释，兼容处理）
      while (pos < bytes.length) {
        var c = bytes[pos];
        if (c === 35) {
          while (pos < bytes.length && bytes[pos] !== 10) pos++;
        } else if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) {
          pos++;
        } else break;
      }
      var start = pos;
      while (pos < bytes.length) {
        var ch = bytes[pos];
        if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 11 || ch === 12) break;
        pos++;
      }
      if (pos === start) throw new Error('PGM: 头部不完整');
      return bytes.subarray(start, pos);
    }
    var magic = token();
    if (magic.length !== 2 || magic[0] !== 0x50 || magic[1] !== 0x35) {
      throw new Error('PGM: 魔数必须是 P5');
    }
    var wTok = token();
    var hTok = token();
    var maxTok = token();
    var w = parseDec(wTok, '宽度');
    var h = parseDec(hTok, '高度');
    var maxv = parseDec(maxTok, '最大码值');
    if (maxv !== expectedMax) throw new Error('PGM: 头部最大码值必须是 ' + expectedMax + '，实际为 ' + maxv);
    // 头部后恰好一个空白字节（规范头固定为换行）
    if (pos >= bytes.length) throw new Error('PGM: 头部后缺少数据');
    var sep = bytes[pos++];
    if (sep !== 10 && sep !== 32 && sep !== 9 && sep !== 13) {
      throw new Error('PGM: 头部结束符非法');
    }
    return { width: w, height: h, max: maxv, dataStart: pos };
  }

  function parseDec(tok, label) {
    var s = '';
    for (var i = 0; i < tok.length; i++) {
      var c = tok[i];
      if (c < 48 || c > 57) throw new Error('PGM: 头部 ' + label + ' 不是十进制整数');
      s += String.fromCharCode(c);
    }
    var v = parseInt(s, 10);
    if (v < 1 || v > 65535) throw new Error('PGM: 头部 ' + label + ' 超出范围');
    return v;
  }

  /**
   * 解析 16 位大端灰度 PGM，严格核对尺寸与字节数。
   * 返回 Uint16Array（主机字节序的码值）。
   */
  function parseGrayPgm(bytes, path, width, height) {
    var hdr;
    try {
      hdr = readHeader(bytes, 65535);
    } catch (e) {
      throw new Error(path + ': ' + e.message);
    }
    if (hdr.width !== width || hdr.height !== height) {
      throw new Error(path + ': 尺寸 ' + hdr.width + 'x' + hdr.height + ' 与 case.json 的 ' + width + 'x' + height + ' 不一致');
    }
    var need = width * height * 2;
    if (bytes.length - hdr.dataStart !== need) {
      throw new Error(path + ': 数据长度应为 ' + need + ' 字节，实际为 ' + (bytes.length - hdr.dataStart));
    }
    var out = new Uint16Array(width * height);
    var p = hdr.dataStart;
    for (var i = 0; i < out.length; i++) {
      out[i] = (bytes[p] << 8) | bytes[p + 1];
      p += 2;
    }
    return out;
  }

  /**
   * 解析 8 位掩膜 PGM（maxval=255），每字节只能 0 或 255。
   * 返回 Uint8Array，255=可用。
   */
  function parseMaskPgm(bytes, path, width, height) {
    var hdr;
    try {
      hdr = readHeader(bytes, 255);
    } catch (e) {
      throw new Error(path + ': ' + e.message);
    }
    if (hdr.width !== width || hdr.height !== height) {
      throw new Error(path + ': 尺寸 ' + hdr.width + 'x' + hdr.height + ' 与 case.json 的 ' + width + 'x' + height + ' 不一致');
    }
    var need = width * height;
    if (bytes.length - hdr.dataStart !== need) {
      throw new Error(path + ': 掩膜数据长度应为 ' + need + ' 字节，实际为 ' + (bytes.length - hdr.dataStart));
    }
    var out = new Uint8Array(need);
    for (var i = 0; i < need; i++) {
      var b = bytes[hdr.dataStart + i];
      if (b !== 0 && b !== 255) {
        throw new Error(path + ': 掩膜字节只能为 0 或 255，位置 ' + i + ' 出现 ' + b);
      }
      out[i] = b;
    }
    return out;
  }

  /**
   * 把整个 ZIP（Map<path,Uint8Array>）组装成项目数据。
   * 返回 { width, height, frames:[{...meta, image:Uint16Array, mask:Uint8Array|null}] }
   */
  function buildProject(entries) {
    if (!entries.has('case.json')) throw new Error('ZIP: 根目录缺少 case.json');
    var spec = parseCase(entries.get('case.json'));
    var n = spec.frames.length;
    for (var i = 0; i < n; i++) {
      var framePath = 'frames/' + pad2(i) + '.pgm';
      if (!entries.has(framePath)) throw new Error('ZIP: 缺少文件 ' + framePath);
      var image = parseGrayPgm(entries.get(framePath), framePath, spec.width, spec.height);
      spec.frames[i].image = image;
      if (spec.frames[i].mask) {
        var maskPath = 'masks/' + pad2(i) + '.pgm';
        if (!entries.has(maskPath)) throw new Error('ZIP: frames[' + i + '] 声明 mask=true，但缺少 ' + maskPath);
        spec.frames[i].maskData = parseMaskPgm(entries.get(maskPath), maskPath, spec.width, spec.height);
      } else {
        var unexpected = 'masks/' + pad2(i) + '.pgm';
        if (entries.has(unexpected)) {
          throw new Error('ZIP: 存在 ' + unexpected + ' 但 frames[' + i + '].mask 不为 true');
        }
        spec.frames[i].maskData = null;
      }
    }
    return spec;
  }

  var api = { parseCase: parseCase, parseGrayPgm: parseGrayPgm, parseMaskPgm: parseMaskPgm, buildProject: buildProject, pad2: pad2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.StokesIO = api;
})(typeof window !== 'undefined' ? window : globalThis);
