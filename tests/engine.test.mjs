import fs from 'fs';
import vm from 'vm';

const here = new URL('.', import.meta.url);
const code = fs.readFileSync(new URL('../engine.js', here), 'utf8');
const ctx = { exports: {} };
vm.runInNewContext(
  code +
    '\n;this.__x = { splitGraphemes, clusterCols, buildPage, layoutItems, canBreakAfter, parseDraft, tokensToDraft };',
  ctx
);
const { splitGraphemes, clusterCols, buildPage, canBreakAfter, parseDraft, tokensToDraft } = ctx.__x;

let pass = 0;
let fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else {
    fail++;
    console.log('FAIL', label, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  }
}
function linesOf(built) {
  return built.lines.map((l) => built.items.slice(l.start, l.end).map((i) => i.text).join(''));
}

// ---- Sample fixtures -------------------------------------------------------
const sample = JSON.parse(
  fs.readFileSync(new URL('../samples/dialogue-reveal-layout.json', here), 'utf8')
);
for (const page of sample.pages) {
  const built = buildPage(page.tokens, sample.columns, sample.intervalMs);
  if (page.expectedLines) eq('sample lines', linesOf(built), page.expectedLines);
  if (page.expectedReveals) {
    eq('sample reveals', built.items.map((i) => [i.time, i.text]), page.expectedReveals);
    eq('sample duration', built.duration, 700);
  }
}

// ---- Widths ---------------------------------------------------------------
eq('ASCII grapheme is 1 column', clusterCols('e'), 1);
eq('combining mark stays with base', clusterCols('é'), 1);
eq('CJK is 2 columns', clusterCols('屋'), 2);
eq('ZWJ emoji is one 2-column grapheme', clusterCols('👩🏽‍🚀'), 2);
eq('astral CJK is 2 columns', clusterCols('𠀀'), 2);
eq('grapheme split keeps accents', splitGraphemes('é👩🏽‍🚀'), ['é', '👩🏽‍🚀']);

// ---- Reveal timing --------------------------------------------------------
{
  const built = buildPage([{ text: 'AB', pauseMs: 250 }, { icon: '铃' }], 8, 100);
  eq('pause after text waits before next item',
    built.items.map((i) => [i.time, i.text]),
    [[100, 'A'], [200, 'B'], [550, '铃']]);
  eq('pause counts toward duration', built.duration, 550);
}
{
  const built = buildPage([{ text: 'A' }, { pauseMs: 900 }], 8, 100);
  eq('trailing pause counts toward duration', built.duration, 1000);
}
{
  const built = buildPage([{ icon: '铃' }, { icon: '灯' }], 8, 100);
  eq('icons are their own reveal steps', built.items.map((i) => [i.time, i.text, i.cols]),
    [[100, '铃', 2], [200, '灯', 2]]);
}

// ---- Line breaking --------------------------------------------------------
{
  const built = buildPage([{ text: '（（（（（（' }], 8, 100);
  eq('forced break at furthest fit', built.lines.map((l) => [l.width, l.forced]),
    [[8, true], [4, false]]);
}
{
  const built = buildPage([{ text: 'ABCDEFGHIJ' }], 8, 100);
  eq('oversize word splits and is flagged', built.lines.map((l) => [l.width, l.forced, l.word]),
    [[8, false, true], [2, false, false]]);
}
{
  const built = buildPage([{ text: '甲乙ABCDEF灯' }], 8, 100);
  eq('word kept whole when it fits', linesOf(built), ['甲乙', 'ABCDEF灯']);
}
{
  const built = buildPage([{ text: '甲乙1234' }], 8, 100);
  eq('digit run stays whole when it fits', [built.lines.length, built.lines[0].width], [1, 8]);
}
{
  // 12345 is 5 columns, under the 8-column box, so the run moves as a unit.
  const built = buildPage([{ text: '甲乙12345' }], 8, 100);
  eq('fitting digit run moves whole', linesOf(built), ['甲乙', '12345']);
}
{
  // 1234567890 is 10 columns, wider than the box, so it splits.
  const built = buildPage([{ text: '甲乙1234567890' }], 8, 100);
  eq('oversize digit run splits', linesOf(built), ['甲乙1234', '567890']);
}
{
  // Rightmost legal break: a run that reaches the edge pushes to the earlier break.
  const built = buildPage([{ text: '甲乙丙丁ABCD' }], 8, 100);
  eq('rightmost legal break chosen', linesOf(built), ['甲乙丙丁', 'ABCD']);
}

