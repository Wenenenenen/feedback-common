/*
 * midi-reel.js — 多轨 MIDI 片段重排核心
 *
 * 与 samples/midi-reel-cases.zip 内「约定.txt」一致：
 *   - note-on / note-off 按（轨、通道、键号）FIFO 配对；零力度 note-on 视为 note-off
 *   - 片段是源 tick 的左闭右开区间 [start, end)；音符按交集裁切，并在边界补合成起止事件
 *   - 导出时同一轨、同一 tick 的 note-off 排在 note-on 之前（先关后开）
 *   - 片段开头的 tempo 取起点正在生效的值；没有任何设定时为 500000 微秒/四分音符
 *   - 时间按 tempo 分段累计，分子始终是「微秒 × PPQ」的整数；到最后一步才向下取整到微秒
 *   - 只跟踪音符与 tempo，其余事件按合法结构跳过；导出保留源力度与 PPQ
 *
 * 浏览器中挂在 window.MidiReel；Node 中通过 module.exports 导出。
 * 无第三方依赖；精确时间用 BigInt。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MidiReel = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_TEMPO = 500000; // 微秒 / 四分音符
  const MAX_TRACKS = 16;
  const MAX_EVENTS = 20000;
  const MAX_CLIPS = 4096;
  const MAX_TICK = 0x0fffffff; // 标准 MIDI 变长数值能表示的最大 tick

  class MidiReelError extends Error {
    constructor(message) {
      super(message);
      this.name = 'MidiReelError';
    }
  }

  const fail = (message) => {
    throw new MidiReelError(message);
  };

  /* ------------------------------------------------------------------ *
   * 二进制读取
   * ------------------------------------------------------------------ */

  function readU16(b, p) {
    return (b[p] << 8) | b[p + 1];
  }

  function readU32(b, p) {
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  }

  function readAscii(b, p, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + i]);
    return s;
  }

  /** 读标准 MIDI 变长数值（最多 4 字节）。返回 null 表示在 end 之前没有读完整。 */
  function readVlq(bytes, pos, end) {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      if (pos >= end) return null;
      const b = bytes[pos++];
      value = (value << 7) | (b & 0x7f);
      if (!(b & 0x80)) return { value, pos };
    }
    return null;
  }

  function writeVlq(out, value) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_TICK) {
      throw new MidiReelError('无法写入变长数值: ' + value);
    }
    const stack = [value & 0x7f];
    value = Math.floor(value / 128);
    while (value > 0) {
      stack.push(0x80 | (value & 0x7f));
      value = Math.floor(value / 128);
    }
    for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]);
  }

  /* ------------------------------------------------------------------ *
   * 解析
   * ------------------------------------------------------------------ */

  function parseMidi(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const len = bytes.length;
    const warnings = [];

    if (len < 14 || readAscii(bytes, 0, 4) !== 'MThd') {
      fail('不是标准 MIDI 文件（缺少 MThd 头）');
    }
    const headerLen = readU32(bytes, 4);
    if (headerLen < 6) fail('MThd 头长度非法');
    if (8 + headerLen > len) fail('MThd 头之后文件被截断');

    const format = readU16(bytes, 8);
    const trackCount = readU16(bytes, 10);
    const division = readU16(bytes, 12);

    if (format !== 0 && format !== 1) fail(`只支持 0 型或 1 型 MIDI，当前文件是 ${format} 型`);
    if (division & 0x8000) fail('不支持 SMPTE 计时，只支持 PPQ 计时');
    if (division === 0) fail('PPQ 不能为 0');
    if (trackCount === 0) fail('文件里没有轨道');
    if (trackCount > MAX_TRACKS) fail(`轨道数 ${trackCount} 超过上限 ${MAX_TRACKS}`);

    let pos = 8 + headerLen;
    const tracks = [];
    let eventTotal = 0;
    const count = () => {
      eventTotal++;
      if (eventTotal > MAX_EVENTS) fail(`事件总数超过上限 ${MAX_EVENTS}`);
    };

    for (let ti = 0; ti < trackCount; ti++) {
      if (pos + 8 > len || readAscii(bytes, pos, 4) !== 'MTrk') {
        warnings.push(`轨道 ${ti + 1}: 找不到 MTrk 块，文件可能被截断，后续轨道已忽略`);
        break;
      }
      const declared = readU32(bytes, pos + 4);
      const dataStart = pos + 8;
      const declaredEnd = dataStart + declared;
      const dataEnd = Math.min(declaredEnd, len);
      if (declaredEnd > len) {
        warnings.push(`轨道 ${ti + 1}: 声明长度 ${declared} 字节超出文件末尾，按截断处理，保留已解析事件`);
      }
      const track = parseTrack(bytes, dataStart, dataEnd, ti, warnings, count);
      tracks.push(track);
      pos = declaredEnd;
    }

    if (tracks.length === 0) fail('没有解析到任何轨道');

    const notes = [];
    for (const track of tracks) track.notes = [];
    pairNotes(tracks, notes, warnings);

    const tempos = [];
    tracks.forEach((track, ti) => {
      for (const ev of track.events) {
        if (ev.type === 'tempo') tempos.push({ tick: ev.tick, tempo: ev.tempo, track: ti });
      }
    });
    tempos.sort((a, b) => a.tick - b.tick);

    let lengthTicks = 0;
    for (const track of tracks) lengthTicks = Math.max(lengthTicks, track.endTick);
    for (const note of notes) lengthTicks = Math.max(lengthTicks, note.end);
    for (const t of tempos) lengthTicks = Math.max(lengthTicks, t.tick);

    return {
      format,
      ppq: division,
      tracks,
      notes,
      tempos,
      warnings,
      lengthTicks,
      eventCount: eventTotal,
    };
  }

  function parseTrack(bytes, start, end, trackIndex, warnings, count) {
    const events = [];
    let pos = start;
    let tick = 0;
    let running = 0;
    let endTick = 0;
    let name = '';

    const warn = (msg) => warnings.push(`轨道 ${trackIndex + 1}: ${msg}`);

    while (pos < end) {
      const d = readVlq(bytes, pos, end);
      if (d === null) {
        warn(`tick ${tick} 处的 delta 时间不完整，停止解析该轨`);
        break;
      }
      pos = d.pos;
      tick += d.value;
      if (tick > MAX_TICK) {
        warn('时间超过标准 MIDI 上限，停止解析该轨');
        break;
      }
      if (pos >= end) {
        warn(`tick ${tick} 处的事件被截断，停止解析该轨`);
        break;
      }

      let status = bytes[pos];
      if (status < 0x80) {
        if (!running) {
          warn(`tick ${tick} 处出现无运行状态的数据字节，停止解析该轨`);
          break;
        }
        status = running;
      } else {
        pos++;
        if (status < 0xf0) running = status;
      }

      endTick = Math.max(endTick, tick);

      if (status === 0xff) {
        // 规范：meta / SysEx 事件会取消运行状态
        running = 0;
        if (pos >= end) {
          warn(`tick ${tick} 处的 meta 事件被截断`);
          break;
        }
        const type = bytes[pos++];
        const lf = readVlq(bytes, pos, end);
        if (lf === null || lf.pos + lf.value > end) {
          warn(`tick ${tick} 处的 meta 事件长度越界，停止解析该轨`);
          break;
        }
        pos = lf.pos;
        const size = lf.value;
        if (type === 0x2f) {
          // End of Track：结构终止符，不计入事件上限；轨道长度以它为准
          pos = lf.pos + size;
          return { index: trackIndex, events, endTick: tick, name, hasEot: true };
        }
        count();
        if (type === 0x51 && size === 3) {
          const tempo = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
          if (tempo > 0) events.push({ tick, type: 'tempo', tempo });
          else warn(`tick ${tick} 处 tempo 为 0，已忽略`);
        } else if (type === 0x03 && size > 0 && !name) {
          name = decodeText(bytes.subarray(pos, pos + size));
        }
        pos += size;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        running = 0;
        const lf = readVlq(bytes, pos, end);
        if (lf === null || lf.pos + lf.value > end) {
          warn(`tick ${tick} 处的 SysEx 事件长度越界，停止解析该轨`);
          break;
        }
        count();
        pos = lf.pos + lf.value;
        continue;
      }

      const hi = status & 0xf0;
      if (hi < 0x80 || hi > 0xe0) {
        warn(`tick ${tick} 处出现无法识别的状态字节 0x${status.toString(16)}，停止解析该轨`);
        break;
      }
      const need = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
      if (pos + need > end) {
        warn(`tick ${tick} 处的通道事件被截断，停止解析该轨`);
        break;
      }
      count();
      const d1 = bytes[pos];
      const d2 = need === 2 ? bytes[pos + 1] : 0;
      pos += need;

      const channel = status & 0x0f;
      if (hi === 0x90) {
        if (d2 === 0) events.push({ tick, type: 'off', channel, key: d1 });
        else events.push({ tick, type: 'on', channel, key: d1, vel: d2 });
      } else if (hi === 0x80) {
        events.push({ tick, type: 'off', channel, key: d1 });
      }
    }

    return { index: trackIndex, events, endTick, name, hasEot: false };
  }

  function decodeText(bytes) {
    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (e) {
      for (const b of bytes) text += String.fromCharCode(b);
    }
    return text.replace(/\u0000/g, '').trim();
  }

  /**
   * 按（轨、通道、键号）FIFO 配对 note-on/off。
   * 未被关闭的 note-on 在轨道末尾补一个 note-off，并给出警告。
   */
  function pairNotes(tracks, notes, warnings) {
    tracks.forEach((track, ti) => {
      const open = new Map(); // channel * 128 + key -> [{tick, vel}, ...]
      for (const ev of track.events) {
        const slot = ev.channel * 128 + ev.key;
        if (ev.type === 'on') {
          if (!open.has(slot)) open.set(slot, []);
          open.get(slot).push({ tick: ev.tick, vel: ev.vel });
        } else if (ev.type === 'off') {
          const queue = open.get(slot);
          if (!queue || queue.length === 0) {
            warnings.push(`轨道 ${ti + 1}: tick ${ev.tick} 处键 ${ev.key} 的 note-off 没有可配对的 note-on，已忽略`);
            continue;
          }
          const on = queue.shift();
          const note = { track: ti, channel: ev.channel, key: ev.key, start: on.tick, end: ev.tick, vel: on.vel };
          notes.push(note);
          track.notes.push(note);
        }
      }
      for (const [slot, queue] of open) {
        for (const on of queue) {
          const channel = Math.floor(slot / 128);
          const key = slot % 128;
          if (track.endTick > on.tick) {
            warnings.push(`轨道 ${ti + 1}: 键 ${key} 在 tick ${on.tick} 的 note-on 没有关闭，已在轨道末尾 tick ${track.endTick} 补 note-off`);
            const note = { track: ti, channel, key, start: on.tick, end: track.endTick, vel: on.vel };
            notes.push(note);
            track.notes.push(note);
          } else {
            warnings.push(`轨道 ${ti + 1}: 键 ${key} 在 tick ${on.tick} 的 note-on 没有关闭，也不在轨道时间范围内，已忽略`);
          }
        }
      }
    });

    notes.sort((a, b) => a.start - b.start || a.track - b.track || a.key - b.key || a.end - b.end);
    for (const track of tracks) {
      track.notes.sort((a, b) => a.start - b.start || a.key - b.key || a.end - b.end);
    }
  }

  /* ------------------------------------------------------------------ *
   * 时间
   * ------------------------------------------------------------------ */

  /** tick 时刻正在生效的 tempo：最后一个 tick ≤ 目标的设定，没有则为 500000。 */
  function tempoAt(tempos, tick) {
    let lo = 0;
    let hi = tempos.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tempos[mid].tick <= tick) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 ? tempos[found].tempo : DEFAULT_TEMPO;
  }

  /**
   * 从 0 累计到 tick 的精确时长。
   * @returns {{ num: bigint, den: number, exact: string, us: number }}
   *   num / den 是微秒的精确分数；us 是最后一步向下取整的结果。
   */
  function timeAt(tempos, ppq, tick) {
    let num = 0n;
    let cursor = 0;
    let tempo = DEFAULT_TEMPO;
    for (const t of tempos) {
      if (t.tick > tick) break;
      if (t.tick > cursor) {
        num += BigInt(t.tick - cursor) * BigInt(tempo);
        cursor = t.tick;
      }
      tempo = t.tempo;
    }
    if (tick > cursor) num += BigInt(tick - cursor) * BigInt(tempo);
    return {
      num,
      den: ppq,
      exact: `${num}/${ppq}`,
      us: floorDiv(num, ppq),
    };
  }

  function floorDiv(num, den) {
    return Number(num / BigInt(den));
  }

  /* ------------------------------------------------------------------ *
   * 重排
   * ------------------------------------------------------------------ */

  function normalizeClips(clips) {
    if (!Array.isArray(clips)) fail('剪辑单必须是片段数组');
    if (clips.length > MAX_CLIPS) fail(`片段数 ${clips.length} 超过上限 ${MAX_CLIPS}`);
    return clips.map((clip, i) => {
      const start = clip && clip.start;
      const end = clip && clip.end;
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        fail(`片段 ${i + 1}: start / end 必须是整数 tick（读到 ${JSON.stringify(start)} 与 ${JSON.stringify(end)}）`);
      }
      if (start < 0) fail(`片段 ${i + 1}: start 不能为负（读到 ${start}）`);
      if (end <= start) fail(`片段 ${i + 1}: 需要 start < end 的半开区间，读到 [${start}, ${end})`);
      if (end > MAX_TICK) fail(`片段 ${i + 1}: end 超过可表示的 tick 上限 ${MAX_TICK}`);
      return { start, end };
    });
  }

  /**
   * 按剪辑单重排。
   * @param song parseMidi 的结果
   * @param clips [{ start, end }] 源 tick 半开区间
   */
  function arrange(song, clips) {
    const list = normalizeClips(clips);
    const ppq = song.ppq;
    const outTracks = song.tracks.map(() => []);
    const tempoEvents = [];
    const manifestClips = [];

    let offset = 0;
    let cumNum = 0n;

    const pushTempo = (tick, tempo) => {
      const last = tempoEvents[tempoEvents.length - 1];
      if (last && last.tick === tick) {
        if (last.tempo !== tempo) last.tempo = tempo; // 同一 tick 后写覆盖先写
        return;
      }
      if (last && last.tempo === tempo) return; // 连续相同值不重复写
      tempoEvents.push({ tick, tempo });
    };

    list.forEach((clip, i) => {
      const { start, end } = clip;
      const duration = end - start;
      if (offset + duration > MAX_TICK) {
        fail(`片段 ${i + 1}: 输出长度超过可表示的 tick 上限 ${MAX_TICK}`);
      }

      // 速度表：片段开头继承起点生效值；片段内部的变化平移到输出轴
      const startTempo = tempoAt(song.tempos, start);
      pushTempo(offset, startTempo);
      for (const t of song.tempos) {
        if (t.tick > start && t.tick < end) pushTempo(offset + t.tick - start, t.tempo);
      }

      // 音符：与 [start, end) 求交集，平移到输出轴
      let clipped = 0;
      for (let ti = 0; ti < song.tracks.length; ti++) {
        for (const note of song.tracks[ti].notes) {
          if (note.start >= end) break;
          if (note.end <= start) continue;
          const s = Math.max(note.start, start);
          const e = Math.min(note.end, end);
          if (s >= e) continue;
          const clippedStart = s > note.start;
          const clippedEnd = e < note.end;
          if (clippedStart || clippedEnd) clipped++;
          outTracks[ti].push({
            key: note.key,
            channel: note.channel,
            vel: note.vel,
            start: s - start + offset,
            end: e - start + offset,
            sourceStart: s,
            sourceEnd: e,
            clippedStart,
            clippedEnd,
          });
        }
      }

      // 精确时长：按 tempo 分段累计（分子 / PPQ），到这里仍不取整
      const before = cumNum;
      let cursor = start;
      let tempo = startTempo;
      for (const t of song.tempos) {
        if (t.tick <= start) continue;
        if (t.tick >= end) break;
        cumNum += BigInt(t.tick - cursor) * BigInt(tempo);
        cursor = t.tick;
        tempo = t.tempo;
      }
      cumNum += BigInt(end - cursor) * BigInt(tempo);
      const clipNum = cumNum - before;

      manifestClips.push({
        index: i + 1,
        sourceStart: start,
        sourceEnd: end,
        outputTick: offset,
        ticks: duration,
        tempo: startTempo,
        clippedNotes: clipped,
        clipUs: floorDiv(clipNum, ppq),
        clipExact: `${clipNum}/${ppq}`,
        cumulativeUs: floorDiv(cumNum, ppq),
        cumulativeExact: `${cumNum}/${ppq}`,
      });

      offset += duration;
    });

    for (const list2 of outTracks) list2.sort((a, b) => a.start - b.start || a.key - b.key || a.end - b.end);

    const totalUs = floorDiv(cumNum, ppq);
    return {
      ppq,
      totalTicks: offset,
      tracks: outTracks,
      tempoEvents,
      totalUs,
      totalExact: `${cumNum}/${ppq}`,
      manifest: {
        ppq,
        totalTicks: offset,
        totalUs,
        totalExact: `${cumNum}/${ppq}`,
        clips: manifestClips,
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  function encodeTrack(events, endTick) {
    events.sort((a, b) => {
      if (a.tick !== b.tick) return a.tick - b.tick;
      if (a.order !== b.order) return a.order - b.order; // -1 = 轨道名，0 = note-off，1 = note-on，2 = 速度
      if (a.order === 1) {
        if (a.end !== b.end) return a.end - b.end; // 同刻先后开始的同键音：先结束的先开，FIFO 才能配回
      } else if (a.start !== b.start) {
        return a.start - b.start;
      }
      if (a.key !== b.key) return a.key - b.key;
      if (a.channel !== b.channel) return a.channel - b.channel;
      return 0;
    });

    const bytes = [];
    let last = 0;
    for (const ev of events) {
      writeVlq(bytes, ev.tick - last);
      last = ev.tick;
      for (const b of ev.bytes) bytes.push(b);
    }
    // 轨道结束事件放在 arr.totalTicks：片段尾部的休止也留在文件里
    if (endTick < last) throw new MidiReelError('内部错误：轨道结束 tick 早于最后一个事件');
    writeVlq(bytes, endTick - last);
    bytes.push(0xff, 0x2f, 0x00);
    return bytes;
  }

  /**
   * 导出 1 型 MIDI：第 0 轨是速度表，之后每个有音符的源轨道一轨。
   * 保留源通道、力度与 PPQ；所有轨道的 End of Track 都落在总长度上。
   */
  function exportMidi(song, arr) {
    const ppq = arr.ppq;

    const chunks = [];

    // 速度表轨
    {
      const events = arr.tempoEvents.map((t) => ({
        tick: t.tick,
        order: 2,
        key: 0,
        channel: 0,
        start: 0,
        end: 0,
        bytes: [0xff, 0x51, 0x03, (t.tempo >> 16) & 0xff, (t.tempo >> 8) & 0xff, t.tempo & 0xff],
      }));
      chunks.push(encodeTrack(events, arr.totalTicks));
    }

    song.tracks.forEach((track, ti) => {
      const out = arr.tracks[ti];
      const hadNotes = track.notes.length > 0;
      if (!hadNotes) return; // 纯 tempo / 元信息轨不重复导出
      const events = [];
      if (track.name) {
        const nameBytes = encodeText(track.name);
        events.push({
          tick: 0, order: -1, key: 0, channel: 0, start: 0, end: 0,
          bytes: [0xff, 0x03, ...vlqBytes(nameBytes.length), ...nameBytes],
        });
      }
      for (const note of out) {
        const ch = note.channel & 0x0f;
        events.push({
          tick: note.start, order: 1, key: note.key, channel: ch, start: note.start, end: note.end,
          bytes: [0x90 | ch, note.key, note.vel],
        });
        events.push({
          tick: note.end, order: 0, key: note.key, channel: ch, start: note.start, end: note.end,
          bytes: [0x80 | ch, note.key, 0],
        });
      }
      chunks.push(encodeTrack(events, arr.totalTicks));
    });

    const out = [];
    const pushAscii = (s) => { for (const c of s) out.push(c.charCodeAt(0)); };
    const push32 = (v) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    const push16 = (v) => out.push((v >>> 8) & 0xff, v & 0xff);

    pushAscii('MThd');
    push32(6);
    push16(1); // 1 型
    push16(chunks.length);
    push16(ppq);
    for (const chunk of chunks) {
      pushAscii('MTrk');
      push32(chunk.length);
      for (const b of chunk) out.push(b);
    }
    return new Uint8Array(out);
  }

  function encodeText(text) {
    const bytes = [];
    if (typeof TextEncoder !== 'undefined') {
      for (const b of new TextEncoder().encode(text)) bytes.push(b);
    } else {
      for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return bytes;
  }

  function vlqBytes(value) {
    const bytes = [];
    writeVlq(bytes, value);
    return bytes;
  }

  function buildManifest(song, arr) {
    return {
      ppq: arr.ppq,
      totalTicks: arr.totalTicks,
      totalUs: arr.manifest.totalUs,
      totalExact: arr.manifest.totalExact,
      clips: arr.manifest.clips.map((c) => ({ ...c })),
    };
  }

  return {
    DEFAULT_TEMPO,
    MAX_TRACKS,
    MAX_EVENTS,
    MAX_CLIPS,
    MAX_TICK,
    MidiReelError,
    parseMidi,
    tempoAt,
    timeAt,
    arrange,
    exportMidi,
    buildManifest,
  };
});
