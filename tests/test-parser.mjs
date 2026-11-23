// 消息解析与工程校验测试
import { ok, eq, throws, noThrow, group } from './harness.mjs';
import { canonicalDecimal, parseNodes } from '../web/src/parser.js';
import { normalizeProject, checkProject, validateProject } from '../web/src/project.js';
import { LcpError } from '../web/src/errors.js';

const valid = {
  signatures: { count: { n: 'i' }, greet: { n: 'i', name: 's' } },
  localeModes: { en: 'one', zh: 'other' },
  fallback: { en: null, zh: 'en' },
  catalog: {
    en: {
      count: [['p', 'n', { one: [['t', 'one lamp']], other: [['a', 'n'], ['t', ' lamps']] }]],
      greet: [['t', 'Found '], ['r', 'count', { n: 'n' }], ['t', ' for '], ['a', 'name']],
    },
    zh: { count: [['a', 'n'], ['t', '盏灯']] },
  },
};

group('规范十进制', () => {
  eq(canonicalDecimal('0'), 0, '0 合法');
  eq(canonicalDecimal('1'), 1, '1 合法');
  eq(canonicalDecimal('-1'), -1, '-1 合法');
  eq(canonicalDecimal('2147483647'), 2147483647, 'int32 上限');
  eq(canonicalDecimal('-2147483648'), -2147483648, 'int32 下限');
  ok(canonicalDecimal('00') === null, '前导零非法');
  ok(canonicalDecimal('01') === null, '前导零非法 01');
  eq(canonicalDecimal('-0'), 0, '负零数值合法（分支键 =-0 另由分支规则拒绝）');
  ok(canonicalDecimal('1.0') === null, '小数非法');
  ok(canonicalDecimal('2147483648') === null, '超上限非法');
  ok(canonicalDecimal('abc') === null, '非数字非法');
});

group('节点解析', () => {
  noThrow(() => parseNodes([['t', 'x']]), 't 节点');
  noThrow(() => parseNodes([['a', 'n']]), 'a 节点');
  noThrow(() => parseNodes([['r', 'k', { a: 'b' }]]), 'r 节点');
  noThrow(
    () => parseNodes([['p', 'n', { '=1': [['t', 'x']], other: [['t', 'y']] }]]),
    'p 精确+other',
  );
  throws(() => parseNodes([['x', 'y']]), '未知节点标签', '未知标签被拒');
  throws(() => parseNodes([['t', 1]]), 't 节点', 't 非字符串被拒');
  throws(() => parseNodes([['p', 'n', { one: [['t', 'x']] }]]), 'other', '缺 other 被拒');
  throws(
    () => parseNodes([['p', 'n', { '=01': [['t', 'x']], other: [['t', 'y']] }]]),
    '规范',
    '非规范分支键被拒',
  );
  throws(
    () => parseNodes([['p', 'n', { '=99999999999999999999': [['t', 'x']], other: [['t', 'y']] }]]),
    'int32',
    '超 int32 分支键被拒',
  );
  throws(() => parseNodes([]), '非空', '空消息被拒');
});

group('规范化与限额', () => {
  const p = normalizeProject(valid);
  eq(p.languages, ['en', 'zh'], '语言按字节排序');
  eq(p.localeModes, { en: 'one', zh: 'other' }, '模式保留');
  eq(p.fallback, { en: null, zh: 'en' }, '回退保留');

  const tooMany = JSON.parse(JSON.stringify(valid));
  const langs = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'];
  tooMany.catalog = {};
  tooMany.localeModes = {};
  tooMany.fallback = {};
  for (const l of langs) {
    tooMany.catalog[l] = { count: [['t', 'x']] };
    tooMany.localeModes[l] = 'other';
    tooMany.fallback[l] = null;
  }
  throws(() => normalizeProject(tooMany), '上限 8', '9 种语言被拒');

  const tooManyMsg = JSON.parse(JSON.stringify(valid));
  tooManyMsg.catalog.en = {};
  for (let i = 0; i < 20001; i++) tooManyMsg.catalog.en[`k${i}`] = [['t', 'x']];
  throws(() => normalizeProject(tooManyMsg), '上限 20000', '单语言 20001 条被拒');
});

group('回退链', () => {
  const cyclic = JSON.parse(JSON.stringify(valid));
  cyclic.fallback = { en: 'zh', zh: 'en' };
  throws(() => normalizeProject(cyclic), '回退链成环', '回退环被拒');
  const unknown = JSON.parse(JSON.stringify(valid));
  unknown.fallback.zh = 'fr';
  throws(() => normalizeProject(unknown), '未知语言', '回退到未知语言被拒');
  const missingFb = JSON.parse(JSON.stringify(valid));
  delete missingFb.fallback.zh;
  throws(() => normalizeProject(missingFb), 'fallback', '缺回退条目被拒');
});

