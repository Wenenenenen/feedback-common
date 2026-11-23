// 消息节点解析与结构规范化（自研，不使用任何现成消息格式化库）。
// 节点形态：
//   ["t", 文本]            文本
//   ["a", 参数名]          参数替换
//   ["r", 键, 参数映射]    引用另一条消息；映射为 { 目标参数名: 本消息参数名 }
//   ["p", 整数参数, 分支]  复数/精确分支；分支键 "one" | "other" | "=整数"，other 必填
import { LcpError } from './errors.js';

export const TAG_T = 't';
export const TAG_A = 'a';
export const TAG_R = 'r';
export const TAG_P = 'p';

export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;
export const NULL_INDEX = 4294967295; // 2^32-1，空回退标记

const TAGS = new Set([TAG_T, TAG_A, TAG_R, TAG_P]);

// 规范十进制：可选负号 + 数字，无前导零（"0" 本身除外），无 "-0"
export function canonicalDecimal(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  const digits = s[0] === '-' ? s.slice(1) : s;
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length > 1 && digits[0] === '0') return null; // 同时排除 "00" 与 "-0"
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < INT32_MIN || n > INT32_MAX) return null;
  return n;
}

function isNonEmptyString(x) {
  return typeof x === 'string' && x.length > 0;
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// 分支名校验，返回规范化信息；非法则抛错
export function validateBranchName(name, where) {
  if (name === 'one' || name === 'other') return { kind: name };
  if (name[0] === '=') {
    const n = canonicalDecimal(name.slice(1));
    if (n === null) {
      throw new LcpError(`分支键 ${JSON.stringify(name)} 不是合法的规范 int32 十进制`, where);
    }
    return { kind: 'exact', value: n };
  }
  throw new LcpError(
    `分支键 ${JSON.stringify(name)} 非法（只允许 "one"、"other" 或 "=整数"）`,
    where,
  );
}

function parseNode(node, where) {
  if (!Array.isArray(node)) {
    throw new LcpError('节点必须是数组', where);
  }
  const tag = node[0];
  if (!TAGS.has(tag)) {
    throw new LcpError(`未知节点标签 ${JSON.stringify(tag)}（只允许 t/a/r/p）`, where);
  }
  if (tag === TAG_T) {
    if (node.length !== 2 || typeof node[1] !== 'string') {
      throw new LcpError('t 节点必须是 ["t", 文本字符串]', where);
    }
    return [TAG_T, node[1]];
  }
  if (tag === TAG_A) {
    if (node.length !== 2 || !isNonEmptyString(node[1])) {
      throw new LcpError('a 节点必须是 ["a", 非空参数名]', where);
    }
    return [TAG_A, node[1]];
  }
  if (tag === TAG_R) {
    if (node.length !== 3 || !isNonEmptyString(node[1]) || !isPlainObject(node[2])) {
      throw new LcpError('r 节点必须是 ["r", 非空键, 参数映射对象]', where);
    }
    const mapping = {};
    for (const [to, from] of Object.entries(node[2])) {
      if (!isNonEmptyString(to) || !isNonEmptyString(from)) {
        throw new LcpError('r 的参数映射必须是非空字符串之间的映射', where);
      }
      mapping[to] = from;
    }
    return [TAG_R, node[1], mapping];
  }
  // tag === TAG_P
  if (node.length !== 3 || !isNonEmptyString(node[1]) || !isPlainObject(node[2])) {
    throw new LcpError('p 节点必须是 ["p", 非空整数参数名, 分支对象]', where);
  }
  const branches = {};
  for (const [name, body] of Object.entries(node[2])) {
    const bw = `${where} 分支 ${JSON.stringify(name)}`;
    validateBranchName(name, bw);
    if (!Array.isArray(body) || body.length === 0) {
      throw new LcpError('p 分支内容必须是非空节点数组', bw);
    }
    branches[name] = parseNodes(body, bw);
  }
  if (!('other' in branches)) {
    throw new LcpError('p 节点缺少必填的 "other" 分支', where);
  }
  return [TAG_P, node[1], branches];
}

export function parseNodes(nodes, where = '消息') {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new LcpError('消息必须是非空节点数组', where);
  }
  return nodes.map((n, i) => parseNode(n, `${where} 节点#${i}`));
}
