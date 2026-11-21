/* Layout and reveal engine. Pure functions, no DOM access. */

const NO_LINE_START = new Set(['，', '。', '！', '？', '）']);
const NO_LINE_END = new Set(['（']);

function splitGraphemes(text) {
  const str = String(text);
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('zh', { granularity: 'grapheme' });
    return Array.from(seg.segment(str), (s) => s.segment);
  }
  const out = [];
  for (const cp of Array.from(str)) {
    const c = cp.codePointAt(0);
    const marks =
      (c >= 0x0300 && c <= 0x036f) ||
      (c >= 0x1ab0 && c <= 0x1aff) ||
      (c >= 0x1dc0 && c <= 0x1dff) ||
      (c >= 0x20d0 && c <= 0x20ff) ||
      (c >= 0xfe00 && c <= 0xfe0f) ||
      (c >= 0x1f3fb && c <= 0x1f3ff) ||
      c === 0x200d ||
      (c >= 0xe0100 && c <= 0xe01ef);
    const prev = out[out.length - 1];
    const prevEndsZwj = prev && Array.from(prev).pop() === '‍';
    if (prev && (marks || prevEndsZwj)) out[out.length - 1] = prev + cp;
    else out.push(cp);
  }
  return out;
}

function baseChar(cluster) {
  return Array.from(cluster)[0] || '';
}

function isAsciiBase(cluster) {
  const c = baseChar(cluster);
  return c.length > 0 && c.codePointAt(0) < 0x80;
}

function clusterCols(cluster) {
  return isAsciiBase(cluster) ? 1 : 2;
}

function isWordGlyph(cluster) {
  return /^[A-Za-z0-9]$/.test(baseChar(cluster));
}

function itemIsWord(item) {
  return item.kind === 'grapheme' && isWordGlyph(item.text);
}

function groupCols(items, a, b) {
  let w = 0;
  for (let k = a; k <= b; k++) w += items[k].cols;
  return w;
}

/* Legal break after item j when the next item starts a new line.
   Kinsoku: ），。！？ may not open a line; （ may not close one.
   Latin/digit runs stay whole unless the whole run is wider than the box. */
function canBreakAfter(items, j, columns) {
  if (j >= items.length - 1) return true;
  const prev = items[j];
  const next = items[j + 1];
  if (prev.kind === 'grapheme' && NO_LINE_END.has(baseChar(prev.text))) return false;
  if (next.kind === 'grapheme' && NO_LINE_START.has(baseChar(next.text))) return false;
  if (itemIsWord(prev) && itemIsWord(next)) {
    let a = j;
    let b = j + 1;
    while (a > 0 && itemIsWord(items[a - 1])) a--;
    while (b < items.length - 1 && itemIsWord(items[b + 1])) b++;
    if (groupCols(items, a, b) <= columns) return false;
  }
  return true;
}

function layoutItems(items, columns) {
  const cols = Math.max(1, Math.floor(columns));
  const lines = [];
  let i = 0;
  while (i < items.length) {
    const lineIndex = lines.length;
    let width = 0;
    let furthest = i - 1;
    for (let j = i; j < items.length; j++) {
      if (width + items[j].cols > cols) break;
      width += items[j].cols;
      furthest = j;
    }
    if (furthest < i) {
      items[i].line = lineIndex;
      items[i].column = 0;
      lines.push({ start: i, end: i + 1, width: items[i].cols, forced: true, word: false });
      i++;
      continue;
    }
    let chosen = -1;
    for (let j = furthest; j >= i; j--) {
      if (canBreakAfter(items, j, cols)) {
        chosen = j;
        break;
      }
    }
    const forced = chosen < 0;
    if (forced) chosen = furthest;
    const line = { start: i, end: chosen + 1, width: 0, forced, word: false };
    if (!forced && chosen < items.length - 1) {
      line.word = itemIsWord(items[chosen]) && itemIsWord(items[chosen + 1]);
    }
    let x = 0;
    for (let k = i; k <= chosen; k++) {
      items[k].line = lineIndex;
      items[k].column = x;
      x += items[k].cols;
    }
    line.width = x;
    lines.push(line);
    i = chosen + 1;
  }
  return lines;
}

