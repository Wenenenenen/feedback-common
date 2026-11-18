/*
 * rblab-util.js — 纯整数工具：UTF-8 字节、FNV-1a 32、确定性 LCG。
 * 不使用浮点、不使用 Math.random / Date，保证同一份输入每次结果完全一致。
 * UMD：浏览器挂到 window.RBLab.util，Node 走 module.exports。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.RBLab = root.RBLab || {};
    root.RBLab.util = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* UTF-8 编码（TextEncoder 本身是纯字节确定性算法；保留手写兜底） */
  var TEXT_ENCODER = (typeof TextEncoder !== 'undefined') ? new TextEncoder('utf-8') : null;

  function utf8Bytes(str) {
    if (TEXT_ENCODER) {
      return Array.prototype.slice.call(TEXT_ENCODER.encode(str));
    }
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(
          0xF0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3F),
          0x80 | ((cp >> 6) & 0x3F),
          0x80 | (cp & 0x3F)
        );
        i++;
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  /*
   * FNV-1a 32 位：初值 2166136261，乘数 16777619。
   * Math.imul 保证有符号 32 位整数乘法语义；>>> 0 转回无符号。
   * 全程整数运算。
   */
  function fnv1a32(str) {
    var bytes = utf8Bytes(str);
    var hash = 2166136261;
    for (var i = 0; i < bytes.length; i++) {
      hash = Math.imul(hash ^ bytes[i], 16777619);
    }
    return hash >>> 0;
  }

  function toHex8(u32) {
    var s = (u32 >>> 0).toString(16);
    while (s.length < 8) {
      s = '0' + s;
    }
    return s;
  }

  function checksum(str) {
    return toHex8(fnv1a32(str));
  }

  /*
   * 确定性 32 位 LCG（Numerical Recipes 常数）。
   * 网络抖动与丢包的唯一随机源；给定种子可逐位复现。
   */
  function Rng(seed) {
    this.state = (seed | 0) >>> 0;
    if (this.state === 0) {
      this.state = 0x9E3779B9; // 避开全零轨道
    }
  }

  Rng.prototype.next = function () {
    // imul 保证 32 位回绕，>>> 0 得到无符号整数
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  };

  /* 返回 [lo, hi] 闭区间内的整数（单位与输入相同，全部整数） */
  Rng.prototype.nextInt = function (lo, hi) {
    if (hi <= lo) {
      return lo | 0;
    }
    var span = (hi - lo + 1) >>> 0;
    return (lo + (this.next() % span)) | 0;
  };

  /* 百分比判定：pct 为 0..100 的整数，返回 true/false */
  Rng.prototype.chance = function (pct) {
    if (pct <= 0) {
      return false;
    }
    if (pct >= 100) {
      return true;
    }
    return (this.next() % 100) < pct;
  };

  /* 深度克隆可 JSON 序列化的数据（状态快照使用） */
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function abs(x) {
    return x < 0 ? -x : x;
  }

  function clampInt(v, lo, hi) {
    if (v < lo) {
      return lo;
    }
    if (v > hi) {
      return hi;
    }
    return v;
  }

  /* 毫秒延迟折算成帧数：ceil(ms / (1000/60)) = ceil(60*ms/1000)，整数 ceil 除法 */
  function msToFrames(ms) {
    if (ms <= 0) {
      return 0;
    }
    return ((60 * ms) + 999) / 1000 | 0;
  }

  return {
    utf8Bytes: utf8Bytes,
    fnv1a32: fnv1a32,
    toHex8: toHex8,
    checksum: checksum,
    Rng: Rng,
    clone: clone,
    abs: abs,
    clampInt: clampInt,
    msToFrames: msToFrames
  };
});
