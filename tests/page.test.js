#!/usr/bin/env node
'use strict';
/*
 * Browser-level check of the built page. Requires the `playwright` package
 * (local or global). Run: node tests/page.test.js
 * Exercises the four reference cases plus snapshot save/restore through the UI.
 */
const path = require('path');
const { chromium } = require('playwright');

const pageUrl = 'file://' + path.join(__dirname, '..', 'index.html');
let pass = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok   ' + name); })
    .catch((err) => { failures.push(name); console.log('  FAIL ' + name + '\n       ' + (err.message || err)); });
}
function assert(c, m) { if (!c) throw new Error(m); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pageUrl);
  await page.waitForTimeout(400);

  const text = (sel) => page.locator(sel).innerText();
  const num = async (id) => Number((await text('#' + id)).replace(/[^\d-]/g, ''));
  const loadSample = async (kind) => {
    await page.selectOption('#sample-select', kind);
    await page.click('#btn-sample-load');
    await page.waitForTimeout(120);
  };
  const step = async () => { await page.click('#btn-step'); await page.waitForTimeout(180); };

  console.log('page tests — ' + pageUrl);

  await check('first paint is a working state, no console errors', async () => {
    assert(await num('m-tick') === 3, 'seeded tick');
    assert(await num('m-alive') === 4, 'seeded entities');
    assert(errors.length === 0, 'errors: ' + errors.join('; '));
  });

  await check('reuse sample: stale handle cannot read the reused entity', async () => {
    await page.click('#btn-reset');
    await loadSample('reuse');
    await step();
    await page.fill('#loc-slot', '0'); await page.fill('#loc-gen', '1');
    await page.click('#btn-locate'); await page.waitForTimeout(100);
    assert(/过期句柄/.test(await text('#locate-out')), 'stale handle rejected');
    await page.fill('#loc-gen', '2');
    await page.click('#btn-locate'); await page.waitForTimeout(100);
    const body = await text('#entity-out');
    assert(/Position\s+x\s+7/.test(body), 'reused slot shows x 7');
    assert(/y\s+8/.test(body), 'reused slot shows y 8');
  });

  await check('barrier sample: destroy is deferred, spawn still happens', async () => {
    await page.click('#btn-reset');
    await loadSample('barrier');
    await step();
    assert(await num('m-alive') === 1, 'one child alive');
    await page.click('[data-tab="events"]'); await page.waitForTimeout(150);
    const ev = await text('.eventlist');
    assert(/生成/.test(ev) && /销毁/.test(ev), 'spawn and destroy both logged');
  });

  await check('migration sample: query returns the unmigrated entity only', async () => {
    await page.click('#btn-reset');
    await loadSample('migration');
    await step();
    await page.click('[data-tab="query"]'); await page.waitForTimeout(120);
    await page.click('[data-preset="move"]'); await page.waitForTimeout(150);
    const count = await text('.result-head .count');
    assert(/^1/.test(count.replace(/\s+/g, ' ').trim()) || /1/.test(count), 'one mover');
    // Position is in the include set; one click moves it to exclude and out of include.
    await page.click('[data-qcomp="Position"]'); await page.waitForTimeout(150);
    assert(/查询非法/.test(await text('.result-head')) === false, 'no illegal query');
    const chips = await page.evaluate(() => [...document.querySelectorAll('[data-qcomp]')].map((b) => b.dataset.qcomp + ':' + b.dataset.state));
    assert(chips.includes('Position:exclude') && !chips.includes('Position:include'), 'Position moved to exclude only once');
    // include {Velocity} − exclude {Position, Frozen}: the Position+Velocity entity is excluded too.
    assert(/^\s*0\s/.test((await text('.result-head .count')).replace(/\s+/g, ' ')), 'no entity matches');
  });

  await check('stress sample: 10000 entities / 20000 commands', async () => {
    await page.click('#btn-reset');
    await loadSample('stress');
    await step();
    assert(await num('m-alive') === 10000, '10000 alive');
    assert(await num('m-ext') === 0, 'queue drained');
    await page.click('[data-tab="query"]'); await page.waitForTimeout(150);
    await page.click('[data-preset="all"]'); await page.waitForTimeout(300);
    assert(/10\s?000/.test(await text('.result-head .count')), 'query sees 10000');
  });

  await check('snapshot: pending queues and clock survive, resume check agrees', async () => {
    await page.click('#btn-reset');
    await loadSample('barrier');
    await step();
    await page.click('#btn-save'); await page.waitForTimeout(200);
    const saved = await page.evaluate(() => document.getElementById('snap-text').value);
    assert(saved.length > 500, 'snapshot written');
    const snap = JSON.parse(saved);
    // The generator was killed and its slot reused by the child: one slot at gen 2.
    assert(Array.isArray(snap.slotGenerations) && snap.slotGenerations.length === 1, 'slot generations kept');
    assert(snap.slotGenerations[0] === 2, 'generation of the reused slot kept');
    assert(Array.isArray(snap.freeSlots) && snap.freeSlots.length === 0, 'free slot set kept');
    assert(snap.tick === 1, 'clock kept');
    await step();
    await page.click('#btn-restore'); await page.waitForTimeout(200);
    assert(await num('m-tick') === 1, 'clock restored');
    await page.click('#btn-check-resume'); await page.waitForTimeout(1400);
    assert(/一致/.test(await text('#snap-check')), 'resume check agrees');
  });

  await check('command entry: enqueue then execute an external command', async () => {
    await page.click('#btn-reset');
    await page.selectOption('#op-select', 'create');
    await page.fill('#seq-input', '1');
    await page.click('#btn-enqueue'); await page.waitForTimeout(120);
    assert(await num('m-ext') === 1, 'command queued');
    await step();
    assert(await num('m-alive') === 1, 'entity created on step');
    await page.selectOption('#op-select', 'add');
    await page.selectOption('#component-select', 'Velocity');
    await page.fill('#slot-input', '0'); await page.fill('#gen-input', '1');
    await page.fill('#seq-input', '2');
    await page.click('#btn-enqueue');
    await step();
    await page.click('[data-tab="migrations"]'); await page.waitForTimeout(150);
    assert(/Position/.test(await text('.panel')), 'migration edge rendered');
  });

  await check('phone width has no horizontal scroll', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: innerWidth }));
    assert(w.doc <= w.win, 'doc ' + w.doc + ' > win ' + w.win);
    await page.setViewportSize({ width: 1600, height: 1100 });
  });

  await check('dark theme keeps an explicit page background', async () => {
    const p2 = await browser.newPage({ colorScheme: 'dark', viewport: { width: 1200, height: 900 } });
    await p2.goto(pageUrl);
    await p2.waitForTimeout(300);
    const bg = await p2.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', 'body has a background: ' + bg);
    await p2.close();
  });

  await browser.close();
  console.log('----------------------------------------');
  if (failures.length) { console.log(failures.length + ' failure(s), ' + pass + ' passed'); process.exit(1); }
  console.log(pass + ' passed');
})().catch((err) => { console.error(err); process.exit(1); });
