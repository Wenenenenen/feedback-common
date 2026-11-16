/*
 * 踏板/偷声声部复现引擎 —— 48kHz 单声道离线合成
 * 规则见 samples/pedal-voice-cases/约定.json。
 * 浏览器与 Node 共用：浏览器挂到 window.PedalVoiceEngine，Node 用 module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PedalVoiceEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const SR = 48000;
  const MAX_EVENTS = 5000;
  const MAX_VOICES = 32;
  const MAX_PROJECT_SEC = 30;

  const msToFrames = (ms) => Math.floor(ms * 48 + 0.5);
  const secToFrame = (sec) => Math.floor(sec * SR + 0.5);

  /* 非 release 段包络：a<A 取 a/A；A<=a<A+D 线性到 sustain；其后 sustain。零长度阶段跳过。 */
  function envelopeAt(age, A, D, sustain) {
    if (A > 0 && age < A) return age / A;
    const d = age - A;
    if (D > 0 && d < D) return 1 - (1 - sustain) * (d / D);
    return sustain;
  }

  function validateParams(p) {
    const errs = [];
    const num = (x, lo, hi, name, integer) => {
      if (typeof x !== 'number' || !isFinite(x) || x < lo || x > hi || (integer && !Number.isInteger(x))) {
        errs.push(`${name} 必须在 ${lo}..${hi}${integer ? ' 且为整数' : ''}（当前: ${x}）`);
      }
    };
    if (!p || typeof p !== 'object') return ['params 必须为对象'];
    num(p.attack_ms, 0, 200, 'attack_ms');
    num(p.decay_ms, 0, 500, 'decay_ms');
    num(p.sustain, 0, 1, 'sustain');
    num(p.release_ms, 0, 2000, 'release_ms');
    num(p.voices, 1, MAX_VOICES, 'voices', true);
    return errs;
  }

  function validateProject(proj) {
    const errs = [];
    if (!proj || typeof proj !== 'object' || Array.isArray(proj)) return ['项目必须是 JSON 对象'];
    if (!Number.isInteger(proj.ppqn) || proj.ppqn < 1 || proj.ppqn > 9600) {
      errs.push('ppqn 必须为 1..9600 的整数');
    }
    const durValid = Number.isInteger(proj.duration_ticks) && proj.duration_ticks >= 1;
    if (!durValid) errs.push('duration_ticks 必须为正整数');

    if (!Array.isArray(proj.tempo)) {
      errs.push('tempo 必须为数组');
    } else {
      const seen = new Set();
      proj.tempo.forEach((t, i) => {
        if (!t || typeof t !== 'object') { errs.push(`tempo[${i}] 必须为对象`); return; }
        if (!Number.isInteger(t.tick) || t.tick < 0 || (durValid && t.tick >= proj.duration_ticks)) {
          errs.push(`tempo[${i}].tick 必须满足 0<=tick<duration_ticks`);
        } else if (seen.has(t.tick)) {
          errs.push(`tempo tick ${t.tick} 重复`);
        } else {
          seen.add(t.tick);
        }
        if (typeof t.us_per_quarter !== 'number' || !isFinite(t.us_per_quarter) ||
            t.us_per_quarter < 1 || t.us_per_quarter > 60000000) {
          errs.push(`tempo[${i}].us_per_quarter 必须在 1..60000000`);
        }
      });
    }

    if (!Array.isArray(proj.events)) {
      errs.push('events 必须为数组');
    } else {
      if (proj.events.length > MAX_EVENTS) errs.push(`事件数 ${proj.events.length} 超过 ${MAX_EVENTS} 上限`);
      proj.events.forEach((e, i) => {
        if (!e || typeof e !== 'object') { errs.push(`events[${i}] 必须为对象`); return; }
        if (!Number.isInteger(e.tick) || e.tick < 0 || (durValid && e.tick >= proj.duration_ticks)) {
          errs.push(`events[${i}].tick 必须满足 0<=tick<duration_ticks`);
        }
        if (!Number.isInteger(e.channel) || e.channel < 0 || e.channel > 15) {
          errs.push(`events[${i}].channel 必须为 0..15`);
        }
        const keyOk = Number.isInteger(e.key) && e.key >= 0 && e.key <= 127;
        if (e.type === 'on') {
          if (!keyOk) errs.push(`events[${i}].key 必须为 0..127`);
          if (!Number.isInteger(e.velocity) || e.velocity < 0 || e.velocity > 127) {
            errs.push(`events[${i}].velocity 必须为 0..127`);
          }
        } else if (e.type === 'off') {
          if (!keyOk) errs.push(`events[${i}].key 必须为 0..127`);
        } else if (e.type === 'pedal') {
          if (!Number.isInteger(e.value) || e.value < 0 || e.value > 127) {
            errs.push(`events[${i}].value 必须为 0..127`);
          }
        } else {
          errs.push(`events[${i}].type 必须为 on/off/pedal`);
        }
      });
    }
    return errs;
  }

  /*
   * 计算时间线：事件帧号、声部状态机（配对/踏板/偷声/释放）。
   * 返回 { errors, voices, events, unmatchedOffs, projectEndFrame, totalFrames, A, D, R, ... }
   */
  function computeTimeline(project, params) {
    const errors = validateProject(project).concat(validateParams(params));
    if (errors.length) return { errors };

    const ppqn = project.ppqn;
    // 速度表按 tick 排序，缺 tick=0 补默认 500000
    const tempo = project.tempo
      .map((t) => ({ tick: t.tick, us: t.us_per_quarter }))
      .sort((a, b) => a.tick - b.tick);
    if (!tempo.length || tempo[0].tick !== 0) tempo.unshift({ tick: 0, us: 500000 });

    // 分段积分累计秒数
    const segs = [];
    let acc = 0;
    for (let i = 0; i < tempo.length; i++) {
      segs.push({ tick: tempo[i].tick, us: tempo[i].us, startSec: acc });
      const next = i + 1 < tempo.length ? tempo[i + 1].tick : project.duration_ticks;
      acc += ((next - tempo[i].tick) / ppqn) * (tempo[i].us / 1e6);
    }
    const totalSec = acc;
    if (totalSec > MAX_PROJECT_SEC + 1e-9) {
      return { errors: [`项目时长 ${totalSec.toFixed(3)}s 超过 ${MAX_PROJECT_SEC} 秒上限`] };
    }
    const secAtTick = (t) => {
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].tick <= t) lo = mid; else hi = mid - 1;
      }
      const s = segs[lo];
      return s.startSec + ((t - s.tick) / ppqn) * (s.us / 1e6);
    };
    const projectEndFrame = secToFrame(totalSec);

    const A = msToFrames(params.attack_ms);
    const D = msToFrames(params.decay_ms);
    const R = msToFrames(params.release_ms);
    const sustain = params.sustain;
    const limit = params.voices;

    // 事件按 (tick, 原数组下标) 稳定排序；frame 随 tick 单调，同帧保持该顺序
    const events = project.events
      .map((e, i) => Object.assign({ index: i }, e))
      .sort((a, b) => (a.tick - b.tick) || (a.index - b.index));
    for (const e of events) e.frame = secToFrame(secAtTick(e.tick));

    const voices = [];
    let active = [];
    const pending = new Map(); // "ch:key" -> 未配对声部队列（FIFO）
    const pedal = new Array(16).fill(false);
    const unmatchedOffs = [];

    const envAt = (age) => envelopeAt(age, A, D, sustain);
    const startRelease = (v, frame, reason) => {
      v.releaseFrame = frame;
      v.releaseEnv = envAt(frame - v.onFrame); // 当前帧先取原包络值 h
      v.endFrame = frame + R;                  // R=0 立即结束
      v.reason = reason;
    };

    for (const e of events) {
      const f = e.frame;
      // 处理事件前先清理自然结束的声部
      active = active.filter((v) => v.endFrame === null || f < v.endFrame);

      const isOff = e.type === 'off' || (e.type === 'on' && e.velocity === 0);
      if (e.type === 'on' && !isOff) {
        if (active.length >= limit) {
          // 优先偷 release 声部；取 on_frame 最小者，并列取 id 最小者
          const released = active.filter((v) => v.releaseFrame !== null);
          const pool = released.length ? released : active;
          let victim = pool[0];
          for (const v of pool) {
            if (v.onFrame < victim.onFrame || (v.onFrame === victim.onFrame && v.id < victim.id)) victim = v;
          }
          victim.endFrame = f; // 立即截断，不播放尾音
          victim.reason = 'stolen';
          active = active.filter((v) => v !== victim);
        }
        const v = {
          id: e.index, channel: e.channel, key: e.key, velocity: e.velocity,
          onFrame: f, keyUpFrame: null, releaseFrame: null, endFrame: null,
          reason: null, releaseEnv: 0,
        };
        voices.push(v);
        active.push(v);
        const k = e.channel + ':' + e.key;
        if (!pending.has(k)) pending.set(k, []);
        pending.get(k).push(v);
      } else if (isOff) {
        // velocity=0 的 on 按 off 处理；off 消费同通道同音高最早未配对的 on
        const k = e.channel + ':' + e.key;
        const q = pending.get(k);
        if (q && q.length) {
          const v = q.shift();
          v.keyUpFrame = f; // 即使声部已被偷走也要写回
          const alive = v.endFrame === null || f < v.endFrame;
          if (alive && v.releaseFrame === null && !pedal[e.channel]) {
            startRelease(v, f, 'release');
          }
          // 踏板下仅标记松键；已被偷的声部只记录配对
        } else {
          unmatchedOffs.push(e.index); // 未配对 off 记警告并忽略
        }
      } else if (e.type === 'pedal') {
        if (e.value >= 64) {
          pedal[e.channel] = true;
        } else {
          pedal[e.channel] = false;
          // 抬踏板：释放本通道所有已松键但未释放的声部；仍按键的继续
          for (const v of active) {
            if (v.channel === e.channel && v.keyUpFrame !== null && v.releaseFrame === null) {
              startRelease(v, f, 'release');
            }
          }
        }
      }
    }

    // 项目结束：无视踏板，强制所有未 release 声部进入 release（已 release 的不重启）
    for (const v of active) {
      if (v.releaseFrame === null) startRelease(v, projectEndFrame, 'project_end');
    }

    const totalFrames = projectEndFrame + R; // 输出恰为结束帧 + R 帧
    return {
      errors: [], voices, events, unmatchedOffs,
      projectEndFrame, totalFrames, totalSec,
      A, D, R, sustain, limit,
    };
  }

  /* 离线合成：每帧全部事件已处理完，逐声部求和；不归一化，超界计数并饱和。 */
  function renderAudio(tl) {
    const out = new Float32Array(tl.totalFrames);
    const { A, D, R, sustain } = tl;
    for (const v of tl.voices) {
      const freq = 440 * Math.pow(2, (v.key - 69) / 12);
      const amp = 0.15 * (v.velocity / 127);
      const w = (2 * Math.PI * freq) / SR;
      const end = Math.min(v.endFrame, tl.totalFrames);
      for (let n = v.onFrame; n < end; n++) {
        const age = n - v.onFrame;
        let env;
        if (v.releaseFrame !== null && n >= v.releaseFrame) {
          env = v.releaseEnv * (1 - (n - v.releaseFrame) / R); // R>0 才会走到这里
        } else {
          env = envelopeAt(age, A, D, sustain);
        }
        out[n] += amp * env * Math.sin(w * age); // 相位从 on 帧起为 0
      }
    }
    let clipped = 0;
    for (let n = 0; n < out.length; n++) {
      const x = out[n];
      if (x > 1 || x < -1) {
        clipped++;
        out[n] = x > 1 ? 1 : -1;
      }
    }
    return { samples: out, clipped };
  }

  /* 48kHz 单声道 24 位 PCM WAV；按 2^23 量化、半值远离 0、饱和。 */
  function encodeWav24(samples) {
    const n = samples.length;
    const dataSize = n * 3;
    const buf = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(buf);
    const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);          // PCM
    dv.setUint16(22, 1, true);          // 单声道
    dv.setUint32(24, SR, true);
    dv.setUint32(28, SR * 3, true);     // 字节率
    dv.setUint16(32, 3, true);          // 块对齐
    dv.setUint16(34, 24, true);         // 位深
    wstr(36, 'data'); dv.setUint32(40, dataSize, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      let x = samples[i];
      if (x > 1) x = 1; else if (x < -1) x = -1;
      let q = (x < 0 ? -1 : 1) * Math.floor(Math.abs(x) * 8388608 + 0.5); // 半值远离 0
      if (q > 8388607) q = 8388607;
      if (q < -8388608) q = -8388608;
      dv.setUint8(o, q & 0xff);
      dv.setUint8(o + 1, (q >> 8) & 0xff);
      dv.setUint8(o + 2, (q >> 16) & 0xff);
      o += 3;
    }
    return buf;
  }

  /* 逐声部报告：帧级起止、松键、释放原因、未配对事件与削波数。 */
  function buildReport(tl, render) {
    return {
      sample_rate: SR,
      total_frames: tl.totalFrames,
      project_end_frame: tl.projectEndFrame,
      envelope_frames: { attack: tl.A, decay: tl.D, release: tl.R },
      voices: tl.voices.map((v) => ({
        id: v.id,
        channel: v.channel,
        key: v.key,
        on_frame: v.onFrame,
        key_up_frame: v.keyUpFrame,
        release_frame: v.releaseFrame,
        end_frame: v.endFrame, // 不再贡献声音的首帧
        reason: v.reason,      // stolen | release | project_end
      })),
      unmatched_off_events: tl.unmatchedOffs.slice(),
      clipped_samples: render.clipped,
    };
  }

  /* 某帧的声部状态（供游标显示）。 */
  function voiceStateAt(v, frame, tl) {
    if (frame < v.onFrame) return { state: 'pending', env: 0 };
    if (frame >= v.endFrame) return { state: v.reason === 'stolen' ? 'stolen' : 'ended', env: 0 };
    let env;
    if (v.releaseFrame !== null && frame >= v.releaseFrame) {
      env = v.releaseEnv * (1 - (frame - v.releaseFrame) / tl.R);
      return { state: 'release', env };
    }
    env = envelopeAt(frame - v.onFrame, tl.A, tl.D, tl.sustain);
    if (v.keyUpFrame !== null && frame >= v.keyUpFrame) return { state: 'pedal', env };
    return { state: 'held', env };
  }

  return {
    SR, MAX_EVENTS, MAX_VOICES, MAX_PROJECT_SEC,
    msToFrames, secToFrame, envelopeAt,
    validateProject, validateParams,
    computeTimeline, renderAudio, encodeWav24, buildReport, voiceStateAt,
  };
});
