/*
 * zipio.js — 最小 ZIP 读取 + 案例导入
 * 浏览器：DecompressionStream('deflate-raw')；Node：zlib.inflateRaw。
 * 纯静态、无外部依赖。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PilotIO = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function ascii(bytes, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
    return s;
  }

  // 解析 ZIP 中央目录，返回 [{name, method, compressed, localOffset, size}]
  function readCentralDirectory(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    var minScan = Math.max(0, bytes.length - 65557);
    for (var i = bytes.length - 22; i >= minScan; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('找不到 ZIP 中央目录（EOCD）');
    var total = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    if (total === 0xffff || cdOff === 0xffffffff) {
      throw new Error('暂不支持 ZIP64（案例包应远小于 4GB）');
    }
    var entries = [];
    var p = cdOff;
    for (var n = 0; n < total; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 中央目录条目签名错误');
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var size = dv.getUint32(p + 24, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.push({
        name: name,
        method: method,
        compressedSize: compSize,
        size: size,
        localOffset: localOff
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function extractRaw(bytes, entry) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var lo = entry.localOffset;
    if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error('ZIP 本地文件头签名错误：' + entry.name);
    var nameLen = dv.getUint16(lo + 26, true);
    var extraLen = dv.getUint16(lo + 28, true);
    var start = lo + 30 + nameLen + extraLen;
    return bytes.subarray(start, start + entry.compressedSize);
  }

  function nodeInflateRaw(u8) {
    // 仅在 Node 测试环境调用
    var zlib = require('zlib');
    return new Uint8Array(zlib.inflateRawSync(Buffer.from(u8)));
  }

  async function browserInflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') {
      // 老环境退回 Node zlib（若存在）
      if (typeof require === 'function') return nodeInflateRaw(u8);
      throw new Error('当前浏览器不支持 DecompressionStream，请改用多选导入 project.json 和 tape.wav');
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  // 返回 { name -> Uint8Array }（目录条目忽略）
  async function unzip(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var metas = readCentralDirectory(bytes);
    var out = {};
    for (var i = 0; i < metas.length; i++) {
      var e = metas[i];
      if (e.name.endsWith('/')) continue;
      var raw = extractRaw(bytes, e);
      var data;
      if (e.method === 0) data = raw.slice();
      else if (e.method === 8) {
        if (typeof window === 'undefined' && typeof require === 'function') {
          data = nodeInflateRaw(raw);
        } else {
          data = await browserInflateRaw(raw);
        }
      } else throw new Error('不支持的 ZIP 压缩方法 ' + e.method + '（' + e.name + '）');
      out[e.name] = data;
    }
    return out;
  }

  function baseName(p) {
    var parts = String(p).split('/');
    return parts[parts.length - 1];
  }

  function dirName(p) {
    var i = String(p).lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i + 1);
  }

  function decodeJson(u8) {
    return JSON.parse(new TextDecoder('utf-8').decode(u8));
  }

  // 从解压后的文件映射读取案例
  function buildCaseFromFiles(files) {
    var names = Object.keys(files);
    var projName = null;
    // 优先根目录 project.json，其次任意路径下的同名文件，取路径最短
    names.forEach(function (n) {
      if (baseName(n) === 'project.json') {
        if (projName === null || n.length < projName.length) projName = n;
      }
    });
    if (!projName) throw new Error('包内找不到 project.json');
    var project = decodeJson(files[projName]);
    var dir = dirName(projName);

    var wavName = null;
    var wanted = project.wav ? dir + project.wav : null;
    if (wanted && files[wanted]) wavName = wanted;
    if (!wavName && project.wav) {
      names.forEach(function (n) {
        if (baseName(n) === baseName(project.wav) && (!wavName || n.length < wavName.length)) wavName = n;
      });
    }
    if (!wavName) {
      names.forEach(function (n) {
        if (/\.wav$/i.test(n) && !wavName) wavName = n;
      });
    }
    if (!wavName) throw new Error('包内找不到 WAV 音频（project.wav=' + project.wav + '）');

    var wavBytes = files[wavName];
    var Audio = typeof PilotAudio !== 'undefined' ? PilotAudio
      : (typeof require === 'function' ? require('./audio.js') : root.PilotAudio);
    var wav = Audio.parseWav(wavBytes);

    var specText = null;
    names.forEach(function (n) {
      if (/约定|\.txt$/i.test(baseName(n)) && specText === null) {
        try { specText = new TextDecoder('utf-8').decode(files[n]); } catch (e) { /* ignore */ }
      }
    });

    return {
      project: project,
      wav: wav,
      wavBytes: wavBytes,
      specText: specText,
      projectName: projName,
      wavName: wavName,
      fileNames: names
    };
  }

  async function loadCaseFromZipBuffer(buf) {
    var files = await unzip(buf);
    return buildCaseFromFiles(files);
  }

  // 多选 File：按文件名找 project.json / wav
  async function loadCaseFromFileList(fileList) {
    var files = {};
    var arr = Array.prototype.slice.call(fileList);
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      var u8 = new Uint8Array(await f.arrayBuffer());
      if (/\.zip$/i.test(f.name)) return loadCaseFromZipBuffer(u8);
      files[f.webkitRelativePath && f.webkitRelativePath.includes('/') ? f.webkitRelativePath : f.name] = u8;
    }
    return buildCaseFromFiles(files);
  }

  return {
    readCentralDirectory: readCentralDirectory,
    unzip: unzip,
    buildCaseFromFiles: buildCaseFromFiles,
    loadCaseFromZipBuffer: loadCaseFromZipBuffer,
    loadCaseFromFileList: loadCaseFromFileList
  };
});