// ---- Editor markup --------------------------------------------------------
{
  const tokens = parseDraft('é👩🏽‍🚀{300}<铃>灯{50}');
  eq('draft parses icons and pauses', tokens, [
    { text: 'é👩🏽‍🚀' }, { pauseMs: 300 }, { icon: '铃' }, { text: '灯' }, { pauseMs: 50 },
  ]);
  eq('draft round-trips', tokensToDraft(tokens), 'é👩🏽‍🚀{300}<铃>灯{50}');
}
{
  for (const src of ['a\\<b\\>c\\{300\\}\\\\', 'plain {text}', 'x{y}', '<铃>', '{300}']) {
    const once = tokensToDraft(parseDraft(src));
    eq('draft stable: ' + src, tokensToDraft(parseDraft(once)), once);
  }
}

// ---- Randomized properties ------------------------------------------------
const ALPHABET = ['屋', '甲', '乙', '，', '。', '！', '？', '（', '）', 'A', 'B', 'C', '7',
  'é', 'é', ' ', '👩🏽‍🚀', '𠀀', 'ｚ', '，', '。'];
let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function randText(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  return s;
}
let propFail = 0;
for (let iter = 0; iter < 4000 && !propFail; iter++) {
  const columns = 8 + Math.floor(rnd() * 33);
  const text = randText(Math.floor(rnd() * 45));
  const built = buildPage([{ text }], columns, 100);
  const expected = splitGraphemes(text);
  if (built.items.map((i) => i.text).join('') !== expected.join('')) {
    propFail++;
    console.log('text mismatch', JSON.stringify(text));
    break;
  }
  for (let li = 0; li < built.lines.length; li++) {
    const line = built.lines[li];
    const lineItems = built.items.slice(line.start, line.end);
    const width = lineItems.reduce((s, it) => s + it.cols, 0);
    if (width !== line.width || (width > columns && lineItems.length > 1)) {
      propFail++;
      console.log('width rule broken', columns, JSON.stringify(text), li);
      break;
    }
    const forcedHere = line.forced;
    const prevForced = li > 0 && built.lines[li - 1].forced;
    if (li > 0 && !forcedHere && !prevForced) {
      const first = Array.from(lineItems[0].text)[0];
      if (lineItems[0].kind === 'grapheme' && '，。！？）'.includes(first)) {
        propFail++;
        console.log('forbidden line start', columns, JSON.stringify(text), li);
        break;
      }
    }
    if (li < built.lines.length - 1) {
      const last = lineItems[lineItems.length - 1];
      if (!forcedHere) {
        if (last.kind === 'grapheme' && Array.from(last.text)[0] === '（') {
          propFail++;
          console.log('forbidden line end', columns, JSON.stringify(text), li);
          break;
        }
        if (!canBreakAfter(built.items, line.end - 1, columns)) {
          propFail++;
          console.log('illegal break', columns, JSON.stringify(text), li);
          break;
        }
      }
      // The break must be the rightmost legal one inside the line's reach.
      let w = 0;
      let furthest = line.start - 1;
      for (let j = line.start; j < built.items.length; j++) {
        if (w + built.items[j].cols > columns) break;
        w += built.items[j].cols;
        furthest = j;
      }
      let later = false;
      for (let j = line.end; j <= furthest; j++) {
        if (canBreakAfter(built.items, j, columns)) later = true;
      }
      if (later && !forcedHere) {
        propFail++;
        console.log('break not rightmost', columns, JSON.stringify(text), li);
        break;
      }
    }
  }
}
eq('randomized properties hold', propFail, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
