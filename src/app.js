/*
 * 应用层：项目状态、帧开关、可取消的分块重算调度、并发任务代际隔离、
 * 三张伪彩图渲染、像素明细、结果导出。纯手写，无第三方依赖。
 */
(function (global) {
  'use strict';

  var state = {
    project: null,          // buildProject 的结果
    enabled: [],            // 每帧开关
    result: null,           // 已发布结果（与 resultToken 对应）
    resultToken: -1,        // 已发布结果的设置代际
    runId: 0,               // 正在进行的计算代际
    running: false,
    progress: 0,
    selectedPx: -1,
    view: 'intensity',      // intensity | dolp | angle
    colorMode: 'color',     // color | gray
    fileName: '',
  };

  var listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) { (listeners[evt] || []).forEach(function (fn) { fn(payload); }); }

  /* ---------------- 项目加载（失败不影响当前项目） ---------------- */
  function loadZipFile(file) {
    return file.arrayBuffer().then(function (buf) {
      var entries = global.StokesZip.unzip(buf, { verifyCrc: true });
      var project = global.StokesIO.buildProject(entries); // 抛错由调用方捕获
      state.project = project;
      state.enabled = project.frames.map(function () { return true; });
      state.result = null;
      state.resultToken = -1;
      state.selectedPx = -1;
      state.fileName = file.name;
      emit('project', project);
      scheduleRecompute();
    });
  }

  /* ---------------- 可取消分块调度（代际隔离） ---------------- */
  function currentToken() {
    // 设置指纹：启用帧的有序列表
    return state.enabled.map(function (e, i) { return e ? i : -1; }).filter(function (i) { return i >= 0; }).join(',');
  }

  function scheduleRecompute() {
    if (!state.project) return;
    var myRun = ++state.runId;
    var token = currentToken();
    state.running = true;
    state.progress = 0;
    emit('status', { running: true, progress: 0 });

    var project = state.project;
    var enabled = state.enabled.slice();
    var ctx = global.StokesSolver.prepare(project, enabled);
    var N = ctx.width * ctx.height;
    var s0 = new Float64Array(N), s1 = new Float64Array(N), s2 = new Float64Array(N);
    var solved = new Uint8Array(N);
    var CHUNK = 1024;
    var px = 0;

    function step() {
      // 新计算已开始或设置已变：本任务作废，绝不发布
      if (myRun !== state.runId) return;
      var end = Math.min(N, px + CHUNK);
      for (; px < end; px++) {
        var r = global.StokesSolver.solvePixel(ctx, px);
        if (r) { s0[px] = r.s[0]; s1[px] = r.s[1]; s2[px] = r.s[2]; solved[px] = 1; }
      }
      state.progress = px / N;
      emit('status', { running: true, progress: state.progress });
      if (px < N) {
        setTimeout(step, 0);
      } else {
        // 完成前再次核对代际与设置指纹
        if (myRun !== state.runId || token !== currentToken()) return;
        var enabledList = [];
        for (var i = 0; i < enabled.length; i++) if (enabled[i]) enabledList.push(i);
        state.result = {
          width: ctx.width, height: ctx.height,
          enabled: enabledList,
          s0: s0, s1: s1, s2: s2, solved: solved,
          token: token,
        };
        state.resultToken = state.runId;
        state.running = false;
        state.progress = 1;
        emit('result', state.result);
        emit('status', { running: false, progress: 1 });
      }
    }
    setTimeout(step, 0);
  }

  function toggleFrame(i) {
    if (!state.project) return;
    state.enabled[i] = !state.enabled[i];
    state.selectedPx = -1;
    emit('toggles', state.enabled);
    scheduleRecompute();
  }

  function setView(v) { state.view = v; emit('view', v); }
  function setColorMode(m) { state.colorMode = m; emit('colormode', m); }
  function selectPixel(px) { state.selectedPx = px; emit('select', px); }

  /* ---------------- 派生量 ---------------- */
  function dolpAt(px) {
    var r = state.result;
    if (!r || !r.solved[px]) return null;
    if (r.s0[px] === 0) return 0;
    return Math.hypot(r.s1[px], r.s2[px]) / r.s0[px];
  }
  function angleAt(px) {
    var r = state.result;
    if (!r || !r.solved[px]) return null;
    if (Math.hypot(r.s1[px], r.s2[px]) < 1) return null; // 未定义
    var deg = 0.5 * Math.atan2(r.s2[px], r.s1[px]) * 180 / Math.PI;
    if (deg < 0) deg += 180;
    return deg;
  }

  /* ---------------- 像素明细（状态优先级：禁用>掩膜>下饱和>上饱和>普通） ---------------- */
  function pixelDetail(px) {
    var project = state.project;
    var r = state.result;
    if (!project || px < 0) return null;
    var rows = project.frames.map(function (f, i) {
      var m = f.image[px];
      var masked = f.maskData && f.maskData[px] !== 255;
      var enabled = state.enabled[i];
      var status, included = false;
      if (!enabled) status = '禁用';
      else if (masked) status = '掩膜排除';
      else if (m === 0) { status = '下饱和'; included = true; }
      else if (m === 65535) { status = '上饱和'; included = true; }
      else { status = '普通'; included = true; }
      var predict = null, residual = null;
      var hasSolution = r && r.solved[px];
      if (hasSolution) {
        var s = [r.s0[px], r.s1[px], r.s2[px]];
        var p = global.StokesSolver.predict(f, s); // 未截断预测
        predict = p;
        if (included) {
          if (m === 0) residual = Math.max(0, p);
          else if (m === 65535) residual = Math.min(0, p - 65535);
          else residual = p - m;
        }
      }
      return {
        index: i, u: f.u, v: f.v, gain: f.gain, offset: f.offset, weight: f.weight,
        measurement: m, status: status, included: included,
        predict: predict, residual: residual, enabled: enabled, masked: masked,
      };
    });
    var stokes = null;
    if (r && r.solved[px]) stokes = [r.s0[px], r.s1[px], r.s2[px]];
    return {
      px: px,
      x: px % project.width,
      y: Math.floor(px / project.width),
      rows: rows,
      stokes: stokes,
      solved: !!(r && r.solved[px]),
      dolp: dolpAt(px),
      angle: angleAt(px),
    };
  }

  /* ---------------- 导出（与页面同一批结果；无解写 null） ---------------- */
  function buildExportJSON() {
    var r = state.result;
    if (!r) return null;
    var pixels = new Array(r.width * r.height);
    for (var px = 0; px < pixels.length; px++) {
      if (!r.solved[px]) pixels[px] = null;
      else pixels[px] = [r.s0[px], r.s1[px], r.s2[px]];
    }
    return {
      width: r.width,
      height: r.height,
      enabled: r.enabled.slice(),
      pixels: pixels,
    };
  }

  global.StokesApp = {
    state: state,
    on: on,
    loadZipFile: loadZipFile,
    scheduleRecompute: scheduleRecompute,
    toggleFrame: toggleFrame,
    setView: setView,
    setColorMode: setColorMode,
    selectPixel: selectPixel,
    pixelDetail: pixelDetail,
    buildExportJSON: buildExportJSON,
    dolpAt: dolpAt,
    angleAt: angleAt,
  };
})(typeof window !== 'undefined' ? window : globalThis);
