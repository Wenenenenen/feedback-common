/*
 * JPEG 基线解码器（纯手写，不借助任何图片解码库 / 浏览器解码能力）
 *
 * 支持范围（与 samples 包内约定一致）：
 *   - 8 位基线顺序 DCT、Huffman 编码（SOF0）
 *   - 灰度单分量，或 JFIF YCbCr 三分量 4:4:4 / 4:2:2 / 4:2:0
 *   - 单扫描、三分量扫描交错；量化表仅 8 位
 *   - DQT / DHT / DRI / RST0-7 / 熵段 FF00 填充 / APPn / COM
 *   - 边长 1..1024
 *
 * 输出：标记字节范围、MCU/块结构、量化系数、反量化结果、
 *       DC 预测器轨迹、分量平面与 RGB 位图。
 * 损坏输入抛出 JpegError { offset, message }，不交付部分结果。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JpegDecoder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  //  zigzag 序号 -> 自然（行优先）序号
  const ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
  ];

  // IDCT 余弦表与正交归一系数
  const COS = new Float64Array(64);
  for (let u = 0; u < 8; u++)
    for (let x = 0; x < 8; x++)
      COS[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  const CORTH = new Float64Array(8);
  CORTH[0] = 1 / Math.SQRT2;
  for (let i = 1; i < 8; i++) CORTH[i] = 1;

  class JpegError extends Error {
    constructor(offset, message) {
      super(message);
      this.name = 'JpegError';
      this.offset = offset; // 字节偏移（十进制）
    }
  }

  const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');

  const MARKER_NAMES = {
    0xD8: 'SOI', 0xD9: 'EOI', 0xC0: 'SOF0', 0xC1: 'SOF1', 0xC2: 'SOF2',
    0xC3: 'SOF3', 0xC5: 'SOF5', 0xC6: 'SOF6', 0xC7: 'SOF7', 0xC9: 'SOF9',
    0xCA: 'SOF10', 0xCB: 'SOF11', 0xCD: 'SOF13', 0xCE: 'SOF14', 0xCF: 'SOF15',
    0xC4: 'DHT', 0xCC: 'DAC', 0xDB: 'DQT', 0xDD: 'DRI', 0xDA: 'SOS',
    0xFE: 'COM', 0x01: 'TEM',
  };
  const SOF_REASONS = {
    0xC1: '扩展顺序 DCT（非基线）不支持',
    0xC2: '渐进式 DCT（SOF2）不支持，仅支持基线顺序 DCT',
    0xC3: '无损（差分）编码不支持',
    0xC9: '算术编码（SOF9）不支持，仅支持 Huffman',
    0xCA: '渐进算术编码不支持',
    0xC5: '分层渐进（SOF5）不支持',
    0xC6: '差分无损（SOF6）不支持',
    0xC7: '差分无损（SOF7）不支持',
    0xCB: '无损算术（SOF11）不支持',
    0xCD: '差分算术（SOF13）不支持',
    0xCE: '差分算术（SOF14）不支持',
    0xCF: '差分算术（SOF15）不支持',
  };

  function markerName(code) {
    if (code >= 0xE0 && code <= 0xEF) return 'APP' + (code - 0xE0);
    if (code >= 0xD0 && code <= 0xD7) return 'RST' + (code - 0xD0);
    return MARKER_NAMES[code] || 'FF' + hex(code);
  }

  // ---------------------------------------------------------------- Huffman

  function buildHuffmanTable(counts, symbols) {
    // counts: 长度 1..16 的码字个数；symbols: 按码字顺序的符号表
    const mincode = new Int32Array(17);
    const maxcode = new Int32Array(17).fill(-1);
    const valptr = new Int32Array(17);
    let code = 0, k = 0;
    for (let l = 1; l <= 16; l++) {
      const n = counts[l - 1];
      if (n > 0) {
        mincode[l] = code;
        valptr[l] = k;
        code += n;
        k += n;
        maxcode[l] = code - 1;
      }
      code <<= 1;
    }
    return { mincode, maxcode, valptr, symbols };
  }

  // ---------------------------------------------------------------- 主解码

  function decode(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const len = bytes.length;
    const markers = [];

    if (len < 2 || bytes[0] !== 0xFF || bytes[1] !== 0xD8)
      throw new JpegError(0, '缺少 SOI 标记（文件应以 FFD8 开头）');
    markers.push({ offset: 0, end: 2, code: 0xD8, name: 'SOI', summary: '图像开始' });

    const qtables = {};   // id -> Int32Array(64) 自然序
    const dcTables = {}, acTables = {};
    let frame = null;     // SOF0 信息
    let restartInterval = 0;
    let scanDone = false;
    let pos = 2;

    const mcus = [];
    let components = [];  // 扫描顺序的分量描述

    // ---- 熵数据位读取器（在 SOS 后初始化使用） ----
    let bitPos = 0, bitBuf = 0, bitCnt = 0;

    function readBitByte() {
      if (bitPos >= len)
        throw new JpegError(bitPos, `文件截断：熵数据在偏移 ${bitPos} 处戛然而止`);
      const b = bytes[bitPos];
      if (b === 0xFF) {
        const nb = bitPos + 1 < len ? bytes[bitPos + 1] : -1;
        if (nb === 0x00) { bitPos += 2; return 0xFF; } // FF00 填充
        if (nb < 0)
          throw new JpegError(bitPos, `文件截断：偏移 ${bitPos} 处的 0xFF 后缺少后续字节`);
        throw new JpegError(bitPos,
          `熵数据中遇到意外标记 FF${hex(nb)}（偏移 ${bitPos}），熵段可能损坏`);
      }
      bitPos += 1;
      return b;
    }
    function readBit() {
      if (bitCnt === 0) { bitBuf = readBitByte(); bitCnt = 8; }
      const bit = (bitBuf >> 7) & 1;
      bitBuf = (bitBuf << 1) & 0xFF;
      bitCnt--;
      return bit;
    }
    function receive(s) {
      let v = 0;
      for (let i = 0; i < s; i++) v = (v << 1) | readBit();
      return v;
    }
    function extend(v, s) {
      return s === 0 ? 0 : (v < (1 << (s - 1)) ? v - (1 << s) + 1 : v);
    }
    function huffDecode(t) {
      let code = 0, l = 0;
      for (;;) {
        code = (code << 1) | readBit();
        l++;
        if (l > 16) throw new JpegError(bitPos, '熵数据中出现非法 Huffman 码字');
        if (t.maxcode[l] >= 0 && code <= t.maxcode[l])
          return t.symbols[t.valptr[l] + code - t.mincode[l]];
      }
    }

    // ---- 段解析 ----

    function parseDQT(segOffset, seg) {
      let p = 0;
      while (p < seg.length) {
        const pq = seg[p] >> 4, tq = seg[p] & 15;
        if (pq !== 0)
          throw new JpegError(segOffset + p, `仅支持 8 位量化表，表 ${tq} 的精度为 ${pq * 8 + 8} 位`);
        if (tq > 3) throw new JpegError(segOffset + p, `量化表 id ${tq} 越界（0..3）`);
        if (p + 1 + 64 > seg.length)
          throw new JpegError(segOffset + p, 'DQT 段长度不足，量化表被截断');
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) t[ZIGZAG[i]] = seg[p + 1 + i];
        qtables[tq] = t;
        p += 65;
      }
      return `量化表 [${Object.keys(qtables).join(', ')}]（8 位，zigzag 存储）`;
    }

    function parseDHT(segOffset, seg) {
      let p = 0;
      const made = [];
      while (p < seg.length) {
        const tc = seg[p] >> 4, th = seg[p] & 15;
        if (tc > 1) throw new JpegError(segOffset + p, `Huffman 表类别 ${tc} 非法`);
        if (th > 3) throw new JpegError(segOffset + p, `Huffman 表 id ${th} 越界（0..3）`);
        if (p + 17 > seg.length)
          throw new JpegError(segOffset + p, 'DHT 段长度不足，计数表被截断');
        const counts = seg.subarray(p + 1, p + 17);
        let total = 0;
        for (let i = 0; i < 16; i++) total += counts[i];
        if (total > 256) throw new JpegError(segOffset + p, `Huffman 表符号数 ${total} 超过 256`);
        if (p + 17 + total > seg.length)
          throw new JpegError(segOffset + p, 'DHT 段长度不足，符号表被截断');
        const symbols = seg.subarray(p + 17, p + 17 + total);
        const table = buildHuffmanTable(counts, symbols);
        (tc === 0 ? dcTables : acTables)[th] = table;
        made.push(`${tc === 0 ? 'DC' : 'AC'}${th}(${total} 符号)`);
        p += 17 + total;
      }
      return 'Huffman 表 ' + made.join('、');
    }

    function parseSOF0(segOffset, seg) {
      if (seg.length < 6) throw new JpegError(segOffset, 'SOF0 段长度不足');
      const precision = seg[0];
      if (precision !== 8)
        throw new JpegError(segOffset, `仅支持 8 位采样精度，实际为 ${precision} 位`);
      const height = (seg[1] << 8) | seg[2];
      const width = (seg[3] << 8) | seg[4];
      const nf = seg[5];
      if (width < 1 || height < 1)
        throw new JpegError(segOffset + 1, `图像尺寸非法（${width}×${height}），不支持 DNL`);
      if (width > 1024 || height > 1024)
        throw new JpegError(segOffset + 1, `图像尺寸 ${width}×${height} 超过支持的 1024×1024`);
      if (nf !== 1 && nf !== 3)
        throw new JpegError(segOffset + 5, `仅支持灰度（1 分量）或 YCbCr（3 分量），实际 ${nf} 分量（CMYK 等不予支持）`);
      if (seg.length < 6 + 3 * nf)
        throw new JpegError(segOffset, 'SOF0 段长度不足，分量描述被截断');
      const comps = [];
      for (let i = 0; i < nf; i++) {
        const id = seg[6 + 3 * i];
        const h = seg[7 + 3 * i] >> 4, v = seg[7 + 3 * i] & 15;
        const tq = seg[8 + 3 * i];
        if (h < 1 || h > 4 || v < 1 || v > 4)
          throw new JpegError(segOffset + 7 + 3 * i, `分量 ${id} 采样因子 ${h}×${v} 越界（1..4）`);
        comps.push({ id, H: h, V: v, tq });
      }
      if (nf === 3) {
        const ids = comps.map((c) => c.id).sort().join(',');
        if (ids !== '1,2,3')
          throw new JpegError(segOffset + 6, `仅支持 JFIF YCbCr 分量标识 1/2/3，实际为 ${comps.map((c) => c.id).join('/')}`);
        const y = comps.find((c) => c.id === 1);
        const cb = comps.find((c) => c.id === 2);
        const cr = comps.find((c) => c.id === 3);
        const okChroma = cb.H === 1 && cb.V === 1 && cr.H === 1 && cr.V === 1;
        const okLuma = (y.H === 1 && y.V === 1) || (y.H === 2 && y.V === 1) || (y.H === 2 && y.V === 2);
        if (!okLuma || !okChroma)
          throw new JpegError(segOffset + 6,
            `不支持的采样组合：Y ${y.H}×${y.V}、Cb ${cb.H}×${cb.V}、Cr ${cr.H}×${cr.V}（仅支持 4:4:4 / 4:2:2 / 4:2:0）`);
      }
      const maxH = Math.max(...comps.map((c) => c.H));
      const maxV = Math.max(...comps.map((c) => c.V));
      frame = { width, height, comps, maxH, maxV };
      const samp = nf === 1 ? '灰度'
        : (maxH === 1 ? '4:4:4' : maxV === 1 ? '4:2:2' : '4:2:0');
      return `基线 DCT，${width}×${height}，${nf} 分量（${samp}），采样 ` +
        comps.map((c) => `#${c.id}:${c.H}×${c.V}/Q${c.tq}`).join(' ');
    }

    function parseSOS(segOffset, seg) {
      if (!frame) throw new JpegError(segOffset, 'SOS 出现在 SOF0 之前');
      if (scanDone) throw new JpegError(segOffset, '出现第二个 SOS：仅支持单扫描');
      if (seg.length < 1) throw new JpegError(segOffset, 'SOS 段长度不足');
      const ns = seg[0];
      if (ns !== frame.comps.length)
        throw new JpegError(segOffset, `扫描分量数 ${ns} 与帧分量数 ${frame.comps.length} 不一致（要求单扫描交错）`);
      if (seg.length < 1 + 2 * ns + 3)
        throw new JpegError(segOffset, 'SOS 段长度不足，扫描分量描述被截断');
      const scanComps = [];
      for (let i = 0; i < ns; i++) {
        const cs = seg[1 + 2 * i];
        const td = seg[2 + 2 * i] >> 4, ta = seg[2 + 2 * i] & 15;
        const fc = frame.comps.find((c) => c.id === cs);
        if (!fc) throw new JpegError(segOffset + 1 + 2 * i, `扫描引用了未知分量 ${cs}`);
        if (!dcTables[td]) throw new JpegError(segOffset + 2 + 2 * i, `分量 ${cs} 引用的 DC Huffman 表 ${td} 未定义`);
        if (!acTables[ta]) throw new JpegError(segOffset + 2 + 2 * i, `分量 ${cs} 引用的 AC Huffman 表 ${ta} 未定义`);
        if (!qtables[fc.tq]) throw new JpegError(segOffset + 2 + 2 * i, `分量 ${cs} 引用的量化表 ${fc.tq} 未定义`);
        scanComps.push({ ...fc, td, ta, dc: dcTables[td], ac: acTables[ta], q: qtables[fc.tq] });
      }
      const ss = seg[1 + 2 * ns], se = seg[2 + 2 * ns], ah = seg[3 + 2 * ns] >> 4, al = seg[3 + 2 * ns] & 15;
      if (ss !== 0 || se !== 63 || ah !== 0 || al !== 0)
        throw new JpegError(segOffset + 1 + 2 * ns,
          `扫描谱范围 Ss=${ss} Se=${se} Ah=${ah} Al=${al} 不符合基线约定（0/63/0/0）`);
      components = scanComps;
      return `${ns} 分量交错扫描，Ss=0 Se=63 Ah/Al=0，表 ` +
        scanComps.map((c) => `#${c.id}:DC${c.td}/AC${c.ta}`).join(' ');
    }

    // ---- 熵段解码 ----

    function decodeBlock(sc, preds, ci) {
      const coef = new Int32Array(64);
      const s = huffDecode(sc.dc);
      if (s > 11) throw new JpegError(bitPos, `DC 幅度类别 ${s} 越界（基线 ≤ 11）`);
      const diff = s === 0 ? 0 : extend(receive(s), s);
      const dcPredBefore = preds[ci];
      preds[ci] += diff;
      coef[0] = preds[ci];
      let k = 1;
      while (k < 64) {
        const rs = huffDecode(sc.ac);
        const run = rs >> 4, size = rs & 15;
        if (size === 0) {
          if (run === 15) { k += 16; continue; } // ZRL
          break; // EOB
        }
        k += run;
        if (k > 63) throw new JpegError(bitPos, 'AC 系数位置越界（超过 63）');
        coef[ZIGZAG[k]] = extend(receive(size), size);
        k++;
      }
      return { coefficients: coef, dcPredBefore, dcDiff: diff, dcPredAfter: preds[ci] };
    }

    function idctIntoPlane(deq, plane, stride, ox, oy) {
      const tmp = new Float64Array(64);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          let s = 0;
          for (let u = 0; u < 8; u++) s += CORTH[u] * deq[y * 8 + u] * COS[u * 8 + x];
          tmp[y * 8 + x] = s;
        }
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          let s = 0;
          for (let v = 0; v < 8; v++) s += CORTH[v] * tmp[v * 8 + x] * COS[v * 8 + y];
          const val = Math.floor(0.25 * s + 128 + 0.5);
          plane[(oy + y) * stride + ox + x] = val < 0 ? 0 : val > 255 ? 255 : val;
        }
    }

    function decodeScan(scanStart) {
      const { width, height, maxH, maxV } = frame;
      const mcuCols = Math.ceil(width / (8 * maxH));
      const mcuRows = Math.ceil(height / (8 * maxV));
      const total = mcuCols * mcuRows;

      // 分量平面（按 MCU 补齐）
      for (const sc of components) {
        sc.planeW = mcuCols * sc.H * 8;
        sc.planeH = mcuRows * sc.V * 8;
        sc.logicalW = Math.ceil((width * sc.H) / maxH);
        sc.logicalH = Math.ceil((height * sc.V) / maxV);
        sc.plane = new Uint8Array(sc.planeW * sc.planeH);
      }

      bitPos = scanStart; bitBuf = 0; bitCnt = 0;
      const preds = new Int32Array(components.length);
      let restartCount = 0;

      for (let m = 0; m < total; m++) {
        if (restartInterval > 0 && m > 0 && m % restartInterval === 0) {
          // 字节对齐，读取 RSTn
          bitCnt = 0; bitBuf = 0;
          let p = bitPos;
          if (p >= len)
            throw new JpegError(p, `文件截断：第 ${m} 个 MCU 后期望重启标记 RST${restartCount % 8}`);
          if (bytes[p] !== 0xFF)
            throw new JpegError(p, `第 ${m} 个 MCU 后期望重启标记 RST${restartCount % 8}，实际字节 0x${hex(bytes[p])}`);
          const ffStart = p;
          while (p < len && bytes[p] === 0xFF) p++;
          if (p >= len)
            throw new JpegError(p, `文件截断：偏移 ${ffStart} 处的 0xFF 后缺少标记字节`);
          const code = bytes[p];
          if (code < 0xD0 || code > 0xD7)
            throw new JpegError(ffStart, `第 ${m} 个 MCU 后期望重启标记 RST${restartCount % 8}，实际为 FF${hex(code)}`);
          const got = code - 0xD0, want = restartCount % 8;
          if (got !== want)
            throw new JpegError(ffStart, `重启标记序号错误：期望 RST${want}，实际为 RST${got}`);
          markers.push({
            offset: ffStart, end: p + 1, code,
            name: `RST${got}`,
            summary: `重启段 #${restartCount + 1} 开始：全部 DC 预测器复位为 0（位于 MCU ${m} 之前）`,
          });
          bitPos = p + 1;
          preds.fill(0);
          restartCount++;
        }

        const mcuRow = Math.floor(m / mcuCols), mcuCol = m % mcuCols;
        const mcu = {
          index: m, row: mcuRow, col: mcuCol,
          restartIndex: restartCount,
          firstAfterRestart: restartInterval > 0 && m % restartInterval === 0,
          blocks: [],
        };
        for (let ci = 0; ci < components.length; ci++) {
          const sc = components[ci];
          for (let by = 0; by < sc.V; by++)
            for (let bx = 0; bx < sc.H; bx++) {
              const blk = decodeBlock(sc, preds, ci);
              const deq = new Int32Array(64);
              for (let i = 0; i < 64; i++) deq[i] = blk.coefficients[i] * sc.q[i];
              const planeBX = mcuCol * sc.H + bx, planeBY = mcuRow * sc.V + by;
              idctIntoPlane(deq, sc.plane, sc.planeW, planeBX * 8, planeBY * 8);
              mcu.blocks.push({
                component: sc.id, blockX: bx, blockY: by,
                coefficients: blk.coefficients, dequantized: deq,
                dcPredBefore: blk.dcPredBefore, dcDiff: blk.dcDiff, dcPredAfter: blk.dcPredAfter,
              });
            }
        }
        mcus.push(mcu);
      }

      // 扫描结束：丢弃补齐位，指向下一个标记
      bitCnt = 0; bitBuf = 0;
      return bitPos;
    }

    // ---- 标记主循环 ----

    while (pos < len) {
      if (bytes[pos] !== 0xFF)
        throw new JpegError(pos, `期望标记前缀 0xFF，实际为 0x${hex(bytes[pos])}`);
      const ffStart = pos;
      while (pos < len && bytes[pos] === 0xFF) pos++;
      if (pos >= len)
        throw new JpegError(pos, `文件截断：偏移 ${ffStart} 处的 0xFF 后缺少标记字节`);
      const code = bytes[pos];
      pos++;

      if (code === 0x00)
        throw new JpegError(ffStart, '标记区出现 FF00 填充字节（只允许出现在熵数据中）');
      if (code === 0xD8) throw new JpegError(ffStart, '重复的 SOI 标记');
      if (code === 0xD9) {
        markers.push({ offset: ffStart, end: pos, code, name: 'EOI', summary: '图像结束' });
        if (!scanDone) throw new JpegError(ffStart, 'EOI 出现在任何扫描数据之前');
        break;
      }
      if (code === 0x01 || (code >= 0xD0 && code <= 0xD7))
        throw new JpegError(ffStart, `扫描数据之外出现意外的 ${markerName(code)} 标记`);

      if (pos + 2 > len)
        throw new JpegError(pos, `文件截断：${markerName(code)} 标记缺少长度字段`);
      const segLen = (bytes[pos] << 8) | bytes[pos + 1];
      if (segLen < 2) throw new JpegError(pos, `${markerName(code)} 段长度 ${segLen} 非法`);
      if (pos + segLen > len)
        throw new JpegError(pos, `文件截断：${markerName(code)} 段声明长度 ${segLen}，超出文件末尾`);
      const seg = bytes.subarray(pos + 2, pos + segLen);
      const segEnd = pos + segLen;
      let summary = '';

      if (code >= 0xE0 && code <= 0xEF) {
        let tag = '';
        if (code === 0xE0 && seg.length >= 5 && seg[0] === 0x4A && seg[1] === 0x46 &&
            seg[2] === 0x49 && seg[3] === 0x46 && seg[4] === 0x00)
          tag = `JFIF ${seg[5]}.${String(seg[6]).padStart(2, '0')}`;
        summary = `应用数据段（跳过，不解释 EXIF 朝向）${tag ? '：' + tag : ''}`;
      } else if (code === 0xFE) {
        let text = '';
        try { text = new TextDecoder('utf-8').decode(seg); } catch (e) { /* 忽略 */ }
        summary = `注释（跳过）：${text.length > 60 ? text.slice(0, 60) + '…' : text}`;
      } else if (code === 0xDB) {
        summary = parseDQT(pos + 2, seg);
      } else if (code === 0xC4) {
        summary = parseDHT(pos + 2, seg);
      } else if (code === 0xDD) {
        if (seg.length !== 2) throw new JpegError(pos + 2, 'DRI 段长度必须为 4');
        restartInterval = (seg[0] << 8) | seg[1];
        summary = `重启间隔 Ri=${restartInterval}` + (restartInterval ? `（每 ${restartInterval} 个 MCU 一个 RSTn）` : '（无重启）');
      } else if (code === 0xC0) {
        summary = parseSOF0(pos + 2, seg);
      } else if (SOF_REASONS[code]) {
        throw new JpegError(ffStart, `不支持的编码：${SOF_REASONS[code]}（标记 ${markerName(code)}）`);
      } else if (code === 0xCC) {
        throw new JpegError(ffStart, '不支持的编码：出现 DAC 标记，算术编码不予支持');
      } else if (code === 0xDA) {
        summary = parseSOS(pos + 2, seg);
        markers.push({ offset: ffStart, end: segEnd, code, name: 'SOS', summary });
        const entropyStart = segEnd;
        pos = decodeScan(entropyStart);
        markers.push({
          offset: entropyStart, end: pos, code: -1, name: '熵数据',
          summary: `${mcus.length} 个 MCU 的 Huffman 熵编码数据（FF00 已去填充）`,
        });
        scanDone = true;
        continue;
      } else if (code === 0xDC || code === 0xDE) {
        throw new JpegError(ffStart, `不支持的可选标记 ${markerName(code)}`);
      } else {
        summary = '未知/保留段（按长度跳过）';
      }

      markers.push({ offset: ffStart, end: segEnd, code, name: markerName(code), summary });
      pos = segEnd;
    }

    if (!scanDone) throw new JpegError(len, '文件截断：未找到 SOS 扫描数据');
    if (pos >= len && markers[markers.length - 1].code !== 0xD9)
      throw new JpegError(len, `文件截断：扫描数据结束后缺少 EOI 标记（文件止于偏移 ${len}）`);

    // ---- 色度最近邻扩展 + RGB 转换 ----

    const { width, height, maxH, maxV } = frame;
    const rgb = new Uint8ClampedArray(width * height * 3);
    const round8 = (v) => { const r = Math.floor(v + 0.5); return r < 0 ? 0 : r > 255 ? 255 : r; };

    if (components.length === 1) {
      const sc = components[0];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const g = sc.plane[y * sc.planeW + x];
          const o = (y * width + x) * 3;
          rgb[o] = rgb[o + 1] = rgb[o + 2] = g;
        }
    } else {
      const byId = (id) => components.find((c) => c.id === id);
      const Y = byId(1), Cb = byId(2), Cr = byId(3);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          // 最近邻色度：floor(x/Hmax)、floor(y/Vmax)（包内约定）
          const yv = Y.plane[y * Y.planeW + x];
          const cb = Cb.plane[Math.floor(y / maxV) * Cb.planeW + Math.floor(x / maxH)];
          const cr = Cr.plane[Math.floor(y / maxV) * Cr.planeW + Math.floor(x / maxH)];
          const o = (y * width + x) * 3;
          rgb[o] = round8(yv + 1.402 * (cr - 128));
          rgb[o + 1] = round8(yv - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
          rgb[o + 2] = round8(yv + 1.772 * (cb - 128));
        }
    }

    return {
      width, height,
      grayscale: components.length === 1,
      maxH, maxV,
      mcuCols: Math.ceil(width / (8 * maxH)),
      mcuRows: Math.ceil(height / (8 * maxV)),
      restartInterval,
      markers,
      mcus,
      components: components.map((sc) => ({
        id: sc.id, H: sc.H, V: sc.V, tq: sc.tq, td: sc.td, ta: sc.ta,
        planeW: sc.planeW, planeH: sc.planeH,
        logicalW: sc.logicalW, logicalH: sc.logicalH,
        plane: sc.plane,
      })),
      quantTables: qtables,
      rgb,
    };
  }

  return { decode, JpegError, ZIGZAG };
});
