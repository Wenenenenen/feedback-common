// LCP1 读包器（自研）。按相同工程约定逐段检查，任何损坏都抛出带坏段位置的 LcpError，
// 调用方据此保留上一次的预览而不是替换成半成品。
import { LcpError } from './errors.js';
import { crc32 } from './crc32.js';
import { decodeUtf8, encodeUtf8, compareBytes } from './utf8.js';
import { TAG_T, TAG_A, TAG_R, TAG_P, NULL_INDEX } from './parser.js';
import { checkProject } from './project.js';

class ByteReader {
  constructor(bytes) {
    this.b = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.off = 0;
  }
  u8(seg) {
    if (this.off + 1 > this.b.length) throw new LcpError('读取字节时越界（包被截断）', seg);
    return this.b[this.off++];
  }
  tag(seg) {
    return String.fromCharCode(this.u8(seg));
  }
  u32(seg) {
    if (this.off + 4 > this.b.length) throw new LcpError('读取 u32 时越界（包被截断）', seg);
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  raw(n, seg) {
    if (this.off + n > this.b.length) throw new LcpError(`读取 ${n} 字节时越界（包被截断）`, seg);
    const slice = this.b.subarray(this.off, this.off + n);
    this.off += n;
    return slice;
  }
}

// (语言, 键) 元组的字节序比较：先语言后键
function compareLangKey(langA, keyA, langB, keyB) {
  const c = compareBytes(encodeUtf8(langA), encodeUtf8(langB));
  if (c !== 0) return c;
  return compareBytes(encodeUtf8(keyA), encodeUtf8(keyB));
}

function readNodes(r, strings, seg) {
  const count = r.u32(seg);
  const nodes = new Array(count);
  let prevBranchName = null;
  for (let i = 0; i < count; i++) {
    const nodeSeg = `${seg} 节点#${i}`;
    const tag = r.tag(nodeSeg);
    if (tag === TAG_T || tag === TAG_A) {
      const idx = r.u32(nodeSeg);
      if (idx >= strings.length) throw new LcpError(`字符串下标 ${idx} 越界`, nodeSeg);
      nodes[i] = [tag, strings[idx]];
    } else if (tag === TAG_R) {
      const keyIdx = r.u32(nodeSeg);
      if (keyIdx >= strings.length) throw new LcpError(`引用键字符串下标 ${keyIdx} 越界`, nodeSeg);
      const mapCount = r.u32(nodeSeg);
      const mapping = {};
      let prevTo = null;
      for (let m = 0; m < mapCount; m++) {
        const toIdx = r.u32(nodeSeg);
        const fromIdx = r.u32(nodeSeg);
        if (toIdx >= strings.length || fromIdx >= strings.length) {
          throw new LcpError('参数映射字符串下标越界', nodeSeg);
        }
        const to = strings[toIdx];
        if (prevTo !== null && compareBytes(encodeUtf8(prevTo), encodeUtf8(to)) >= 0) {
          throw new LcpError('r 映射未按目标参数名的 UTF-8 字节升序排列', nodeSeg);
        }
        prevTo = to;
        mapping[to] = strings[fromIdx];
      }
      nodes[i] = [TAG_R, strings[keyIdx], mapping];
    } else if (tag === TAG_P) {
      const paramIdx = r.u32(nodeSeg);
      if (paramIdx >= strings.length) throw new LcpError(`p 参数字符串下标 ${paramIdx} 越界`, nodeSeg);
      const branchCount = r.u32(nodeSeg);
      const branches = {};
      let prevName = null;
      for (let bn = 0; bn < branchCount; bn++) {
        const nameIdx = r.u32(nodeSeg);
        if (nameIdx >= strings.length) throw new LcpError(`分支名字符串下标 ${nameIdx} 越界`, nodeSeg);
        const name = strings[nameIdx];
        if (prevName !== null && compareBytes(encodeUtf8(prevName), encodeUtf8(name)) >= 0) {
          throw new LcpError('p 分支未按分支名的 UTF-8 字节升序排列', nodeSeg);
        }
        prevName = name;
        branches[name] = readNodes(r, strings, `${nodeSeg} 分支 ${JSON.stringify(name)}`);
      }
      if (!('other' in branches)) throw new LcpError('p 节点缺少 other 分支', nodeSeg);
      nodes[i] = [TAG_P, strings[paramIdx], branches];
    } else {
      throw new LcpError(
        `非法节点标签 0x${(r.b[r.off - 1] ?? 0).toString(16)}（只允许 t/a/r/p）`,
        nodeSeg,
      );
    }
  }
  return nodes;
}

// 解析二进制包并重建工程对象；随后运行与导入相同的全套检查
export function readPack(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new LcpError('读包输入必须是 Uint8Array', '包');
  }
  const r = new ByteReader(bytes);

  // 魔数
  const magic = [];
  for (let i = 0; i < 4; i++) magic.push(r.tag('魔数'));
  if (magic.join('') !== 'LCP1') {
    throw new LcpError(`魔数不是 LCP1（得到 ${magic.join('')}）`, '魔数');
  }

