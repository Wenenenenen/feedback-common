// 工程规范化与发布前检查。
// 检查维度（按每种请求语言）：公共键缺项、参数类型/集合签名、引用目标存在性、引用环。
import { LcpError } from './errors.js';
import { parseNodes, TAG_T, TAG_A, TAG_R, TAG_P, INT32_MIN, INT32_MAX } from './parser.js';
import { encodeUtf8, compareBytes } from './utf8.js';

export const LIMITS = { maxLocales: 8, maxMessagesPerLocale: 20000 };

export function utf8Less(a, b) {
  return compareBytes(encodeUtf8(a), encodeUtf8(b)) < 0;
}

export function utf8SortedKeys(obj) {
  return Object.keys(obj).sort((x, y) => compareBytes(encodeUtf8(x), encodeUtf8(y)));
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// 结构规范化：校验 JSON 外形、限额，并把全部消息解析成节点树
export function normalizeProject(raw) {
  if (!isPlainObject(raw)) throw new LcpError('工程必须是 JSON 对象');
  const { signatures, localeModes, fallback, catalog } = raw;
  if (!isPlainObject(signatures)) throw new LcpError('signatures 必须是对象');
  if (!isPlainObject(localeModes)) throw new LcpError('localeModes 必须是对象');
  if (!isPlainObject(fallback)) throw new LcpError('fallback 必须是对象');
  if (!isPlainObject(catalog)) throw new LcpError('catalog 必须是对象');

  const sig = {};
  for (const key of Object.keys(signatures)) {
    const params = signatures[key];
    if (!isPlainObject(params)) {
      throw new LcpError(`签名 ${JSON.stringify(key)} 的参数表必须是对象`, `签名 ${key}`);
    }
    const entry = {};
    for (const [p, type] of Object.entries(params)) {
      if (type !== 's' && type !== 'i') {
        throw new LcpError(
          `签名 ${JSON.stringify(key)} 参数 ${JSON.stringify(p)} 类型必须是 "s" 或 "i"，得到 ${JSON.stringify(type)}`,
          `签名 ${key}`,
        );
      }
      entry[p] = type;
    }
    sig[key] = entry;
  }

  const languages = utf8SortedKeys(catalog);
  if (languages.length > LIMITS.maxLocales) {
    throw new LcpError(`语言数量 ${languages.length} 超过上限 ${LIMITS.maxLocales}`);
  }

  const cat = {};
  for (const lang of languages) {
    const table = catalog[lang];
    if (!isPlainObject(table)) {
      throw new LcpError(`catalog.${lang} 必须是消息表对象`, `catalog.${lang}`);
    }
    const keys = Object.keys(table);
    if (keys.length > LIMITS.maxMessagesPerLocale) {
      throw new LcpError(
        `语言 ${lang} 消息数 ${keys.length} 超过上限 ${LIMITS.maxMessagesPerLocale}`,
        `catalog.${lang}`,
      );
    }
    cat[lang] = {};
    for (const key of keys) {
      if (!(key in sig)) {
        throw new LcpError(
          `消息键 ${JSON.stringify(key)} 出现在 catalog.${lang} 但 signatures 中没有对应签名`,
          `catalog.${lang}.${key}`,
        );
      }
      cat[lang][key] = parseNodes(table[key], `catalog.${lang}.${key}`);
    }
  }

  const modes = {};
  for (const lang of languages) {
    const m = localeModes[lang];
    if (m !== 'one' && m !== 'other') {
      throw new LcpError(
        `localeModes.${lang} 必须是 "one" 或 "other"（每种语言都要声明）`,
        `localeModes.${lang}`,
      );
    }
    modes[lang] = m;
  }
  for (const lang of Object.keys(localeModes)) {
    if (!(lang in cat)) throw new LcpError(`localeModes 声明了未知语言 ${JSON.stringify(lang)}`);
  }

  const fb = {};
  for (const lang of languages) {
    if (!(lang in fallback)) {
      throw new LcpError(`fallback 缺少语言 ${JSON.stringify(lang)} 的条目（须显式为 null）`, `fallback.${lang}`);
    }
    const next = fallback[lang];
    if (next !== null && (typeof next !== 'string' || !(next in cat))) {
      throw new LcpError(
        `fallback.${lang} 指向未知语言 ${JSON.stringify(next)}`,
        `fallback.${lang}`,
      );
    }
    fb[lang] = next;
  }
  for (const lang of Object.keys(fallback)) {
    if (!(lang in cat)) throw new LcpError(`fallback 声明了未知语言 ${JSON.stringify(lang)}`);
  }
  // 回退链环检查（链是每个语言至多一条出边的函数图）
  for (const start of languages) {
    const seen = new Set();
    let cur = start;
    while (cur !== null) {
      if (seen.has(cur)) {
        throw new LcpError(`回退链成环：${[...seen, cur].join(' -> ')}`, `fallback.${start}`);
      }
      seen.add(cur);
      cur = fb[cur];
    }
  }

  return { signatures: sig, localeModes: modes, fallback: fb, catalog: cat, languages };
}

// 自某请求语言起的完整回退链（含自身，去环；结构检查已保证无环）
export function fallbackChain(project, requestedLang) {
  const chain = [];
  let cur = requestedLang;
  const seen = new Set();
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = project.fallback[cur];
  }
  return chain;
}

