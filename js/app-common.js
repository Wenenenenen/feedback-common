/* 浏览器端共享工具：文件读取、WAV 编解码封装、音频 Blob、提示条、DOM 辅助。 */
(function (global) {
  'use strict';
  var WM = global.WM;
  var App = global.App = {};

  function $(sel, root) { return (root || document).querySelector(sel); }
  App.$ = $;
  App.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  App.el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  };

  App.toast = function (msg, isErr) {
    var t = $('#toast');
    if (!t) { alert(msg); return; }
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(App._toastTimer);
    App._toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
  };

  App.readFileArrayBuffer = function (file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('文件读取失败')); };
      fr.readAsArrayBuffer(file);
    });
  };

  App.decodeWav = function (arrayBuffer) { return WM.decodeWav(arrayBuffer); };
  App.encodeWav = function (samples, sampleRate) { return WM.encodeWav(samples, sampleRate); };

  App.wavBlob = function (arrayBuffer) {
    return new Blob([arrayBuffer], { type: 'audio/wav' });
  };
  App.objectUrl = function (blob) { return URL.createObjectURL(blob); };

  App.fmtSec = function (s) {
    if (!isFinite(s)) return '—';
    var m = Math.floor(s / 60);
    var ss = (s - m * 60).toFixed(2);
    return (m ? m + ':' : '') + (ss.length < 5 ? '0' + ss : ss) + 's';
  };

  App.validateHex8 = function (v) { return /^[0-9a-fA-F]{8}$/.test(v.trim()); };

  // 限幅并保证长度一致的差值信号
  App.differenceSamples = function (orig, marked) {
    var out = [];
    for (var c = 0; c < orig.length; c++) {
      var a = orig[c], b = marked[c], n = a.length;
      var d = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var v = b[i] - a[i];
        d[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
      }
      out.push(d);
    }
    return out;
  };

  App.rms = function (x) {
    var s = 0;
    for (var i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / x.length);
  };

  // 绑定拖拽 + 点选的文件选择区
  App.bindDrop = function (dropEl, inputEl, onFile) {
    dropEl.addEventListener('click', function () { inputEl.click(); });
    inputEl.addEventListener('change', function () {
      if (inputEl.files && inputEl.files[0]) onFile(inputEl.files[0]);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.remove('over'); });
    });
    dropEl.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
