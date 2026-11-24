// tests/crosscheck.mjs — 浏览器导出值 vs Node 独立参照实现，逐值核对
import { readFile } from 'node:fs/promises';
import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { parseWav } from '../js/wav.js';
import { SourcePyramid } from '../js/pyramid.js';
import { Timeline, makeSegment } from '../js/timeline.js';

const here = new URL('.', import.meta.url).pathname;
const buf = await readFile(here + '../samples/wave-edit-source.wav');
const wav = parseWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'wave-edit-source.wav');
const py = new SourcePyramid(wav.frames, wav.frameCount, wav.name);
const sources = new Map([['S0', { name: wav.name, frameCount: wav.frameCount, pyramid: py }]]);

// 与 app.js boot 完全相同的三段
const tl = new Timeline(sources);
const half = Math.floor(wav.frameCount / 2);
tl.append(makeSegment('S0', 0, half));
tl.append({ ...makeSegment('S0', half, wav.frameCount), reverse: true });
tl.append({ ...makeSegment('S0', 1000, 3000), muted: true });

const B = 128;
const n = tl.totalFrames();
const refCols = tl.columnStats(0, n, B);
const refAgg = tl.rangeStats(0, n);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:8747/index.html');
await page.waitForSelector('#segBody tr');
// 把 B 调到 128
await page.locator('#bRange').evaluate((el) => { el.value = '128'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await page.click('#btnExport');
const exported = JSON.parse(await page.locator('#exportJson').inputValue());
await browser.close();

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL:', msg); } else console.log('ok  ', msg); };

check(exported.columns.B === B && exported.columns.list.length === B, `浏览器导出 ${B} 列`);

// 逐列、逐声道、逐字段（min/max/count/sumSq 十进制字符串）
for (let j = 0; j < B; j++) {
  const got = exported.columns.list[j];
  const want = refCols[j];
  check(got.startFrame === want.start && got.endFrame === want.end, `列 ${j} 边界 [${want.start},${want.end})`);
  for (const [ch, key] of [[0, 'left'], [1, 'right']]) {
    const g = got[key], w = want.stats[ch];
    if (w === null) {
      check(g.min === null && g.max === null && g.count === 0 && g.sumSq === '0', `列 ${j} ${key} 空列零值`);
    } else {
      check(g.min === w.min && g.max === w.max && g.count === w.count && g.sumSq === w.sumSq.toString(),
        `列 ${j} ${key} min/max/count/sumSq 全等`);
    }
  }
}

// 区间聚合
for (const [key, st] of [['left', refAgg[0]], ['right', refAgg[1]]]) {
  const g = exported.intervalAggregate[key];
  check(g.min === st.min && g.max === st.max && g.count === st.count && g.sumSq === st.sumSq.toString(),
    `区间聚合 ${key} 全等（sumSq=${st.sumSq.toString().slice(0, 24)}…）`);
}

// 段清单的源坐标与标记
check(exported.segments.length === 3, '段清单 3 段');
check(exported.segments[1].reverse === true && exported.segments[2].muted === true, '倒序/静音标记正确');
check(exported.segments[0].srcStart === 0 && exported.segments[0].srcEnd === half, '段 0 源区间');

if (failures > 0) { console.error(`\n${failures} 项不一致`); process.exit(1); }
console.log('\ncrosscheck done — 浏览器与 Node 参照实现完全一致');
