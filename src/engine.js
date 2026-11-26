/*
 * 采样格谱调度与 PCM 渲染引擎（无 DOM 依赖，可在浏览器与 Node 中运行）
 *
 * 语义严格按包内 format.txt 实现：
 *  - 每个 tick 时长 120000/bpm 个输出帧，精确起点/终点用 BigInt 分数累计，各自向下取整
 *  - 回跳计数按「编排位置 + 命令所在行」独立保存，回跳优先于 break
 *  - 滑音记忆按声部保存，换音不清零；零 slide 取记忆值
 *  - 同 tick 顺序：延迟触发新音 -> 重触发 -> 滑音
 *  - Q16 相位线性插值；循环点在 hi-1 -> lo 之间插值，越界按循环长度取余
 *  - 各声部精确累加后只做一次最近整数舍入（半格远离零）与一次限幅
 */
(function (global) {
  'use strict';

  const SR = 48000;
  const Q = 65536;
  const Q_BI = 65536n;
  const P_BI = 120000n; // 每个 tick 的「帧 * bpm」分子：tick 时长 = 120000/bpm 个输出帧（约定原文）
  const MAX_TICKS = 20000;
  const MAX_FRAMES = 8640000; // 180 秒 * 48000
  const STEP_MIN = 1;
  const STEP_MAX = 1048576;

  const LIMITS = {
    channels: 32,
    samples: 32,
    pcm: 48000,
    patterns: 256,
    rows: 64,
    order: 512,
    backExtra: 64,
    retrig: 32,
    speed: 32,
    bpmMin: 32,
    bpmMax: 384,
  };

  class TrackerError extends Error {
    constructor(message, extra) {
      super(message);
      this.name = 'TrackerError';
      Object.assign(this, extra || {});
    }
  }

  function isInt(v) {
    return typeof v === 'number' && Number.isInteger(v);
  }

  function clampStep(v) {
    return v < STEP_MIN ? STEP_MIN : v > STEP_MAX ? STEP_MAX : v;
  }

  function bgcd(a, b) {
    if (a < 0n) a = -a;
    if (b < 0n) b = -b;
    while (b) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a;
  }

  /* ---------------- 静态校验：收集全部非法点，路径精确到字段 ---------------- */

  function validateSong(song) {
    const e = [];
    const push = (path, message) => e.push({ path, message });

    if (!song || typeof song !== 'object' || Array.isArray(song)) {
      push('$', '根必须是 JSON 对象');
      return e;
    }
    if (!isInt(song.channels) || song.channels < 1 || song.channels > LIMITS.channels)
      push('channels', '必须是 1..32 的整数');
    if (!isInt(song.bpm) || song.bpm < LIMITS.bpmMin || song.bpm > LIMITS.bpmMax)
      push('bpm', '必须是 32..384 的整数');
    if (!isInt(song.speed) || song.speed < 1 || song.speed > LIMITS.speed)
      push('speed', '必须是 1..32 的整数');

    if (!Array.isArray(song.samples)) {
      push('samples', '必须是数组');
    } else {
      if (song.samples.length > LIMITS.samples) push('samples', '至多 32 项');
      song.samples.forEach((smp, i) => {
        const p = `samples[${i}]`;
        if (!smp || typeof smp !== 'object' || Array.isArray(smp)) {
          push(p, '必须是对象');
          return;
        }
        if (!Array.isArray(smp.pcm) || smp.pcm.length < 1 || smp.pcm.length > LIMITS.pcm) {
          push(`${p}.pcm`, '必须是长度 1..48000 的数组');
        } else {
          smp.pcm.forEach((v, j) => {
            if (!isInt(v) || v < -32768 || v > 32767)
              push(`${p}.pcm[${j}]`, '必须是 -32768..32767 的有符号 16 位整数');
          });
        }
        if (smp.loop !== null && smp.loop !== undefined) {
          if (
            !Array.isArray(smp.loop) ||
            smp.loop.length !== 2 ||
            !isInt(smp.loop[0]) ||
            !isInt(smp.loop[1])
          ) {
            push(`${p}.loop`, '必须是 null 或 [lo,hi]');
          } else {
            const n = Array.isArray(smp.pcm) ? smp.pcm.length : 0;
            const [lo, hi] = smp.loop;
            if (!(lo >= 0 && hi <= n && lo < hi))
              push(`${p}.loop`, `必须是 pcm 内的半开区间（0 <= lo < hi <= ${n}）`);
          }
        }
      });
    }

    if (!Array.isArray(song.patterns) || song.patterns.length < 1 || song.patterns.length > LIMITS.patterns) {
      push('patterns', '必须是 1..256 张花样的数组');
    } else {
      song.patterns.forEach((pat, pi) => {
        const p = `patterns[${pi}]`;
        if (!Array.isArray(pat) || pat.length < 1 || pat.length > LIMITS.rows) {
          push(p, '必须是 1..64 行的数组');
          return;
        }
        pat.forEach((row, ri) => validateRow(song, row, pi, ri, push));
      });
    }

    if (!Array.isArray(song.order) || song.order.length < 1 || song.order.length > LIMITS.order) {
      push('order', '必须是 1..512 个花样下标');
    } else if (Array.isArray(song.patterns)) {
      song.order.forEach((v, i) => {
        if (!isInt(v) || v < 0 || v >= song.patterns.length)
          push(`order[${i}]`, `必须是 [0,${song.patterns.length}) 内的花样下标`);
      });
    }
    return e;
  }

  function validateRow(song, row, pi, ri, push) {
    const p = `patterns[${pi}][${ri}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      push(p, '行必须是对象');
      return;
    }
    if (row.bpm !== undefined && (!isInt(row.bpm) || row.bpm < LIMITS.bpmMin || row.bpm > LIMITS.bpmMax))
      push(`${p}.bpm`, '必须是 32..384 的整数');
    if (row.speed !== undefined && (!isInt(row.speed) || row.speed < 1 || row.speed > LIMITS.speed))
      push(`${p}.speed`, '必须是 1..32 的整数');

    if (row.back !== undefined) {
      const b = row.back;
      if (
        !Array.isArray(b) ||
        b.length !== 2 ||
        !isInt(b[0]) ||
        !isInt(b[1]) ||
        b[0] < 0 ||
        b[0] >= ri ||
        b[1] < 1 ||
        b[1] > LIMITS.backExtra
      ) {
        push(`${p}.back`, `必须是 [目标行, 次数]，目标行须早于当前行（< ${ri}），次数 1..64`);
      }
    }
    if (row.break !== undefined) {
      // 越界与否取决于运行时下一编排位置的花样，这里只查类型；实际越界在渲染时报告
      if (!isInt(row.break) || row.break < 0) {
        push(`${p}.break`, '必须是非负行下标');
      }
    }

    if (row.voices !== undefined) {
      if (!Array.isArray(row.voices)) {
        push(`${p}.voices`, '必须是列表');
      } else {
        const seen = new Set();
        row.voices.forEach((vc, vi) => {
          const vp = `${p}.voices[${vi}]`;
          if (!vc || typeof vc !== 'object' || Array.isArray(vc)) {
            push(vp, '必须是对象');
            return;
          }
          if (!isInt(vc.ch) || vc.ch < 0 || !(isInt(song.channels) && vc.ch < song.channels))
            push(`${vp}.ch`, `必须是 [0,${song.channels}) 内且不重复的声道号`);
          else if (seen.has(vc.ch)) push(`${vp}.ch`, `声道 ${vc.ch} 在本行重复`);
          else seen.add(vc.ch);

          if (vc.note !== undefined) {
            if (
              !Array.isArray(vc.note) ||
              vc.note.length !== 2 ||
              !isInt(vc.note[0]) ||
              !isInt(vc.note[1]) ||
              !(Array.isArray(song.samples) && vc.note[0] >= 0 && vc.note[0] < song.samples.length)
            ) {
              push(`${vp}.note`, '必须是 [有效采样下标, 步长]');
            } else if (vc.note[1] < STEP_MIN || vc.note[1] > STEP_MAX) {
              push(`${vp}.note[1]`, '步长必须在 1..1048576（1/65536 源采样单位）');
            }
          } else if (vc.delay !== undefined) {
            push(`${vp}.delay`, '只有带 note 的声部才可设置 delay');
          }
          if (vc.delay !== undefined && (!isInt(vc.delay) || vc.delay < 0))
            push(`${vp}.delay`, '必须是非负整数，且运行时小于实际行速');
          if (vc.retrig !== undefined && (!isInt(vc.retrig) || vc.retrig < 1 || vc.retrig > LIMITS.retrig))
            push(`${vp}.retrig`, '必须是 1..32 的整数');
          if (vc.slide !== undefined && (!isInt(vc.slide) || Math.abs(vc.slide) > STEP_MAX))
            push(`${vp}.slide`, '必须是绝对值不超过 1048576 的整数');
        });
      }
    }
  }

  /* ---------------- 精确混音：dyadic 走 Float64（位精确），循环边界走有理分数 ---------------- */

  class Mixer {
    constructor() {
      this.dyadic = new Float64Array(MAX_FRAMES + 1);
      this.exact = new Map(); // 含非 2 幂分母项的帧 -> 精确分数
    }

    addQ(frame, num) {
      const ex = this.exact.get(frame);
      if (ex) this.merge(frame, BigInt(num), Q_BI);
      else this.dyadic[frame] += num / Q;
    }

    addL(frame, num, den) {
      let ex = this.exact.get(frame);
      if (!ex) {
        // 该帧此前只有 dyadic 项，其 double 值位精确，无损迁移为 num/Q
        ex = { n: BigInt(Math.round(this.dyadic[frame] * Q)), d: Q_BI };
        this.dyadic[frame] = 0;
        this.exact.set(frame, ex);
      }
      this.merge(frame, BigInt(num), BigInt(den));
    }

    merge(frame, a, b) {
      const ex = this.exact.get(frame);
      const g = bgcd(ex.d, b);
      const bScale = b / g; // 旧分子乘 b/g
      const aScale = ex.d / g; // 新分子 a 乘 ex.d/g
      const newD = ex.d * bScale; // 最小公分母 LCM = ex.d * b/g
      const newN = ex.n * bScale + a * aScale;
      ex.n = newN;
      ex.d = newD;
      const g2 = bgcd(ex.n, ex.d);
      if (g2 > 1n) {
        ex.n /= g2;
        ex.d /= g2;
      }
    }

    finish(total) {
      const out = new Int16Array(total);
      for (let f = 0; f < total; f++) {
        let v;
        const ex = this.exact.get(f);
        if (ex) {
          const neg = ex.n < 0n;
          const a = neg ? -ex.n : ex.n;
          let q = a / ex.d;
          const r = a % ex.d;
          if (2n * r >= ex.d) q += 1n; // 半格远离零
          v = Number(neg ? -q : q);
        } else {
          const x = this.dyadic[f]; // 纯 dyadic 求和，double 位精确
          v = Math.floor(Math.abs(x) + 0.5) * (x < 0 ? -1 : 1);
        }
        out[f] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
      return out;
    }
  }

  /* ---------------- 单声部渲染：相位 Q16，帧内线性插值 ---------------- */

  function renderVoice(v, f0, f1, samples, mix) {
    const smp = samples[v.sample];
    const pcm = smp.pcm;
    const N = pcm.length;

    if (v.loop) {
      const lo = v.loop[0];
      const hi = v.loop[1];
      const L = hi - lo;
      const loopSpan = L * Q;
      const boundary = (hi - 1) * Q;
      for (let f = f0; f < f1; f++) {
        // 先处理可能一次越过若干整圈的相位
        let ph = v.phase;
        if (ph >= hi * Q) ph = lo * Q + ((ph - hi * Q) % loopSpan);
        if (ph >= boundary) {
          // 循环最后一个采样与 lo 点插值：值 = a + (b-a)*frac/(L*Q)，分母 L*Q
          const frac = ph - boundary;
          mix.addL(
            f,
            pcm[hi - 1] * loopSpan + (pcm[lo] - pcm[hi - 1]) * frac,
            loopSpan
          );
        } else {
          const i = ph >> 16;
          const frac = ph & (Q - 1);
          mix.addQ(f, pcm[i] * Q + (pcm[i + 1] - pcm[i]) * frac);
        }
        v.phase = ph + v.step;
      }
      return;
    }

    // 非循环：最后一点与零插值，越尾关闭
    let f = f0;
    while (f < f1 && v.active) {
      const ph = v.phase;
      if (ph < (N - 1) * Q) {
        const i = ph >> 16;
        const frac = ph & (Q - 1);
        mix.addQ(f, pcm[i] * Q + (pcm[i + 1] - pcm[i]) * frac);
        v.phase = ph + v.step;
        f++;
      } else if (ph < N * Q) {
        const frac = ph - (N - 1) * Q;
        mix.addQ(f, pcm[N - 1] * (Q - frac)); // 另一端是零
        v.phase = ph + v.step;
        f++;
        if (v.phase >= N * Q) {
          v.active = false;
          v.phase = 0;
        }
      } else {
        v.active = false;
        v.phase = 0;
      }
    }
  }

  /* ---------------- 主调度 ---------------- */

  function renderSong(song) {
    const errors = validateSong(song);
    if (errors.length) {
      throw new TrackerError('格谱存在非法编辑', { kind: 'validation', errors });
    }

    const { patterns, order, samples, channels } = song;
    const voices = [];
    for (let c = 0; c < channels; c++) {
      voices.push({ active: false, sample: 0, phase: 0, step: 0, loop: null, slideMem: 0 });
    }

    const mix = new Mixer();
    const log = [];
    const backMaps = order.map(() => new Map()); // 计数按编排位置独立

    let posIdx = 0;
    let rowIdx = 0;
    let bpm = song.bpm;
    let speed = song.speed;
    let tickIndex = 0;
    let accN = 0n; // 精确累计时间（帧），分数 accN/accD
    let accD = 1n;

    const runtimeFail = (message, extra) => {
      throw new TrackerError(message, Object.assign({
        kind: 'runtime',
        tick: tickIndex,
        frame: Number(accN / accD),
        pos: posIdx,
        pattern: order[posIdx],
        row: rowIdx,
      }, extra || {}));
    };

    outer:
    while (true) {
      const patternIdx = order[posIdx];
      const pattern = patterns[patternIdx];
      const row = pattern[rowIdx];

      if (row.bpm !== undefined) bpm = row.bpm;
      if (row.speed !== undefined) speed = row.speed;

      // 行开始：写入滑音记忆（零取记忆值，省略则本行无滑音）
      const rowVoices = Array.isArray(row.voices) ? row.voices : [];
      for (const entry of rowVoices) {
        if (entry.slide !== undefined) {
          const v = voices[entry.ch];
          if (entry.slide !== 0) v.slideMem = entry.slide;
        }
        // delay 必须小于实际行速（speed 已在本行开头生效）
        if (entry.note && entry.delay !== undefined && entry.delay >= speed) {
          runtimeFail(`delay=${entry.delay} 不小于实际行速 ${speed}`, {
            limit: 'illegal-edit', field: 'delay',
          });
        }
      }

      let jump = null;
      for (let t = 0; t < speed; t++) {
        if (tickIndex >= MAX_TICKS) {
          runtimeFail(`实际执行超过 ${MAX_TICKS} tick 上限`, { limit: 'ticks' });
        }

        const events = new Array(channels);
        for (let c = 0; c < channels; c++) events[c] = { ch: c, event: 'off' };
        const triggered = new Set();

        // 1) 指定延迟处触发新音，相位置 0，替换前音但保留滑音记忆
        for (const entry of rowVoices) {
          const delay = entry.delay || 0;
          if (entry.note && delay === t) {
            const v = voices[entry.ch];
            v.active = true;
            v.sample = entry.note[0];
            v.phase = 0;
            v.step = entry.note[1];
            v.loop = samples[v.sample].loop;
            events[entry.ch].event = 'note';
            triggered.add(entry.ch);
          }
        }

        // 2) 未触发新音的声部按规则重触发（仍在响才重置相位）
        for (const entry of rowVoices) {
          if (triggered.has(entry.ch)) continue;
          if (entry.retrig !== undefined && t >= 1 && t % entry.retrig === 0) {
            const v = voices[entry.ch];
            if (v.active) {
              v.phase = 0;
              events[entry.ch].event = 'retrig';
            }
          }
        }

        // 3) 编号大于零的 tick：仍在响且本行有 slide 的声部加滑音量，步长夹取
        if (t > 0) {
          for (const entry of rowVoices) {
            if (entry.slide !== undefined) {
              const v = voices[entry.ch];
              if (v.active) v.step = clampStep(v.step + v.slideMem);
            }
          }
        }

        // 调度后、首帧前的声部快照
        for (let c = 0; c < channels; c++) {
          const v = voices[c];
          const ev = events[c];
          if (v.active && ev.event === 'off') ev.event = 'none';
          ev.sample = v.active ? v.sample : null;
          ev.phase = v.phase;
          ev.step = v.active ? v.step : 0;
        }

        // tick 的半开采样区间：精确累计起点/终点分别向下取整
        const startFrame = Number(accN / accD);
        const bpmB = BigInt(bpm);
        const n2 = accN * bpmB + P_BI * accD;
        const d2 = accD * bpmB;
        const g = bgcd(n2, d2);
        accN = n2 / g;
        accD = d2 / g;
        const endFrame = Number(accN / accD);
        if (endFrame > MAX_FRAMES) {
          runtimeFail(`向下取整后总长 ${endFrame} 帧超过 ${MAX_FRAMES}（180 秒）上限`, {
            limit: 'frames',
          });
        }

        // 渲染本 tick 各声部（相位随渲染推进）
        for (let c = 0; c < channels; c++) {
          if (voices[c].active) renderVoice(voices[c], startFrame, endFrame, samples, mix);
        }

        log.push({
          tick: tickIndex,
          pos: posIdx,
          pattern: patternIdx,
          row: rowIdx,
          rowTick: t,
          startFrame,
          endFrame,
          bpm,
          speed,
          events,
        });
        tickIndex++;
      }

      // 行末跳转：回跳优先，其次 break，否则顺序前进
      if (row.back) {
        const [target, extra] = row.back;
        const key = rowIdx;
        let remaining = backMaps[posIdx].has(key)
          ? backMaps[posIdx].get(key)
          : extra + 1; // 首次遇到：额外次数 + 当前这次
        if (remaining > 0) {
          remaining -= 1;
          backMaps[posIdx].set(key, remaining);
          jump = { type: 'back', toPos: posIdx, toRow: target, remaining };
          rowIdx = target;
        }
      }

      if (!jump && row.break !== undefined) {
        if (posIdx + 1 < order.length) {
          const nextPattern = patterns[order[posIdx + 1]];
          if (row.break >= nextPattern.length) {
            runtimeFail(`break=${row.break} 越界：下一编排位置的花样只有 ${nextPattern.length} 行`, {
              limit: 'illegal-edit', field: 'break',
            });
          }
          jump = { type: 'break', toPos: posIdx + 1, toRow: row.break, remaining: null };
          posIdx += 1;
          rowIdx = row.break;
        } else {
          jump = { type: 'end', toPos: null, toRow: null, remaining: null };
        }
      }

      if (!jump) {
        if (rowIdx + 1 < pattern.length) {
          jump = { type: 'next-row', toPos: posIdx, toRow: rowIdx + 1, remaining: null };
          rowIdx += 1;
        } else if (posIdx + 1 < order.length) {
          jump = { type: 'pattern-end', toPos: posIdx + 1, toRow: 0, remaining: null };
          posIdx += 1;
          rowIdx = 0;
        } else {
          jump = { type: 'end', toPos: null, toRow: null, remaining: null };
        }
      }

      log[log.length - 1].jump = jump;
      if (jump.type === 'end') break outer;
    }

    const totalFrames = Number(accN / accD);
    const pcm = mix.finish(totalFrames);

    return {
      pcm,
      log,
      totalFrames,
      totalTicks: tickIndex,
      sampleRate: SR,
      meta: {
        channels: song.channels,
        bpm: song.bpm,
        speed: song.speed,
        samples: song.samples.length,
        patterns: song.patterns.length,
        order: song.order.length,
      },
    };
  }

  /* ---------------- 调度日志文本（支持区间过滤，保留绝对 tick/帧） ---------------- */

  function formatLog(result, start, end) {
    const a = Math.max(0, start | 0);
    const b = Math.min(result.totalFrames, end | 0);
    const lines = [];
    lines.push('# 采样格谱调度日志');
    lines.push(`# 声道=${result.meta.channels} 初始BPM=${result.meta.bpm} 初始speed=${result.meta.speed} ` +
      `采样=${result.meta.samples} 花样=${result.meta.patterns} 编排位置=${result.meta.order}`);
    lines.push(`# 总 tick=${result.totalTicks} 总帧=${result.totalFrames} 采样率=${result.sampleRate}`);
    lines.push(`# 所选半开区间=[${a},${b}) 时长=${((b - a) / SR).toFixed(6)}s`);
    lines.push('');
    for (const tk of result.log) {
      if (tk.endFrame <= a || tk.startFrame >= b) continue;
      lines.push(
        `tick=${tk.tick} 位置=${tk.pos} 花样=${tk.pattern} 行=${tk.row} 行内tick=${tk.rowTick} ` +
        `帧=[${tk.startFrame},${tk.endFrame}) bpm=${tk.bpm} speed=${tk.speed}`
      );
      for (const ev of tk.events) {
        if (ev.event === 'off') {
          lines.push(`  ch${ev.ch}: 未发声`);
        } else {
          const tag = ev.event === 'note' ? '新音' : ev.event === 'retrig' ? '重触发' : '无触发';
          lines.push(
            `  ch${ev.ch}: ${tag} 采样=${ev.sample} 相位=${ev.phase}(${(ev.phase / Q).toFixed(4)}) ` +
            `步长=${ev.step}(${(ev.step / Q).toFixed(4)})`
          );
        }
      }
      if (tk.jump) {
        const j = tk.jump;
        if (j.type === 'end') {
          lines.push('  行末: 结束');
        } else {
          const rem = j.type === 'back' ? ` 剩余回跳=${j.remaining}` : '';
          lines.push(`  行末: ${j.type} -> 位置=${j.toPos} 行=${j.toRow}${rem}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  const api = {
    SR,
    Q,
    MAX_TICKS,
    MAX_FRAMES,
    LIMITS,
    TrackerError,
    validateSong,
    renderSong,
    formatLog,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TrackerEngine = api;
})(typeof self !== 'undefined' ? self : globalThis);
