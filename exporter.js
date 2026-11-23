/*
 * 波形导出器：VCD（IEEE 1364 四值）与自描述 JSON。
 * 只导出实际变值波形；VCD 总线整体为四值字符串，X/Z 逐位保留。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FactoryBusExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // VCD 标识符：可打印 ASCII 33..126 共 94 个字符的短码
  const VCD_CHARS = String.fromCharCode(...Array.from({ length: 94 }, (_, i) => i + 33));
  function vcdId(i) {
    let s = '';
    do { s = VCD_CHARS[i % VCD_CHARS.length] + s; i = Math.floor(i / VCD_CHARS.length) - 1; } while (i >= 0);
    return s;
  }

  function vcdValue(lo, hi, width) {
    // 复用四值编码：Z=00 X=01 0=10 1=11
    const chars = [ 'z', 'x', '0', '1' ];
    let out = '';
    for (let bit = width - 1; bit >= 0; bit--) {
      const v = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
      out += chars[v];
    }
    return out;
  }

  /** 导出 VCD 文本。result 为 engine.run 的成功返回。 */
  function exportVcd(result, meta = {}) {
    const lines = [];
    lines.push('$date');
    lines.push('    ' + new Date().toISOString());
    lines.push('$end');
    lines.push('$version factory-bus-timing export $end');
    lines.push('$comment ' + (meta.comment || '实际变值波形，四值 0/1/x/z') + ' $end');
    lines.push('$timescale 1tick $end');
    lines.push('$scope module factory $end');

    const ids = result.wave.map((wf, i) => vcdId(i));
    result.wave.forEach((wf, i) => {
      if (wf.width === 1) lines.push(`$var wire 1 ${ids[i]} ${wf.name} $end`);
      else lines.push(`$var wire ${wf.width} ${ids[i]} ${wf.name}[${wf.width - 1}:0] $end`);
    });
    lines.push('$upscope $end');
    lines.push('$enddefinitions $end');
    lines.push('$dumpvars');

    // 初态（t=0）
    result.wave.forEach((wf, i) => {
      const v = vcdValue(wf.lo[0], wf.hi[0], wf.width);
      lines.push(wf.width === 1 ? `${v}${ids[i]}` : `b${v} ${ids[i]}`);
    });
    lines.push('$end');

    // 合并所有变值时刻
    const allTimes = new Set();
    for (const wf of result.wave) for (let k = 1; k < wf.times.length; k++) allTimes.add(wf.times[k]);
    const times = [ ...allTimes ].sort((a, b) => a - b);
    for (const t of times) {
      lines.push(`#${t}`);
      for (let i = 0; i < result.wave.length; i++) {
        const wf = result.wave[i];
        // 二分定位该时刻是否有记录
        let lo = 0, hi = wf.times.length - 1, found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (wf.times[mid] === t) { found = mid; break; }
          if (wf.times[mid] < t) lo = mid + 1; else hi = mid - 1;
        }
        if (found < 0) continue;
        const v = vcdValue(wf.lo[found], wf.hi[found], wf.width);
        lines.push(wf.width === 1 ? `${v}${ids[i]}` : `b${v} ${ids[i]}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /** 导出自描述 JSON：每条线网只含实际变值（含 t=0 初态）。 */
  function exportJson(result, meta = {}) {
    const four = [ 'Z', 'X', '0', '1' ];
    const data = {
      format: 'factory-bus-wave-v1',
      exportedAt: new Date().toISOString(),
      until: result.until,
      comment: meta.comment || '实际变值波形（仅含发生变化的时刻）',
      nets: result.wave.map(wf => ({
        name: wf.name,
        width: wf.width,
        changes: wf.times.map((t, k) => {
          let value = '';
          for (let bit = wf.width - 1; bit >= 0; bit--) {
            value += four[(((wf.hi[k] >> bit) & 1) << 1) | ((wf.lo[k] >> bit) & 1)];
          }
          return { t, value };
        }),
      })),
    };
    return JSON.stringify(data);
  }

  return { exportVcd, exportJson };
});
