/*
 * G53 渐进灰度流 —— 纯手工实现
 *
 * 内容：
 *   1. 可逆整数 5/3 提升（一维 / 二维 / 多级）
 *   2. 带符号位平面流（MSB 优先，首次出现 1 时紧随符号位）
 *   3. G53A 容器：14 字节头 + 每位平面一条记录（13 字节记录头 + zlib 负载 + CRC32）
 *   4. 渐进式 G53StreamParser：未收完等待，CRC 错硬报错
 *
 * 不依赖任何现成小波变换或第三方图像/压缩编码器；zlib 由调用方注入
 * （浏览器用 pako，Node 测试用 node:zlib 的薄封装），CRC32 在本文件内实现。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.G53 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 基础整数工具 ---------------- */

  // 数学意义上的 floor 除法（负数也向负无穷取整）
  function floorDiv(a, b) {
    return Math.floor(a / b);
  }

  // 最高幅值位号：floor(log2(max|x|))；全 0 时按 G53 规范返回 255
  function highestBit(values) {
    let m = 0;
    for (let i = 0; i < values.length; i++) {
      const a = Math.abs(values[i]);
      if (a > m) m = a;
    }
    if (m === 0) return 255;
    let h = 0;
    while ((1 << (h + 1)) <= m) h++;
    return h;
  }

  /* ---------------- CRC32（与 zlib.crc32 一致） ---------------- */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ---------------- 一维整数 5/3 提升 ---------------- */

  /**
   * 正变换（原地风格，返回新数组）：
   *   偶项 e 与奇项 o 拆分，低频在前、高频在后
   *   d_i = o_i - floor((e_i + e_{min(i+1,last)}) / 2)
   *   s_i = e_i + floor((d_{max(i-1,0)} + d_{min(i,last)} + 2) / 4)
   * 长度为 1（没有奇项）时原样返回。
   */
  function forward1d(src) {
    const n = src.length;
    if (n <= 1) return src.slice();
    const ne = (n + 1) >> 1; // 偶项个数
    const no = n >> 1;       // 奇项个数
    const d = new Array(no);
    const s = new Array(ne);

    for (let i = 0; i < no; i++) {
      // e_{min(i+1,last)}：偶项 last 下标为 ne-1，n=2 时回退到 e_i 自身
      const j = Math.min(i + 1, ne - 1);
      const eCur = src[2 * i];
      const eNext = src[2 * j];
      d[i] = src[2 * i + 1] - floorDiv(eCur + eNext, 2);
    }
    for (let i = 0; i < ne; i++) {
      const dL = d[Math.max(i - 1, 0)];
      const dR = d[Math.min(i, no - 1)]; // 最后一个偶项（奇数长度）回退到最后一个高频
      s[i] = src[2 * i] + floorDiv(dL + dR + 2, 4);
    }
    return s.concat(d);
  }

  /** 逆变换：精确撤销 forward1d 的两步提升 */
  function inverse1d(coeff) {
    const n = coeff.length;
    if (n <= 1) return coeff.slice();
    const ne = (n + 1) >> 1;
    const no = n >> 1;
    const s = coeff.slice(0, ne);
    const d = coeff.slice(ne);
    const e = new Array(ne);
    const o = new Array(no);

    for (let i = 0; i < ne; i++) {
      const dL = d[Math.max(i - 1, 0)];
      const dR = d[Math.min(i, no - 1)];
      e[i] = s[i] - floorDiv(dL + dR + 2, 4);
    }
    for (let i = 0; i < no; i++) {
      const j = Math.min(i + 1, ne - 1);
      o[i] = d[i] + floorDiv(e[i] + e[j], 2);
    }
    const out = new Array(n);
    for (let i = 0; i < no; i++) {
      out[2 * i] = e[i];
      out[2 * i + 1] = o[i];
    }
    if (ne > no) out[n - 1] = e[ne - 1]; // 奇数长度末端偶项
    return out;
  }

  /* ---------------- 二维提升（先行后列） ---------------- */

  /**
   * 在全尺寸数组 a（行步长 W）上，原地变换左上 w×h 子矩阵。
   * 多级分解时整个系数矩阵尺寸不变，每级只处理当前低频区域。
   */
  function forward2dRegion(a, W, w, h) {
    const tmp = new Array(Math.max(w, h));
    // 每一行（只取前 w 项）
    for (let y = 0; y < h; y++) {
      const base = y * W;
      for (let x = 0; x < w; x++) tmp[x] = a[base + x];
      const t = forward1d(tmp.slice(0, w));
      for (let x = 0; x < w; x++) a[base + x] = t[x];
    }
    // 每一列（只取前 h 行）
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) tmp[y] = a[y * W + x];
      const t = forward1d(tmp.slice(0, h));
      for (let y = 0; y < h; y++) a[y * W + x] = t[y];
    }
  }

  function inverse2dRegion(a, W, w, h) {
    const tmp = new Array(Math.max(w, h));
    // 先撤销列
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) tmp[y] = a[y * W + x];
      const t = inverse1d(tmp.slice(0, h));
      for (let y = 0; y < h; y++) a[y * W + x] = t[y];
    }
    // 再撤销行
    for (let y = 0; y < h; y++) {
      const base = y * W;
      for (let x = 0; x < w; x++) tmp[x] = a[base + x];
      const t = inverse1d(tmp.slice(0, w));
      for (let x = 0; x < w; x++) a[base + x] = t[x];
    }
  }

  // 整图变换的便捷包装（单级使用）
  function forward2d(a, w, h) {
    const out = a.slice();
    forward2dRegion(out, w, w, h);
    return out;
  }

  function inverse2d(coeff, w, h) {
    const out = coeff.slice();
    inverse2dRegion(out, w, w, h);
    return out;
  }

  /* ---------------- 多级分解 ---------------- */

  /** 可变换次数：宽或高降到 1 之前的轮数 */
  function maxLevels(w, h) {
    let L = 0, cw = w, ch = h;
    while (cw > 1 || ch > 1) {
      cw = Math.ceil(cw / 2);
      ch = Math.ceil(ch / 2);
      L++;
    }
    return L;
  }

  /**
   * 多级正变换。返回 { coeff, levels, dims }
   * dims[l] = 第 l 轮变换前的 {w,h}（l 从 1 开始），dims[0] 为原图尺寸
   * 系数矩阵始终保持 w×h 全尺寸，每级仅就地变换左上低频区域。
   */
  function decompose(pixels, w, h, levels) {
    const maxL = maxLevels(w, h);
    if (!Number.isInteger(levels) || levels < 0 || levels > maxL) {
      throw new Error('层数非法：' + levels + '（允许 0..' + maxL + '）');
    }
    const coeff = pixels.slice();
    const dims = [{ w, h }];
    let cw = w, ch = h;
    for (let l = 1; l <= levels; l++) {
      forward2dRegion(coeff, w, cw, ch);
      cw = Math.ceil(cw / 2);
      ch = Math.ceil(ch / 2);
      dims.push({ w: cw, h: ch });
    }
    return { coeff, levels, dims };
  }

  /** 多级逆变换，返回像素数组（仍为减 128 的有符号域） */
  function reconstruct(coeff, w, h, levels, dims) {
    const cur = coeff.slice();
    for (let l = levels; l >= 1; l--) {
      const cw = dims[l - 1].w;
      const ch = dims[l - 1].h;
      inverse2dRegion(cur, w, cw, ch);
    }
    return cur;
  }

  /* ---------------- 位平面打包 / 解包 ---------------- */

  class BitWriter {
    constructor() {
      this.bytes = [];
      this.cur = 0;
      this.nbits = 0;
    }
    writeBit(b) {
      this.cur = (this.cur << 1) | (b & 1);
      this.nbits++;
      if (this.nbits === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
    finish() {
      if (this.nbits > 0) {
        // 尾部补零到字节边界
        this.cur <<= 8 - this.nbits;
        this.bytes.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
      return Uint8Array.from(this.bytes);
    }
  }

  class BitReader {
    constructor(bytes) {
      this.buf = bytes;
      this.pos = 0;
      this.acc = 0;
      this.nbits = 0;
    }
    readBit() {
      if (this.nbits === 0) {
        if (this.pos >= this.buf.length) throw new Error('位流意外结束');
        this.acc = this.buf[this.pos++];
        this.nbits = 8;
      }
      this.nbits--;
      return (this.acc >> this.nbits) & 1;
    }
    // 读完所有有效位后，剩余补齐位必须全为 0
    checkPadding() {
      if (this.nbits > 0) {
        if (this.acc & ((1 << this.nbits) - 1)) {
          throw new Error('补齐位非 0（G53 要求尾部补零）');
        }
        this.nbits = 0;
      }
      if (this.pos !== this.buf.length) {
        throw new Error('解压负载长度超出本层所需位数');
      }
    }
  }

  /**
   * 单层负载编码。
   * 按最终系数矩阵行优先，每个系数写 1 个幅值位；
   * 系数首次出现 1（其最高置位恰在本层）时紧随符号位，负为 1。
   * 无状态：首次条件直接由 |v| 的位宽判断，|v| 在 [2^bit, 2^(bit+1)) 即首次。
   */
  function encodeBitplane(coeff, bit) {
    const bw = new BitWriter();
    const next = 1 << (bit + 1);
    for (let i = 0; i < coeff.length; i++) {
      const v = coeff[i];
      const av = Math.abs(v);
      const mag = (av >> bit) & 1;
      bw.writeBit(mag);
      if (mag === 1 && av < next) {
        bw.writeBit(v < 0 ? 1 : 0);
      }
    }
    return bw.finish();
  }

  /**
   * 单层负载解码（增量写入 mag / sign / known）。
   * mag 始终保存无符号幅值（避免 JS 32 位有符号位运算在置高位时误产生负数）；
   * sign 单独保存，reconstruct 时再施加。未收到的更高位按 0 处理。
   */
  function decodeBitplane(payload, mag, sign, known, bit) {
    const br = new BitReader(payload);
    const mask = 1 << bit;
    for (let i = 0; i < mag.length; i++) {
      const mb = br.readBit();
      if (mb) {
        mag[i] += mask; // 幅值用普通整数加法，绝不使用有符号位运算
        if (!known[i]) {
          const sb = br.readBit();
          known[i] = 1;
          sign[i] = sb; // 1 = 负
        }
      }
    }
    br.checkPadding();
  }

  /** 把（幅值, 符号）数组合成有符号系数 */
  function signedCoefficients(mag, sign) {
    const out = new Array(mag.length);
    for (let i = 0; i < mag.length; i++) {
      out[i] = sign[i] ? -mag[i] : mag[i];
    }
    return out;
  }

  /* ---------------- G53A 整流编码 ---------------- */

  /**
   * @param pixels 0..255 灰度数组（函数内部减 128）
   * @param zlib { deflate(u8)->u8, inflate(u8)->u8 } 注入
   */
  function encodeStream(pixels, w, h, levels, zlib) {
    if (w < 1 || h < 1 || w > 1024 || h > 1024) {
      throw new Error('边长须在 1..1024 之间');
    }
    if (pixels.length !== w * h) throw new Error('像素数与宽高不符');
    const centered = new Array(w * h);
    for (let i = 0; i < pixels.length; i++) centered[i] = pixels[i] - 128;

    const { coeff, dims } = decompose(centered, w, h, levels);
    const hb = highestBit(coeff);

    const head = new Uint8Array(14);
    const hv = new DataView(head.buffer);
    head.set([0x47, 0x35, 0x33, 0x41], 0); // "G53A"
    hv.setUint32(4, w, true);
    hv.setUint32(8, h, true);
    hv.setUint8(12, levels);
    hv.setUint8(13, hb);

    const chunks = [head];
    const records = [];

    if (hb !== 255) {
      for (let bit = hb; bit >= 0; bit--) {
        const raw = encodeBitplane(coeff, bit);
        const comp = zlib.deflate(raw);
        const crc = crc32(raw);
        const rec = new Uint8Array(13);
        const rv = new DataView(rec.buffer);
        rv.setUint8(0, bit);
        rv.setUint32(1, raw.length, true);
        rv.setUint32(5, comp.length, true);
        rv.setUint32(9, crc, true);
        chunks.push(rec, comp);
        records.push({ bit, rawLen: raw.length, compLen: comp.length, crc });
      }
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const stream = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      stream.set(c, off);
      off += c.length;
    }
    return { stream, coeff, dims, levels, highbit: hb, records };
  }

  /* ---------------- G53A 渐进解析器 ---------------- */

  /**
   * 用法：
   *   const p = new G53StreamParser(zlib);
   *   p.feed(chunk);  // 可多次喂入
   *   p.state   'header' | 'records' | 'done' | 'error'
   *   p.waiting 末尾记录不完整时为 true（等待更多字节，不算损坏）
   *   p.error   完整但校验失败等硬错误
   *   p.layers[] 已完整校验通过的层 {bit, rawLen, compLen, crc, payload}
   */
  class G53StreamParser {
    constructor(zlib) {
      this.zlib = zlib;
      this.reset();
    }

    reset() {
      this.buf = new Uint8Array(0);
      this.off = 0;
      this.state = 'header';
      this.waiting = false;
      this.error = null;
      this.width = 0;
      this.height = 0;
      this.levels = 0;
      this.highbit = 0;
      this.expectedBit = -1;
      this.layers = [];
      this.mag = null;
      this.sign = null;
      this.known = null;
      this.dims = null;
    }

    _need(n) {
      return this.buf.length - this.off >= n;
    }

    feed(chunk) {
      if (this.state === 'error') return;
      // 追加新字节，保留尚未消费的尾部
      const remain = this.buf.length - this.off;
      const merged = new Uint8Array(remain + chunk.length);
      merged.set(this.buf.subarray(this.off), 0);
      merged.set(chunk, remain);
      this.buf = merged;
      this.off = 0;
      this.waiting = false;

      try {
        if (this.state === 'header') this._parseHeader();
        if (this.state === 'records') this._parseRecords();
      } catch (e) {
        this.state = 'error';
        this.error = e.message;
        this.waiting = false;
      }
    }

    _parseHeader() {
      if (!this._need(14)) {
        this.waiting = true;
        return;
      }
      const magic = String.fromCharCode(
        this.buf[this.off], this.buf[this.off + 1],
        this.buf[this.off + 2], this.buf[this.off + 3]
      );
      if (magic !== 'G53A') throw new Error('魔数错误：不是 G53A 流（收到 ' + magic + '）');
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 14);
      this.width = dv.getUint32(4, true);
      this.height = dv.getUint32(8, true);
      this.levels = dv.getUint8(12);
      this.highbit = dv.getUint8(13);
      this.off += 14;

      if (this.width < 1 || this.height < 1 || this.width > 1024 || this.height > 1024) {
        throw new Error('头中边长越界：' + this.width + 'x' + this.height);
      }
      const maxL = maxLevels(this.width, this.height);
      if (this.levels > maxL) {
        throw new Error('头中实际层数 ' + this.levels + ' 超过可变换次数 ' + maxL);
      }
      if (this.highbit !== 255 && (this.highbit > 30)) {
        throw new Error('最高幅值位号异常：' + this.highbit);
      }
      // 预计算每轮尺寸，供重建使用
      this.dims = [{ w: this.width, h: this.height }];
      let cw = this.width, ch = this.height;
      for (let l = 1; l <= this.levels; l++) {
        cw = Math.ceil(cw / 2);
        ch = Math.ceil(ch / 2);
        this.dims.push({ w: cw, h: ch });
      }
      const n = this.width * this.height;
      this.mag = new Array(n).fill(0);
      this.sign = new Uint8Array(n);
      this.known = new Uint8Array(n);
      this.expectedBit = this.highbit === 255 ? -1 : this.highbit;
      this.state = 'records';
    }

    _parseRecords() {
      // 全零系数流：头后无层
      if (this.highbit === 255) {
        if (this.buf.length - this.off > 0) {
          throw new Error('全零系数流后存在多余字节');
        }
        this.state = 'done';
        return;
      }

      while (true) {
        if (this.off === this.buf.length) {
          // 干净地停在记录边界
          if (this.expectedBit < 0) this.state = 'done';
          else this.waiting = true;
          return;
        }
        if (this.expectedBit < 0) {
          throw new Error('记录结束后存在多余字节');
        }
        if (!this._need(13)) {
          this.waiting = true; // 记录头不完整 → 等待
          return;
        }
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 13);
        const bit = dv.getUint8(0);
        const rawLen = dv.getUint32(1, true);
        const compLen = dv.getUint32(5, true);
        const crc = dv.getUint32(9, true);
        if (bit !== this.expectedBit) {
          throw new Error('层号不连续：期望位号 ' + this.expectedBit + '，实际 ' + bit);
        }
        const n = this.width * this.height;
        if (rawLen < Math.ceil(n / 8) || rawLen > Math.ceil((2 * n) / 8)) {
          throw new Error('记录解压字节数 ' + rawLen + ' 与系数数量 ' + n + ' 不符');
        }
        if (!this._need(13 + compLen)) {
          this.waiting = true; // 负载不完整 → 等待，不能误报损坏
          return;
        }
        this.off += 13;
        const comp = this.buf.slice(this.off, this.off + compLen);
        this.off += compLen;

        let raw;
        try {
          raw = this.zlib.inflate(comp);
        } catch (e) {
          const detail = e && (e.message || e.name || e.toString()) || '未知错误';
          throw new Error('位号 ' + bit + ' 的 zlib 负载无法解压（记录完整，按损坏处理）：' + detail);
        }
        if (raw.length !== rawLen) {
          throw new Error('位号 ' + bit + ' 解压长度不符：头声明 ' + rawLen + '，实际 ' + raw.length);
        }
        const actual = crc32(raw);
        if (actual !== crc) {
          // 完整记录但 CRC 错 → 硬错误，不得当成截断
          throw new Error('位号 ' + bit + ' CRC32 校验失败：记录值 0x' +
            crc.toString(16).padStart(8, '0') + '，实际 0x' + actual.toString(16).padStart(8, '0'));
        }
        decodeBitplane(raw, this.mag, this.sign, this.known, bit);
        this.layers.push({ bit, rawLen, compLen, crc, payload: raw });
        this.expectedBit = bit === 0 ? -1 : bit - 1;
      }
    }

    /** 当前有符号系数（未收到的位按 0），供子带/系数查看与重建 */
    currentCoefficients() {
      if (!this.mag) return null;
      return signedCoefficients(this.mag, this.sign);
    }

    /** 用当前已通过校验的层重建灰度图（显示可夹紧，计算不提前夹紧） */
    reconstructImage() {
      if (!this.mag) return null;
      const coeff = signedCoefficients(this.mag, this.sign);
      const centered = reconstruct(coeff, this.width, this.height, this.levels, this.dims);
      const out = new Uint8ClampedArray(centered.length);
      for (let i = 0; i < centered.length; i++) out[i] = centered[i] + 128;
      return out;
    }

    /** 有符号域重建结果（用于无损判定，不做夹紧） */
    reconstructSigned() {
      if (!this.mag) return null;
      const coeff = signedCoefficients(this.mag, this.sign);
      return reconstruct(coeff, this.width, this.height, this.levels, this.dims)
        .map(v => v + 128);
    }
  }

  /**
   * 子带几何：返回每级分解后四个区域（在全尺寸系数矩阵中的矩形）。
   * level l（1..L）变换前尺寸 dims[l-1]，变换后低频 dims[l]：
   *   LL: [0, cw) x [0, ch)
   *   HL（水平高频）: [cw, pw) x [0, ch)
   *   LH（垂直高频）: [0, cw) x [ch, ph)
   *   HH: [cw, pw) x [ch, ph)
   * 单轴为 1 时对应高频区域宽度/高度为 0，调用方按空区域处理。
   */
  function subbands(dims) {
    const out = [];
    for (let l = 1; l < dims.length; l++) {
      const pw = dims[l - 1].w, ph = dims[l - 1].h;
      const cw = dims[l].w, ch = dims[l].h;
      out.push({
        level: l,
        parent: { w: pw, h: ph },
        LL: { x: 0, y: 0, w: cw, h: ch },
        HL: { x: cw, y: 0, w: pw - cw, h: ch },
        LH: { x: 0, y: ch, w: cw, h: ph - ch },
        HH: { x: cw, y: ch, w: pw - cw, h: ph - ch },
      });
    }
    return out;
  }

  return {
    floorDiv,
    highestBit,
    crc32,
    forward1d,
    inverse1d,
    forward2d,
    inverse2d,
    maxLevels,
    decompose,
    reconstruct,
    subbands,
    BitWriter,
    BitReader,
    encodeBitplane,
    decodeBitplane,
    signedCoefficients,
    encodeStream,
    G53StreamParser,
  };
});