/* Build the item list, reveal schedule and line layout for one page.
   Every grapheme or icon reveals one interval later; pauses wait before
   the next item and still count toward the page duration. */
function buildPage(tokens, columns, intervalMs) {
  const interval = Math.max(0, Number(intervalMs) || 0);
  const list = (tokens || []).filter((token) => token && typeof token === 'object');
  const items = [];
  const pauses = [];
  let t = 0;
  let k = 0;
  while (k < list.length) {
    const token = list[k];
    if (typeof token.text === 'string') {
      // Join adjacent text tokens first so a grapheme split across tokens
      // (base + combining mark, ZWJ pieces) still reveals as one item.
      let text = token.text;
      let end = k;
      while (
        token.pauseMs === undefined &&
        token.icon === undefined &&
        end + 1 < list.length &&
        typeof list[end + 1].text === 'string' &&
        list[end + 1].pauseMs === undefined &&
        list[end + 1].icon === undefined
      ) {
        end++;
        text += list[end].text;
      }
      k = end;
      for (const cluster of splitGraphemes(text)) {
        if (cluster === '\n' || cluster === '\r') continue;
        t += interval;
        items.push({ kind: 'grapheme', text: cluster, cols: clusterCols(cluster), time: t });
      }
    }
    if (typeof token.icon === 'string' && token.icon.length > 0) {
      t += interval;
      items.push({ kind: 'icon', text: token.icon, cols: 2, time: t });
    }
    if (token.pauseMs !== undefined && token.pauseMs !== null) {
      const ms = Math.max(0, Number(token.pauseMs) || 0);
      if (ms > 0) pauses.push({ after: items.length, at: t, ms });
      t += ms;
    }
    k++;
  }
  const lines = layoutItems(items, columns);
  return { items, lines, pauses, duration: t };
}

function escapeDraftText(text) {
  return String(text).replace(/[\\<{]/g, (ch) => '\\' + ch);
}

/* Tokens -> one editable string: icons as <名称>, pauses as {毫秒}. */
function tokensToDraft(tokens) {
  let out = '';
  for (const token of tokens || []) {
    if (!token || typeof token !== 'object') continue;
    if (typeof token.text === 'string') out += escapeDraftText(token.text);
    if (typeof token.icon === 'string') out += '<' + token.icon + '>';
    if (token.pauseMs !== undefined && token.pauseMs !== null) {
      out += '{' + (Math.max(0, Number(token.pauseMs) || 0)) + '}';
    }
  }
  return out;
}

/* Editable string -> tokens. Markup: <名称> icon, {毫秒} pause,
   backslash escapes < { and \ itself. Unknown markup stays literal text. */
function parseDraft(draft) {
  const tokens = [];
  const src = String(draft ?? '');
  let buffer = '';
  const flush = () => {
    if (buffer) tokens.push({ text: buffer });
    buffer = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      buffer += src[i + 1];
      i++;
    } else if (ch === '<') {
      const close = src.indexOf('>', i + 1);
      const name = close > i + 1 ? src.slice(i + 1, close) : '';
      if (close > i + 1 && !/[\n<>{}]/.test(name)) {
        flush();
        tokens.push({ icon: name });
        i = close;
      } else {
        buffer += ch;
      }
    } else if (ch === '{') {
      const close = src.indexOf('}', i + 1);
      const body = close > i + 1 ? src.slice(i + 1, close) : '';
      if (close > i + 1 && /^\d+$/.test(body)) {
        flush();
        tokens.push({ pauseMs: Number(body) });
        i = close;
      } else {
        buffer += ch;
      }
    } else {
      buffer += ch;
    }
  }
  flush();
  return tokens;
}