// 沿请求语言的链查找消息；每次引用都应重新调用本函数
export function lookupMessage(project, requestedLang, key) {
  const chain = fallbackChain(project, requestedLang);
  for (const lang of chain) {
    const table = project.catalog[lang];
    if (table && key in table) {
      return { lang, nodes: table[key], chain };
    }
  }
  return { lang: null, nodes: null, chain };
}

// 枚举节点内的引用边（r 的目标键；p 各分支递归），路径用于报错
function* edges(nodes, pathPrefix) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const here = `${pathPrefix}#${i}`;
    if (node[0] === TAG_R) {
      yield { kind: TAG_R, target: node[1], mapping: node[2], path: here };
    } else if (node[0] === TAG_P) {
      for (const name of utf8SortedKeys(node[2])) {
        yield* edges(node[2][name], `${here}.p(${node[1]}=${name})`);
      }
    }
  }
}

function checkSignatureUse(project, lang, key, nodes, sigParams, errors, pathStack) {
  const available = new Map(Object.entries(sigParams));
  const walk = (ns) => {
    for (const node of ns) {
      if (node[0] === TAG_A) {
        const p = node[1];
        if (!available.has(p)) {
          errors.push(
            new LcpError(
              `请求语言 ${lang}：消息 ${key} 引用了签名中不存在的参数 ${JSON.stringify(p)}`,
              `${lang} ${pathStack.join(' -> ')}`,
            ),
          );
        }
      } else if (node[0] === TAG_R) {
        const target = node[1];
        const targetSig = project.signatures[target];
        if (!targetSig) {
          errors.push(
            new LcpError(
              `请求语言 ${lang}：消息 ${key} 的 r 引用了签名中不存在的键 ${JSON.stringify(target)}`,
              `${lang} ${[...pathStack, target].join(' -> ')}`,
            ),
          );
          continue;
        }
        const map = node[2];
        const toNames = Object.keys(map);
        const sigNames = Object.keys(targetSig);
        const sameSet =
          toNames.length === sigNames.length && toNames.every((x) => x in targetSig);
        if (!sameSet) {
          errors.push(
            new LcpError(
              `请求语言 ${lang}：消息 ${key} 引用 ${target} 的参数集合与目标签名不匹配（映射须恰好覆盖目标全部参数）`,
              `${lang} ${[...pathStack, target].join(' -> ')}`,
            ),
          );
        }
        for (const [to, from] of Object.entries(map)) {
          if (!(from in sigParams)) {
            errors.push(
              new LcpError(
                `请求语言 ${lang}：消息 ${key} 引用 ${target} 的映射源参数 ${JSON.stringify(from)} 不在本消息签名中`,
                `${lang} ${[...pathStack, target].join(' -> ')}`,
              ),
            );
          } else if (to in targetSig && targetSig[to] !== sigParams[from]) {
            errors.push(
              new LcpError(
                `请求语言 ${lang}：消息 ${key} 引用 ${target} 的参数 ${JSON.stringify(to)} 类型不匹配（目标 ${targetSig[to]}，源 ${sigParams[from]}）`,
                `${lang} ${[...pathStack, target].join(' -> ')}`,
              ),
            );
          }
        }
      } else if (node[0] === TAG_P) {
        const p = node[1];
        const type = available.get(p);
        if (type === undefined) {
          errors.push(
            new LcpError(
              `请求语言 ${lang}：消息 ${key} 的 p 使用了签名中不存在的参数 ${JSON.stringify(p)}`,
              `${lang} ${pathStack.join(' -> ')}`,
            ),
          );
        } else if (type !== 'i') {
          errors.push(
            new LcpError(
              `请求语言 ${lang}：消息 ${key} 的 p 参数 ${JSON.stringify(p)} 必须是 i 类型，实际为 ${type}`,
              `${lang} ${pathStack.join(' -> ')}`,
            ),
          );
        }
        for (const name of utf8SortedKeys(node[2])) walk(node[2][name]);
      }
    }
  };
  walk(nodes);
}

