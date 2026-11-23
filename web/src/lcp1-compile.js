// LCP1 编译器（自研，不使用任何语言包编译库）。
// 布局：ASCII "LCP1" | 字符串表 | 签名表 | 语言模式表 | 回退表 | 消息表 | CRC32(全前文)
// 所有长度/数量/下标/CRC 均为 4 字节无符号小端；空回退下标 4294967295。
import { crc32 } from './crc32.js';
import { encodeUtf8, compareBytes } from './utf8.js';
import { TAG_T, TAG_A, TAG_R, TAG_P, NULL_INDEX } from './parser.js';
import { utf8SortedKeys } from './project.js';

export const MAGIC = 0x3150434c; // "LCP1" 的小端解释（字节序为 L C P 1）

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  u8(v) {
    const b = new Uint8Array(1);
    b[0] = v;
    this.chunks.push(b);
    this.length += 1;
  }
  tag(ch) {
    this.u8(ch.charCodeAt(0));
  }
  u32(v) {
    const b = new ArrayBuffer(4);
    new DataView(b).setUint32(0, v >>> 0, true);
    this.chunks.push(new Uint8Array(b));
    this.length += 4;
  }
  bytes(arr) {
    this.chunks.push(arr);
    this.length += arr.length;
  }
  finish() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

// 收集所有实际引用的字符串，去重并按 UTF-8 字节升序排列，返回 { list, index }
function buildStringTable(project) {
  const set = new Set();
  const add = (s) => set.add(s);
  add('s');
  add('i');

  for (const key of utf8SortedKeys(project.signatures)) {
    add(key);
    for (const p of utf8SortedKeys(project.signatures[key])) {
      add(p);
      add(project.signatures[key][p]);
    }
  }
  for (const lang of project.languages) {
    add(lang);
    add(project.localeModes[lang]);
    if (project.fallback[lang] !== null) add(project.fallback[lang]);
  }
  const collectNodes = (nodes) => {
    for (const node of nodes) {
      if (node[0] === TAG_T) {
        add(node[1]);
      } else if (node[0] === TAG_A) {
        add(node[1]);
      } else if (node[0] === TAG_R) {
        add(node[1]);
        for (const to of utf8SortedKeys(node[2])) {
          add(to);
          add(node[2][to]);
        }
      } else if (node[0] === TAG_P) {
        add(node[1]);
        for (const name of utf8SortedKeys(node[2])) {
          add(name);
          collectNodes(node[2][name]);
        }
      }
    }
  };
  for (const lang of project.languages) {
    for (const key of utf8SortedKeys(project.catalog[lang])) {
      add(key);
      collectNodes(project.catalog[lang][key]);
    }
  }

  const list = [...set].sort((x, y) => compareBytes(encodeUtf8(x), encodeUtf8(y)));
  const index = new Map();
  list.forEach((s, i) => index.set(s, i));
  return { list, index };
}

function writeNodes(w, nodes, strIndex) {
  w.u32(nodes.length);
  for (const node of nodes) {
    const tag = node[0];
    w.tag(tag);
    if (tag === TAG_T || tag === TAG_A) {
      w.u32(strIndex.get(node[1]));
    } else if (tag === TAG_R) {
      w.u32(strIndex.get(node[1]));
      const mapping = node[2];
      const names = utf8SortedKeys(mapping); // 映射按目标参数名字节排序
      w.u32(names.length);
      for (const to of names) {
        w.u32(strIndex.get(to));
        w.u32(strIndex.get(mapping[to]));
      }
    } else if (tag === TAG_P) {
      w.u32(strIndex.get(node[1]));
      const branches = node[2];
      const names = utf8SortedKeys(branches); // 分支按分支名字节排序
      w.u32(names.length);
      for (const name of names) {
        w.u32(strIndex.get(name));
        writeNodes(w, branches[name], strIndex);
      }
    }
  }
}

// 编译已通过 checkProject 的规范化工程，返回 Uint8Array
export function compileProject(project) {
  const { list: strings, index: strIndex } = buildStringTable(project);
  const w = new ByteWriter();

  // 魔数（逐字节写 L C P 1，保证 ASCII 字节序）
  w.tag('L');
  w.tag('C');
  w.tag('P');
  w.tag('1');

  // 字符串表：数量，然后每项 UTF-8 长度 + 原字节
  w.u32(strings.length);
  for (const s of strings) {
    const b = encodeUtf8(s);
    w.u32(b.length);
    w.bytes(b);
  }

  // 签名表：按键字节排序
  const sigKeys = utf8SortedKeys(project.signatures);
  w.u32(sigKeys.length);
  for (const key of sigKeys) {
    w.u32(strIndex.get(key));
    const params = project.signatures[key];
    const names = utf8SortedKeys(params); // 参数按名字节排序
    w.u32(names.length);
    for (const p of names) {
      w.u32(strIndex.get(p));
      w.u32(strIndex.get(params[p]));
    }
  }

  // 语言模式表：按语言字节排序
  w.u32(project.languages.length);
  for (const lang of project.languages) {
    w.u32(strIndex.get(lang));
    w.u32(strIndex.get(project.localeModes[lang]));
  }

  // 回退表：按语言字节排序；空回退写 NULL_INDEX
  w.u32(project.languages.length);
  for (const lang of project.languages) {
    w.u32(strIndex.get(lang));
    const next = project.fallback[lang];
    w.u32(next === null ? NULL_INDEX : strIndex.get(next));
  }

  // 消息表：先按语言再按键，均为字节排序
  let messageCount = 0;
  for (const lang of project.languages) messageCount += Object.keys(project.catalog[lang]).length;
  w.u32(messageCount);
  for (const lang of project.languages) {
    for (const key of utf8SortedKeys(project.catalog[lang])) {
      w.u32(strIndex.get(lang));
      w.u32(strIndex.get(key));
      writeNodes(w, project.catalog[lang][key], strIndex);
    }
  }

  const body = w.finish();
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  new DataView(out.buffer).setUint32(body.length, crc32(body), true);
  return out;
}