  // 末尾 CRC-32
  if (bytes.length < 8) throw new LcpError('包长度不足，缺少字符串表与 CRC', '包');
  const storedCrc = new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.length - 4,
    4,
  ).getUint32(0, true);
  const actualCrc = crc32(bytes.subarray(0, bytes.length - 4));
  if (storedCrc !== actualCrc) {
    throw new LcpError(
      `CRC-32 不匹配：包内 0x${storedCrc.toString(16).padStart(8, '0')}，实算 0x${actualCrc
        .toString(16)
        .padStart(8, '0')}`,
      '末尾CRC',
    );
  }
  const bodyEnd = bytes.length - 4;

  // 字符串表：不重复且按字节严格升序
  const stringCount = r.u32('字符串表');
  const strings = new Array(stringCount);
  let prevBytes = null;
  for (let i = 0; i < stringCount; i++) {
    const seg = `字符串表#${i}`;
    const len = r.u32(seg);
    const raw = r.raw(len, seg);
    let s;
    try {
      s = decodeUtf8(raw);
    } catch (e) {
      throw new LcpError(e.message, seg);
    }
    const b = Uint8Array.from(raw);
    if (prevBytes !== null && compareBytes(prevBytes, b) >= 0) {
      throw new LcpError('字符串表必须不重复且按 UTF-8 字节严格升序', seg);
    }
    prevBytes = b;
    strings[i] = s;
  }
  const idx = (x, seg) => {
    if (x >= strings.length) throw new LcpError(`字符串下标 ${x} 越界`, seg);
    return strings[x];
  };

  // 签名表：按键字节排序
  const sigCount = r.u32('签名表');
  const signatures = {};
  let prevKey = null;
  for (let i = 0; i < sigCount; i++) {
    const seg = `签名表#${i}`;
    const key = idx(r.u32(seg), seg);
    if (prevKey !== null && compareBytes(encodeUtf8(prevKey), encodeUtf8(key)) >= 0) {
      throw new LcpError('签名表未按键的 UTF-8 字节升序排列', seg);
    }
    prevKey = key;
    const paramCount = r.u32(seg);
    const params = {};
    let prevParam = null;
    for (let p = 0; p < paramCount; p++) {
      const name = idx(r.u32(seg), seg);
      const type = idx(r.u32(seg), seg);
      if (type !== 's' && type !== 'i') {
        throw new LcpError(`参数类型串必须是 "s" 或 "i"，得到 ${JSON.stringify(type)}`, seg);
      }
      if (prevParam !== null && compareBytes(encodeUtf8(prevParam), encodeUtf8(name)) >= 0) {
        throw new LcpError('签名参数未按名的 UTF-8 字节升序排列', seg);
      }
      prevParam = name;
      params[name] = type;
    }
    signatures[key] = params;
  }

  // 语言模式表
  const modeCount = r.u32('语言模式表');
  const localeModes = {};
  const langOrder = [];
  let prevLang = null;
  for (let i = 0; i < modeCount; i++) {
    const seg = `语言模式表#${i}`;
    const lang = idx(r.u32(seg), seg);
    if (prevLang !== null && compareBytes(encodeUtf8(prevLang), encodeUtf8(lang)) >= 0) {
      throw new LcpError('语言模式表未按语言的 UTF-8 字节升序排列', seg);
    }
    prevLang = lang;
    const mode = idx(r.u32(seg), seg);
    if (mode !== 'one' && mode !== 'other') {
      throw new LcpError(`语言模式必须是 one/other，得到 ${JSON.stringify(mode)}`, seg);
    }
    localeModes[lang] = mode;
    langOrder.push(lang);
  }

  // 回退表
  const fbCount = r.u32('回退表');
  if (fbCount !== modeCount) {
    throw new LcpError(`回退表记录数 ${fbCount} 与语言数 ${modeCount} 不一致`, '回退表');
  }
  const fallback = {};
  prevLang = null;
  for (let i = 0; i < fbCount; i++) {
    const seg = `回退表#${i}`;
    const lang = idx(r.u32(seg), seg);
    if (prevLang !== null && compareBytes(encodeUtf8(prevLang), encodeUtf8(lang)) >= 0) {
      throw new LcpError('回退表未按语言的 UTF-8 字节升序排列', seg);
    }
    prevLang = lang;
    const nextIdx = r.u32(seg);
    fallback[lang] = nextIdx === NULL_INDEX ? null : idx(nextIdx, seg);
  }

  // 消息表：先按语言再按键
  const msgCount = r.u32('消息表');
  const catalog = {};
  for (const lang of langOrder) catalog[lang] = {};
  let prevLK = null;
  for (let i = 0; i < msgCount; i++) {
    const seg = `消息表#${i}`;
    const lang = idx(r.u32(seg), seg);
    const key = idx(r.u32(seg), seg);
    if (prevLK !== null && compareLangKey(prevLK.lang, prevLK.key, lang, key) >= 0) {
      throw new LcpError('消息表未按语言再按键的 UTF-8 字节升序排列', seg);
    }
    prevLK = { lang, key };
    if (!(lang in catalog)) {
      throw new LcpError(`消息表出现语言模式表未声明的语言 ${JSON.stringify(lang)}`, seg);
    }
    if (key in catalog[lang]) throw new LcpError(`消息表存在重复记录 ${lang}/${key}`, seg);
    catalog[lang][key] = readNodes(r, strings, seg);
  }

  if (r.off !== bodyEnd) {
    throw new LcpError(`包尾有多余字节（解析到偏移 ${r.off}，CRC 起始于 ${bodyEnd}）`, '包尾');
  }

  // 重建工程并按同一套工程约定做语义检查
  const project = { signatures, localeModes, fallback, catalog, languages: langOrder };
  const errors = checkProject(project);
  if (errors.length > 0) {
    throw new LcpError(
      `读包语义检查失败：${errors.map((e) => e.toString()).join('；')}`,
      '语义检查',
    );
  }
  return project;
}