// 完整发布检查；返回 LcpError 数组（空数组即通过）
export function checkProject(project) {
  const errors = [];
  const publicKeys = new Set();
  for (const lang of project.languages) {
    for (const key of Object.keys(project.catalog[lang])) publicKeys.add(key);
  }
  const sortedPublicKeys = [...publicKeys].sort((x, y) =>
    compareBytes(encodeUtf8(x), encodeUtf8(y)),
  );

  for (const requestedLang of project.languages) {
    // 1) 公共键缺项（允许在链尾仍缺，但必须报出）
    for (const key of sortedPublicKeys) {
      const hit = lookupMessage(project, requestedLang, key);
      if (hit.lang === null) {
        const chain = fallbackChain(project, requestedLang);
        errors.push(
          new LcpError(
            `请求语言 ${requestedLang}：公共键 ${JSON.stringify(key)} 沿回退链 ${chain.join(' -> ')} 全部缺失`,
            `${requestedLang} 缺项 ${key}`,
          ),
        );
      }
    }

    // 2) 从该语言可达的每个根键做 DFS：存在性、签名、引用环（含隐藏的 p 分支）
    for (const rootKey of sortedPublicKeys) {
      const first = lookupMessage(project, requestedLang, rootKey);
      if (first.lang === null) continue; // 缺项已在上面报出
      const stack = []; // {key, lang, path}
      const visited = new Set();

      const visit = (key, requestedForLookup, pathLabel) => {
        const hit = lookupMessage(project, requestedForLookup, key);
        if (hit.lang === null) {
          errors.push(
            new LcpError(
              `请求语言 ${requestedLang}：引用键 ${JSON.stringify(key)} 沿链不可达（引用路径：${pathLabel}）`,
              `${requestedLang} ${pathLabel}`,
            ),
          );
          return;
        }
        const frame = { key, lang: hit.lang };
        for (const f of stack) {
          if (f.key === key && f.lang === hit.lang) {
            errors.push(
              new LcpError(
                `请求语言 ${requestedLang}：检测到引用环 ${stack
                  .map((x) => `${x.lang}/${x.key}`)
                  .join(' -> ')} -> ${hit.lang}/${key}`,
                `${requestedLang} ${[...stack.map((x) => x.key), key].join(' -> ')}`,
              ),
            );
            return;
          }
        }
        const visitId = `${hit.lang}\u0000${key}`;
        if (visited.has(visitId)) return; // 同一命中消息的无环展开已检查过
        visited.add(visitId);

        const sigParams = project.signatures[key] || {};
        checkSignatureUse(project, requestedLang, key, hit.nodes, sigParams, errors, [
          ...stack.map((x) => x.key),
          key,
        ]);

        stack.push(frame);
        for (const e of edges(hit.nodes, key)) {
          if (e.kind === TAG_R) {
            // 每次引用都从玩家请求的语言重新按链查找
            visit(e.target, requestedLang, `${pathLabel} -> ${e.target}[${e.path}]`);
          }
        }
        stack.pop();
      };

      visit(rootKey, requestedLang, rootKey);
    }
  }
  return errors;
}

// 一次性入口：规范化 + 全量检查
export function validateProject(raw) {
  const project = normalizeProject(raw);
  const errors = checkProject(project);
  return { project, errors };
}

export { INT32_MIN, INT32_MAX };