group('发布检查：缺项报请求语言与路径', () => {
  // greet 是公共键；fr 与它的链尾（null）都没有 greet => 必须报缺项
  const gap = JSON.parse(JSON.stringify(valid));
  gap.catalog.fr = { count: [['t', 'fr only']] };
  gap.localeModes.fr = 'one';
  gap.fallback.fr = null;
  const { project, errors } = validateProject(gap);
  ok(project !== undefined, '工程可规范化');
  const greetErr = errors.find((e) => e.toString().includes('greet') && e.toString().includes('fr'));
  ok(!!greetErr, 'fr 缺公共键 greet 被报出');
  ok(greetErr.toString().includes('fr'), '报出请求语言 fr');
  ok(greetErr.segment.includes('fr'), '坏段含请求语言');
});

group('发布检查：引用问题', () => {
  // r 指向不存在的键：ghost 在 catalog 中作为消息键存在（故有签名检查外形），
  // 但 r 目标无签名时由 checkProject 报出
  const badRef = JSON.parse(JSON.stringify(valid));
  badRef.signatures.ghost = {};
  badRef.catalog.en.ghost = [['t', 'x']];
  delete badRef.signatures.ghost; // 保留 catalog 消息键、删签名 -> 规范化先拒
  throws(() => normalizeProject(badRef), 'signatures', 'catalog 消息键无签名在规范化即拒');

  // r 目标键在任何语言的链上都不可达
  const dangling = JSON.parse(JSON.stringify(valid));
  dangling.signatures.ghost = {};
  dangling.catalog.en.greet = [['r', 'ghost', {}]];
  let errs0 = checkProject(normalizeProject(dangling));
  ok(errs0.some((e) => e.message.includes('ghost')), 'r 引用不可达键被报');

  // r 参数集合不匹配
  const mismatch = JSON.parse(JSON.stringify(valid));
  mismatch.catalog.en.greet = [['r', 'count', { n: 'n', extra: 'name' }]];
  let errs = checkProject(normalizeProject(mismatch));
  ok(errs.some((e) => e.message.includes('参数集合')), '参数集合不匹配被报');

  // r 类型不匹配
  const typeBad = JSON.parse(JSON.stringify(valid));
  typeBad.signatures.count = { n: 's' }; // count.n 改成 s，而 greet.n 是 i
  errs = checkProject(normalizeProject(typeBad));
  ok(errs.some((e) => e.message.includes('类型不匹配')), '参数类型不匹配被报');

  // 引用环 A -> B -> A
  const cyc = {
    signatures: { A: {}, B: {} },
    localeModes: { en: 'other' },
    fallback: { en: null },
    catalog: { en: { A: [['r', 'B', {}]], B: [['r', 'A', {}]] } },
  };
  errs = checkProject(normalizeProject(cyc));
  ok(errs.some((e) => e.message.includes('引用环')), '引用环被报');
  const cycErr = errs.find((e) => e.message.includes('引用环'));
  ok(cycErr.toString().includes('en'), '引用环报请求语言');
  ok(cycErr.segment.includes('A') && cycErr.segment.includes('B'), '引用环报引用路径');

  // 隐藏在 p 分支里的环也要抓到
  const hidden = {
    signatures: { A: { n: 'i' }, B: {} },
    localeModes: { en: 'other' },
    fallback: { en: null },
    catalog: {
      en: {
        A: [['p', 'n', { other: [['r', 'B', {}]] }]],
        B: [['r', 'A', {}]],
      },
    },
  };
  errs = checkProject(normalizeProject(hidden));
  ok(errs.some((e) => e.message.includes('引用环')), 'p 分支内隐藏引用环被报');
});

group('发布检查：p 参数必须 i', () => {
  const bad = {
    signatures: { A: { n: 's' } },
    localeModes: { en: 'other' },
    fallback: { en: null },
    catalog: { en: { A: [['p', 'n', { other: [['t', 'x']] }]] } },
  };
  const errs = checkProject(normalizeProject(bad));
  ok(errs.some((e) => e.message.includes('必须是 i')), 'p 用 s 参数被报');
});

group('合法工程检查通过', () => {
  eq(checkProject(normalizeProject(valid)).length, 0, '样例工程零错误');
  const err = new LcpError('x', '段');
  ok(err.toString().includes('[段]'), 'LcpError 带段前缀');
});
