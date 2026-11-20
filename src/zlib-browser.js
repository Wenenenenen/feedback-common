/* 浏览器端 zlib 注入：把 pako 包成 G53 / PNG8 需要的接口 */
(function (root) {
  'use strict';
  root.zlibAdapter = {
    deflate(u8) { return pako.deflate(u8); },
    inflate(u8) { return pako.inflate(u8); },
    crc32: root.G53.crc32,
  };
})(typeof self !== 'undefined' ? self : this);
