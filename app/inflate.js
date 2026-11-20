// RFC 1951 raw DEFLATE 解压（无头部封装），自包含实现。
// 仅依赖 Uint8Array 输入，返回 Uint8Array。用于浏览器端 PNG IDAT 解码。
// 测试中与 Node zlib / Python zlib 的输出做逐字节比对。

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289,
  16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
// 动态块 code-length 码长度的读取顺序
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class BitReader {
  constructor(bytes) {
    this.buf = bytes;
    this.pos = 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  readBits(n) {
    while (this.bitcnt < n) {
      if (this.pos >= this.buf.length) throw new Error("deflate: 输入意外结束");
      this.bitbuf |= this.buf[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
    const v = this.bitbuf & ((1 << n) - 1);
    this.bitbuf >>>= n;
    this.bitcnt -= n;
    return v;
  }
  alignToByte() {
    // 丢弃当前字节中尚未消耗的位，回到字节边界（同时清空缓冲，避免残位污染后续读取）
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  // 按 canonical Huffman 解码：deflate 码值按位逆序存入 LSB 位流，
  // 构造表时已把 canonical 码反转；解码时每读一位拼到累积值高位，
  // 累积值即“反转码”，可直接按长度查表。
  decode(table) {
    let code = 0;
    for (let len = 1; len <= table.maxLen; len++) {
      code |= this.readBits(1) << (len - 1);
      const sym = table.lookup[len] && table.lookup[len].get(code);
      if (sym !== undefined) return sym;
    }
    throw new Error("deflate: 无效的 Huffman 编码");
  }
}

// lengths: 每个符号的码长，0 表示该符号不存在。返回 {lookup, maxLen}
function buildHuffman(lengths) {
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Array(maxLen + 1).fill(0);
  for (const len of lengths) if (len > 0) blCount[len]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const lookup = [];
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (len === 0) continue;
    // 位反转：canonical 码首位置于位流最低位
    let rev = 0;
    let c = nextCode[len]++;
    for (let k = 0; k < len; k++) {
      rev = (rev << 1) | (c & 1);
      c >>= 1;
    }
    if (!lookup[len]) lookup[len] = new Map();
    lookup[len].set(rev, sym);
  }
  return { lookup, maxLen };
}

function fixedLitTable() {
  const lengths = new Array(288).fill(0);
  for (let i = 0; i < 144; i++) lengths[i] = 8;
  for (let i = 144; i < 256; i++) lengths[i] = 9;
  for (let i = 256; i < 280; i++) lengths[i] = 7;
  for (let i = 280; i < 288; i++) lengths[i] = 8;
  return buildHuffman(lengths);
}

function fixedDistTable() {
  return buildHuffman(new Array(30).fill(5));
}

function readDynamicTables(br) {
  const hlit = br.readBits(5) + 257;
  const hdist = br.readBits(5) + 1;
  const hclen = br.readBits(4) + 4;
  const clenLengths = new Array(19).fill(0);
  for (let i = 0; i < hclen; i++) {
    clenLengths[CLEN_ORDER[i]] = br.readBits(3);
  }
  const clenTable = buildHuffman(clenLengths);
  const total = hlit + hdist;
  const allLengths = [];
  while (allLengths.length < total) {
    const sym = br.decode(clenTable);
    if (sym < 16) {
      allLengths.push(sym);
    } else if (sym === 16) {
      const repeat = br.readBits(2) + 3;
      const prev = allLengths[allLengths.length - 1];
      for (let k = 0; k < repeat; k++) allLengths.push(prev);
    } else if (sym === 17) {
      const repeat = br.readBits(3) + 3;
      for (let k = 0; k < repeat; k++) allLengths.push(0);
    } else {
      // sym === 18
      const repeat = br.readBits(7) + 11;
      for (let k = 0; k < repeat; k++) allLengths.push(0);
    }
  }
  if (allLengths.length !== total) throw new Error("deflate: 动态 Huffman 表长度异常");
  const litLengths = allLengths.slice(0, hlit);
  const distLengths = allLengths.slice(hlit);
  return {
    lit: buildHuffman(litLengths),
    dist: buildHuffman(distLengths),
  };
}

function inflateBlock(br, out, litTable, distTable) {
  while (true) {
    const sym = br.decode(litTable);
    if (sym === 256) return;
    if (sym < 256) {
      out.push(sym);
    } else {
      const li = sym - 257;
      const len = LENGTH_BASE[li] + br.readBits(LENGTH_EXTRA[li]);
      const distSym = br.decode(distTable);
      const dist = DIST_BASE[distSym] + br.readBits(DIST_EXTRA[distSym]);
      if (dist > out.length) throw new Error("deflate: 回溯距离超出已输出范围");
      // 距离可能小于长度（重叠拷贝），必须逐字节
      const start = out.length - dist;
      for (let k = 0; k < len; k++) out.push(out[start + k]);
    }
  }
}

export function rawInflate(input) {
  let data = input;
  // PNG 的 IDAT 是 zlib(RFC1950) 封装：CMF/FLG 两字节头 + raw deflate + Adler32。
  // 检测到合法 zlib 头时跳过（裸 deflate 不会满足此校验）。
  if (data.length >= 2 && (data[0] & 0x0f) === 8 && ((data[0] << 8 | data[1]) % 31) === 0) {
    data = data.subarray(2, data.length - 4);
  }
  const br = new BitReader(data);
  const out = [];
  let bfinal = 0;
  do {
    bfinal = br.readBits(1);
    const btype = br.readBits(2);
    if (btype === 0) {
      // 存储块
      br.alignToByte();
      const len = br.buf[br.pos] | (br.buf[br.pos + 1] << 8);
      const nlen = br.buf[br.pos + 2] | (br.buf[br.pos + 3] << 8);
      br.pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error("deflate: 存储块 LEN/NLEN 校验失败");
      for (let k = 0; k < len; k++) out.push(br.buf[br.pos++]);
    } else if (btype === 1) {
      inflateBlock(br, out, fixedLitTable(), fixedDistTable());
    } else if (btype === 2) {
      const tables = readDynamicTables(br);
      inflateBlock(br, out, tables.lit, tables.dist);
    } else {
      throw new Error("deflate: 保留块类型 3");
    }
  } while (!bfinal);
  return Uint8Array.from(out);
}
