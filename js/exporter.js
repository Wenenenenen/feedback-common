// exporter.js — 导出当前区间与列统计
// 平方和一律十进制字符串（BigInt → string），空列 min/max 为 null、count=0、sumSq="0"。

import { SAMPLE_RATE } from './wav.js';

export function timecode(frame) {
  if (frame < 0) frame = 0;
  const totalMs = Math.floor((frame * 1000) / SAMPLE_RATE);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(ms).padStart(3, '0')}`;
}

function statToJSON(st) {
  if (st === null) return { min: null, max: null, count: 0, sumSq: '0' };
  return { min: st.min, max: st.max, count: st.count, sumSq: st.sumSq.toString() };
}

/**
 * @param {import('./timeline.js').Timeline} timeline
 * @param {{start:number, end:number}} interval 当前区间（拼接轨帧坐标）
 * @param {Array} columns timeline.columnStats 的结果
 * @param {number} B
 */
export function buildExport(timeline, interval, columns, B) {
  const range = timeline.rangeStats(interval.start, interval.end);
  return {
    format: 'waveform-edit-pyramid/1',
    sampleRate: SAMPLE_RATE,
    channels: 2,
    interval: {
      startFrame: interval.start,
      endFrame: interval.end,
      frameCount: interval.end - interval.start,
      startTimecode: timecode(interval.start),
      endTimecode: timecode(interval.end),
    },
    columns: {
      B,
      n: interval.end - interval.start,
      boundaryRule: 'col j = [start + floor(j*n/B), start + floor((j+1)*n/B))',
      list: columns.map((c, j) => ({
        index: j,
        startFrame: c.start,
        endFrame: c.end,
        frameCount: c.end - c.start,
        left: statToJSON(c.stats[0]),
        right: statToJSON(c.stats[1]),
      })),
    },
    intervalAggregate: {
      left: statToJSON(range[0]),
      right: statToJSON(range[1]),
    },
    segments: timeline.segments.map((s, i) => ({
      index: i,
      sourceId: s.sourceId,
      sourceName: timeline.sources.get(s.sourceId).name,
      srcStart: s.srcStart,
      srcEnd: s.srcEnd,
      reverse: s.reverse,
      muted: s.muted,
      timelineStart: timeline.offsets[i],
      timelineEnd: timeline.offsets[i] + (s.srcEnd - s.srcStart),
    })),
  };
}

function csvCell(v) {
  const t = String(v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function columnsCSV(exportObj) {
  const rows = [['column', 'startFrame', 'endFrame', 'frameCount',
    'leftMin', 'leftMax', 'leftCount', 'leftSumSq',
    'rightMin', 'rightMax', 'rightCount', 'rightSumSq']];
  for (const c of exportObj.columns.list) {
    rows.push([c.index, c.startFrame, c.endFrame, c.frameCount,
      c.left.min ?? '', c.left.max ?? '', c.left.count, c.left.sumSq,
      c.right.min ?? '', c.right.max ?? '', c.right.count, c.right.sumSq]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
