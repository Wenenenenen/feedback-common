// 性能测试：8 种语言各 20000 条由短文本或单次引用组成的工程，导出（编译）须在 8 秒内。
// 同时测量读包与全量检查耗时，校验往返一致。
import { normalizeProject, checkProject } from '../web/src/project.js';
import { compileProject } from '../web/src/lcp1-compile.js';
import { readPack } from '../web/src/lcp1-read.js';
import { expandMessage } from '../web/src/resolver.js';

const LOCALES = ['en', 'zh', 'ja', 'fr', 'de', 'es', 'ru', 'ko'];
const N = 20000;
const BUDGET_MS = 8000;

function buildProject() {
  const signatures = {};
  for (let i = 0; i < N - 1; i++) {
    // 一半带整数参数，一半带字符串参数
    signatures[`msg_${i}`] = i % 2 === 0 ? { n: 'i' } : { name: 's' };
  }
  signatures.ref_target = { n: 'i' }; // 占最后一个名额，每语言恰为 20000 条

  const localeModes = {};
  const fallback = {};
  const catalog = {};
  LOCALES.forEach((lang, li) => {
    localeModes[lang] = li % 2 === 0 ? 'one' : 'other';
    fallback[lang] = li === 0 ? null : LOCALES[li - 1];
    const table = {};
    for (let i = 0; i < N - 1; i++) {
      const key = `msg_${i}`;
      if (i % 50 === 7) {
        // 单次引用（参数映射类型匹配）
        table[key] =
          i % 2 === 0
            ? [['t', `[${lang}] `], ['r', 'ref_target', { n: 'n' }]]
            : [['t', `[${lang}] `], ['a', 'name']];
      } else if (i % 2 === 0) {
        // 短文本 + 参数替换 + 简单复数
        table[key] = [
          ['t', `[${lang}] item `],
          ['a', 'n'],
          ['p', 'n', { one: [['t', ' unit']], other: [['t', ' units']] }],
        ];
      } else {
        table[key] = [['t', `[${lang}] hello `], ['a', 'name']];
      }
    }
    table.ref_target = [['t', `[${lang}] target `], ['a', 'n']];
    catalog[lang] = table;
  });
  return { signatures, localeModes, fallback, catalog };
}

const raw = buildProject();
const totalMessages = LOCALES.length * N;
console.log(`工程规模：${LOCALES.length} 语言 × ${N} 条 = ${totalMessages} 条消息`);

let t0 = performance.now();
const project = normalizeProject(raw);
let t1 = performance.now();
console.log(`规范化（含消息解析）：${(t1 - t0).toFixed(0)} ms`);

t0 = performance.now();
const checkErrors = checkProject(project);
t1 = performance.now();
console.log(`全量发布检查（缺项/签名/引用环/可达分支）：${(t1 - t0).toFixed(0)} ms，错误 ${checkErrors.length} 条`);
if (checkErrors.length > 0) {
  console.error(checkErrors.slice(0, 5).map((e) => e.toString()));
  process.exit(1);
}

t0 = performance.now();
const bin = compileProject(project);
t1 = performance.now();
const compileMs = t1 - t0;
console.log(`LCP1 导出：${compileMs.toFixed(0)} ms，包大小 ${(bin.length / 1024 / 1024).toFixed(2)} MiB`);

t0 = performance.now();
const back = readPack(bin);
t1 = performance.now();
console.log(`读包：${(t1 - t0).toFixed(0)} ms`);

const bin2 = compileProject(back);
const same = bin.length === bin2.length && bin.every((v, i) => v === bin2[i]);
console.log(`读包后重编译逐字节一致：${same ? '是' : '否'}`);

// 运行时抽查：请求语言在链尾，引用需重新查链
const sample = expandMessage(project, 'ko', 'msg_10', { n: 3, name: 'x' });
console.log(`预览展开抽查（ko/msg_10）：${JSON.stringify(sample.text)}，命中 ${sample.hitLang}`);

// 确定性：连续三次编译字节一致
const c1 = compileProject(project);
const c2 = compileProject(project);
const deterministic = c1.length === c2.length && c1.every((v, i) => v === c2[i]);
console.log(`重复编译确定性：${deterministic ? '通过' : '失败'}`);

if (compileMs > BUDGET_MS) {
  console.error(`❌ 导出耗时 ${compileMs.toFixed(0)} ms 超过 ${BUDGET_MS} ms 预算`);
  process.exit(1);
}
if (!same || !deterministic) {
  process.exit(1);
}
console.log(`✅ 性能达标（预算 ${BUDGET_MS} ms）`);
