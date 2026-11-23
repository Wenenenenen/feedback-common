// 运行时展开测试：回退链重查、命中语言决定复数、精确分支优先、码点守卫
import { ok, eq, throws, group } from './harness.mjs';
import { normalizeProject } from '../web/src/project.js';
import { expandMessage, selectBranch, MAX_CODE_POINTS } from '../web/src/resolver.js';

const project = normalizeProject({
  signatures: { count: { n: 'i' }, greet: { n: 'i', name: 's' }, self: { n: 'i' } },
  localeModes: { en: 'one', ru: 'one', zh: 'other' },
  fallback: { en: null, ru: 'en', zh: 'ru' },
  catalog: {
    en: {
      count: [
        [
          'p',
          'n',
          {
            '=0': [['t', 'no lamps']],
            one: [['t', 'one lamp']],
            other: [['a', 'n'], ['t', ' lamps']],
          },
        ],
      ],
      greet: [['t', 'Hi '], ['a', 'name'], ['t', ' '], ['r', 'count', { n: 'n' }]],
    },
    ru: {
      greet: [['t', 'Привет '], ['a', 'name'], ['t', ' '], ['r', 'count', { n: 'n' }]],
    },
    zh: { count: [['a', 'n'], ['t', '盏灯']] },
  },
});

group('回退链查找', () => {
  // zh 没有 greet -> ru 有 greet（含对 count 的引用），命中 ru
  const r1 = expandMessage(project, 'zh', 'greet', { n: 1, name: '旺达' });
  eq(r1.hitLang, 'ru', 'zh 的 greet 命中 ru');
  eq(r1.text, 'Привет 旺达 1盏灯', '命中译文正确（引用按 zh 链解析）');
  eq(r1.chain, ['zh', 'ru', 'en'], '链包含全部回退路径');

  // zh 的 count 自身有，命中 zh
  const r2 = expandMessage(project, 'zh', 'count', { n: 3 });
  eq(r2.hitLang, 'zh', 'zh 的 count 命中本地');
  eq(r2.text, '3盏灯', '本地译文展开');
});

group('每次引用从请求语言重新查链', () => {
  // 请求 zh 的 greet（命中 ru），其内部 r count 必须重新从 zh 查 -> 命中 zh 而非 ru/en
  const r = expandMessage(project, 'zh', 'greet', { n: 3, name: '旺达' });
  eq(r.hitLang, 'ru', '根消息命中 ru');
  const refTrace = r.trace.find((t) => t.kind === 'r');
  eq(refTrace.hitLang, 'zh', '引用 count 重新从 zh 查链，命中 zh');
  eq(r.text, 'Привет 旺达 3盏灯', '引用的是 zh 译文而非 en 旧版');
});

group('复数按命中译文语言的模式', () => {
  // en 是 one 模式：1 -> one
  eq(expandMessage(project, 'en', 'count', { n: 1 }).text, 'one lamp', 'en n=1 走 one');
  // n=2 -> other
  eq(expandMessage(project, 'en', 'count', { n: 2 }).text, '2 lamps', 'en n=2 走 other');
  // n=0 精确分支优先（即使 one 模式）
  eq(expandMessage(project, 'en', 'count', { n: 0 }).text, 'no lamps', '精确 =0 优先');
  // zh 是 other 模式：n=1 也走 other
  eq(expandMessage(project, 'zh', 'count', { n: 1 }).text, '1盏灯', 'other 模式 1 仍走 other');

  // selectBranch 单元
  eq(selectBranch(['one', 'other', '=5'], 5, 'one'), '=5', '精确分支优先于 one');
  eq(selectBranch(['one', 'other'], 1, 'one'), 'one', 'one 模式 1 选 one');
  eq(selectBranch(['one', 'other'], 1, 'other'), 'other', 'other 模式 1 选 other');
  eq(selectBranch(['one', 'other'], 2, 'one'), 'other', '其余一律 other');
  // 选 one 但 one 不存在 -> other
  eq(selectBranch(['other'], 1, 'one'), 'other', 'one 缺失回退 other');
});

group('参数与类型', () => {
  eq(expandMessage(project, 'en', 'greet', { n: 1, name: '旺达' }).text, 'Hi 旺达 one lamp', '字符串参数');
  throws(() => expandMessage(project, 'en', 'count', { n: '1' }), 'int32', '字符串传给 i 参数被拒');
  throws(() => expandMessage(project, 'en', 'count', {}), '缺失', '缺参数报错');
  throws(() => expandMessage(project, 'en', 'ghost', {}), '全部缺失', '缺失消息报错');
});

group('引用环运行时拦截', () => {
  const cyc = normalizeProject({
    signatures: { A: {}, B: {} },
    localeModes: { en: 'other' },
    fallback: { en: null },
    catalog: { en: { A: [['r', 'B', {}]], B: [['r', 'A', {}]] } },
  });
  throws(() => expandMessage(cyc, 'en', 'A', {}), '引用环', '运行时引用环抛错');
});

group('1 万码点守卫报消息键', () => {
  const big = normalizeProject({
    signatures: { A: {} },
    localeModes: { en: 'other' },
    fallback: { en: null },
    catalog: { en: { A: [['t', 'a'.repeat(9000)], ['t', 'b'.repeat(2000)]] } },
  });
  const err = (() => {
    try {
      expandMessage(big, 'en', 'A', {});
      return null;
    } catch (e) {
      return e;
    }
  })();
  ok(!!err, '超 1 万码点抛错');
  ok(err.message.includes('A'), `报出消息键 A：${err.message}`);
  ok(err.message.includes(String(MAX_CODE_POINTS)), '报出阈值');

  // 恰好 10000 不报错
  const edge = normalizeProject({
    signatures: { A: {} },
    localeModes: { en: 'other' },
    fallback: { en: null },
    catalog: { en: { A: [['t', 'a'.repeat(10000)]] } },
  });
  eq(expandMessage(edge, 'en', 'A', {}).codePoints, 10000, '恰好 10000 码点通过');

  // emoji 按码点而非 UTF-16 单元计数：10001 个 emoji = 20002 UTF-16 单元、10001 码点 => 超限
  const emoji = normalizeProject({
    signatures: { A: {} },
    localeModes: { en: 'other' },
    fallback: { en: null },
    catalog: { en: { A: [['t', '😀'.repeat(10001)]] } },
  });
  const e2 = (() => {
    try {
      expandMessage(emoji, 'en', 'A', {});
      return null;
    } catch (e) {
      return e;
    }
  })();
  ok(!!e2 && e2.message.includes('A'), '10001 个 emoji（20002 UTF-16 单元）按码点超限并报键');
});
