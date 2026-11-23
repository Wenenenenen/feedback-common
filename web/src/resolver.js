// 运行时消息展开（预览用），自研实现，不使用现成消息格式化库。
// 规则：
//   - 每次 r 引用都从玩家请求的语言重新按回退链查找；
//   - p 的复数标签按实际命中译文的语言模式（localeModes）计算；
//   - 精确整数分支 "=n" 优先，其次 one/other；other 兜底；
//   - 单条展开超过 10000 个 Unicode 码点时抛错并报出消息键。
import { LcpError } from './errors.js';
import { TAG_T, TAG_A, TAG_R, TAG_P, INT32_MIN, INT32_MAX, canonicalDecimal } from './parser.js';
import { lookupMessage, fallbackChain } from './project.js';
import { countCodePoints } from './utf8.js';

export const MAX_CODE_POINTS = 10000;

// 按命中语言的模式选择分支：精确整数优先，one 模式下 1 => one，其余 other
export function selectBranch(branchNames, value, localeMode) {
  const exact = `=${value}`;
  if (branchNames.includes(exact)) return exact;
  if (localeMode === 'one' && value === 1 && branchNames.includes('one')) return 'one';
  return 'other'; // 规范化已保证 other 必存在
}

function validateInt(value, where) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    throw new LcpError(`${where} 需要 int32 整数参数，得到 ${JSON.stringify(value)}`);
  }
  return value;
}

// 展开一条消息。params 为该消息命名空间下可见的参数（r 映射后）。
// stack 记录命中的 lang/key 用于引用环检测；trace 记录解析路径供网页展示。
function expandNodes(project, requestedLang, key, nodes, hitLang, params, stack, trace, state) {
  let out = '';
  const append = (chunk) => {
    out += chunk;
    state.codePoints += countCodePoints(chunk);
    if (state.codePoints > MAX_CODE_POINTS) {
      throw new LcpError(
        `消息键 ${JSON.stringify(state.rootKey)} 单条展开超过 ${MAX_CODE_POINTS} 个 Unicode 码点（实际 ${state.codePoints}）`,
        `展开 ${state.rootKey}`,
      );
    }
  };

  for (const node of nodes) {
    const tag = node[0];
    if (tag === TAG_T) {
      append(node[1]);
    } else if (tag === TAG_A) {
      const name = node[1];
      if (!(name in params)) {
        throw new LcpError(`缺少参数 ${JSON.stringify(name)}`, `展开 ${stack.length ? state.rootKey : key}`);
      }
      const v = params[name];
      if (typeof v === 'string') {
        append(v);
      } else if (typeof v === 'number' && Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX) {
        append(String(v));
      } else {
        throw new LcpError(`参数 ${JSON.stringify(name)} 的运行时值类型不合法（须为字符串或 int32）`);
      }
    } else if (tag === TAG_R) {
      const targetKey = node[1];
      const mapping = node[2];
      const targetParams = {};
      for (const [to, from] of Object.entries(mapping)) {
        if (!(from in params)) {
          throw new LcpError(`引用 ${targetKey} 的源参数 ${JSON.stringify(from)} 缺失`, `展开 ${state.rootKey}`);
        }
        targetParams[to] = params[from];
      }
      // 每次引用都从玩家请求的语言重新按链查找
      const hit = lookupMessage(project, requestedLang, targetKey);
      if (hit.lang === null) {
        throw new LcpError(
          `引用键 ${JSON.stringify(targetKey)} 沿请求语言 ${requestedLang} 的回退链不可达`,
          `${requestedLang} ${[...stack.map((f) => f.key), targetKey].join(' -> ')}`,
        );
      }
      for (const f of stack) {
        if (f.key === targetKey && f.lang === hit.lang) {
          throw new LcpError(
            `运行时引用环：${[...stack.map((f) => `${f.lang}/${f.key}`), `${hit.lang}/${targetKey}`].join(' -> ')}`,
            `${requestedLang} ${[...stack.map((f) => f.key), targetKey].join(' -> ')}`,
          );
        }
      }
      trace.push({
        kind: 'r',
        key: targetKey,
        requestedLang,
        hitLang: hit.lang,
        chain: hit.chain,
      });
      stack.push({ key: targetKey, lang: hit.lang });
      const part = expandNodes(
        project,
        requestedLang,
        targetKey,
        hit.nodes,
        hit.lang,
        targetParams,
        stack,
        trace,
        state,
      );
      stack.pop();
      append(part);
    } else if (tag === TAG_P) {
      const paramName = node[1];
      if (!(paramName in params)) {
        throw new LcpError(`复数参数 ${JSON.stringify(paramName)} 缺失`, `展开 ${state.rootKey}`);
      }
      const value = validateInt(params[paramName], `复数参数 ${JSON.stringify(paramName)}`);
      const branches = node[2];
      const chosen = selectBranch(Object.keys(branches), value, project.localeModes[hitLang]);
      trace.push({
        kind: 'p',
        param: paramName,
        value,
        hitLang,
        mode: project.localeModes[hitLang],
        branch: chosen,
      });
      append(
        expandNodes(project, requestedLang, key, branches[chosen], hitLang, params, stack, trace, state),
      );
    }
  }
  return out;
}

// 入口：返回 { text, requestedLang, hitLang, chain, trace, codePoints }
export function expandMessage(project, requestedLang, key, params = {}) {
  if (!(requestedLang in project.catalog)) {
    throw new LcpError(`未知请求语言 ${JSON.stringify(requestedLang)}`);
  }
  const hit = lookupMessage(project, requestedLang, key);
  if (hit.lang === null) {
    throw new LcpError(
      `消息键 ${JSON.stringify(key)} 沿请求语言 ${requestedLang} 的回退链 ${fallbackChain(project, requestedLang).join(' -> ')} 全部缺失`,
      `${requestedLang} 缺项 ${key}`,
    );
  }
  const trace = [{ kind: 'root', key, requestedLang, hitLang: hit.lang, chain: hit.chain }];
  const state = { codePoints: 0, rootKey: key };
  const text = expandNodes(
    project,
    requestedLang,
    key,
    hit.nodes,
    hit.lang,
    params,
    [{ key, lang: hit.lang }],
    trace,
    state,
  );
  return {
    text,
    requestedLang,
    hitLang: hit.lang,
    chain: hit.chain,
    trace,
    codePoints: state.codePoints,
  };
}

export { canonicalDecimal };
