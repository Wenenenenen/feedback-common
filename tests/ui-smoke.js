'use strict';
/* Headless smoke test of index.html using jsdom (installed outside the repo).
 * Exercises the real UI: reveal, take, preview, undo, export, re-import. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/jsdomenv/node_modules/jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let failures = 0;
function ok(cond, name) {
  if (!cond) { failures++; console.error('FAIL ' + name); }
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://example.test/'
});
const { window } = dom;
const doc = window.document;

// jsdom does not implement layout; silence canvas-ish noise.
const errors = [];
window.addEventListener('error', e => errors.push(e.message));

function wait(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function text(selector) {
  const node = doc.querySelector(selector);
  return node ? node.textContent.replace(/\s+/g, ' ').trim() : null;
}

function click(node) {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

(async function () {
  await wait(60);

  ok(!errors.length, 'no script errors: ' + errors.join('; '));

  // Initial frame shows the sample deck and its exact value 14/15.
  ok(doc.querySelector('.reveal-btn'), 'reveal buttons rendered');
  const valueText = text('#value-body');
  ok(valueText && valueText.includes('14/15'), 'initial value 14/15, got: ' + valueText);

  const revealNames = [...doc.querySelectorAll('.reveal-btn')].map(b => b.getAttribute('data-reveal'));
  ok(revealNames.includes('map') && revealNames.includes('camp') && revealNames.includes('seal'),
    'all three types offered initially: ' + revealNames.join(','));

  // Click reveal map.
  const mapBtn = [...doc.querySelectorAll('.reveal-btn')].find(b => b.getAttribute('data-reveal') === 'map');
  click(mapBtn);
  await wait(60);
  ok(text('#round-body').includes('已揭一张'), 'after one reveal shows 已揭一张');
  ok(!doc.querySelector('[data-take]'), 'no take buttons while a card is still due');
  ok(doc.querySelector('.reveal-btn'), 'second reveal still offered');

  // Second reveal: camp.
  const campBtn = [...doc.querySelectorAll('.reveal-btn')].find(b => b.getAttribute('data-reveal') === 'camp');
  click(campBtn);
  await wait(80);

  const tiles = [...doc.querySelectorAll('.tile')];
  ok(tiles.length === 2, 'two held-card tiles');
  const takeBtns = [...doc.querySelectorAll('[data-take]')];
  ok(takeBtns.length === 2, 'two take buttons, got ' + takeBtns.length);
  ok(doc.querySelector('.tile.best'), 'a recommended tile is marked');
  // Value panel shows per-take fractions.
  const valueRows = [...doc.querySelectorAll('.value-row')];
  ok(valueRows.length === 2, 'two value rows');
  ok(valueRows.every(r => /\d/.test(r.textContent)), 'value rows carry numbers');

  // Preview a take: pick the non-recommended one if present so preview differs.
  const previewBtns = [...doc.querySelectorAll('[data-preview]')];
  ok(previewBtns.length === 2, 'two preview buttons');
  click(previewBtns[0]);
  await wait(30);
  ok(doc.querySelector('.preview'), 'preview panel appears');
  ok(doc.querySelector('.preview').textContent.includes('尚未提交'), 'preview is marked uncommitted');
  const confirmBtn = doc.querySelector('.preview [data-take]');
  ok(confirmBtn, 'preview has confirm button');
  // Cancel it.
  click(doc.querySelector('[data-preview-cancel]'));
  await wait(30);
  ok(!doc.querySelector('.preview'), 'preview cancelled');

  // Take camp (index of camp in held order).
  const heldNames = [...doc.querySelectorAll('.tile .nm')].map(n => n.textContent.trim());
  const campIndex = heldNames.indexOf('camp');
  ok(campIndex >= 0, 'camp is held: ' + heldNames.join(','));
  const campTake = [...doc.querySelectorAll('.tile')][campIndex].querySelector('[data-take]');
  click(campTake);
  await wait(120);

  const record = JSON.parse(doc.getElementById('record-out').value);
  ok(record.actions.length === 3, 'record has 3 actions, got ' + record.actions.length);
  ok(record.actions[0].kind === 'reveal' && record.actions[0].card === 'map', 'first action is reveal map');
  ok(record.actions[2].kind === 'take', 'third action is a take');
  ok(record.actions[2].card === 'camp', 'take recorded as camp, got ' + record.actions[2].card);

  // Undo.
  click(doc.getElementById('undo-btn'));
  await wait(80);
  const record2 = JSON.parse(doc.getElementById('record-out').value);
  ok(record2.actions.length === 2, 'undo removes the take');

  // Redo the take via preview → confirm.
  const campTake2 = [...doc.querySelectorAll('.tile')][campIndex].querySelector('[data-take]');
  click(campTake2);
  await wait(120);

  // Export, reset, re-import and confirm the same position comes back.
  const exported = doc.getElementById('record-out').value;
  const beforeValue = text('#value-body');

  doc.getElementById('reset-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  doc.getElementById('reset-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  const resetRecord = JSON.parse(doc.getElementById('record-out').value);
  ok(resetRecord.actions.length === 0, 'reset clears actions');

  doc.getElementById('record-in').value = exported;
  click(doc.getElementById('import-btn'));
  await wait(150);

  const afterImport = JSON.parse(doc.getElementById('record-out').value);
  ok(afterImport.actions.length === JSON.parse(exported).actions.length, 'import restores actions');
  ok(text('#value-body') === beforeValue, 'import restores the value panel');
  ok(text('#record-message').includes('已导入'), 'import reports success');

  // Illegal import: reveal of a card that cannot be there.
  const bad = JSON.parse(exported);
  bad.actions = [{ kind: 'reveal', card: 'unicorn' }];
  doc.getElementById('record-in').value = JSON.stringify(bad);
  click(doc.getElementById('import-btn'));
  await wait(100);
  ok(text('#record-message').includes('导入失败'), 'illegal record rejected');
  const afterBad = JSON.parse(doc.getElementById('record-out').value);
  ok(afterBad.actions.length === JSON.parse(exported).actions.length, 'rejected import leaves the record untouched');

  // Persistence: the page saved state, and a fresh load restores it.
  const stored = window.localStorage.getItem('expedition-draw-policy:v1');
  ok(stored && JSON.parse(stored).actions.length === afterBad.actions.length, 'state persisted to localStorage');

  /* --- second scenario: an all-seal deck where takes are illegal --- */
  const sealDeck = {
    types: {
      seal: { points: 2, tickets: -1, badges: ['seal'] },
      camp: { points: 0, tickets: 1, badges: [] }
    },
    unknown: { seal: 2, camp: 0 },
    tail: [],
    start: { points: 0, tickets: 0, badges: [] },
    rounds: 2,
    goal: { points: 2, badges: ['seal'] }
  };
  doc.getElementById('deck-input').value = JSON.stringify(sealDeck);
  click(doc.getElementById('deck-load'));
  await wait(120);

  ok(JSON.parse(doc.getElementById('record-out').value).actions.length === 0, 'new deck starts with no actions');
  const sealButtons = [...doc.querySelectorAll('.reveal-btn')].filter(b => b.getAttribute('data-reveal') === 'seal');
  ok(sealButtons.length === 1, 'one seal option (not duplicated per copy)');
  ok(sealButtons[0].textContent.includes('此牌还剩 2 张'), 'seal count shown once with 2 left');

  click(sealButtons[0]);
  await wait(60);
  click([...doc.querySelectorAll('.reveal-btn')].find(b => b.getAttribute('data-reveal') === 'seal'));
  await wait(150);
  ok(text('#round-body').includes('已失败'), 'both seals illegal -> failed');
  ok(!doc.querySelector('[data-take]'), 'no take button when no take is legal');
  ok(text('#round-body').includes('通行券不足'), 'illegal take explains why');
  const valText = text('#value-body');
  ok(valText.includes('0'), 'failed position shows value 0, got: ' + valText);

  // The only revealed card cannot be recorded as the impossible "camp".
  ok(![...doc.querySelectorAll('.reveal-btn')].some(b => b.getAttribute('data-reveal') === 'camp'),
    'camp is not offered when its count is 0');

  /* --- impossible reveal via the exported record is rejected whole --- */
  const badSeal = {
    format: 'expedition-draw-record',
    version: 1,
    deck: sealDeck,
    actions: [{ kind: 'reveal', card: 'camp' }]
  };
  doc.getElementById('record-in').value = JSON.stringify(badSeal);
  click(doc.getElementById('import-btn'));
  await wait(120);
  ok(text('#record-message').includes('导入失败'), 'impossible opening reveal rejected');
  ok(JSON.parse(doc.getElementById('record-out').value).actions.length === 2, 'rejected import keeps current record');

  if (failures) {
    console.error(failures + ' smoke failure(s)');
    process.exit(1);
  }
  console.log('ui smoke tests passed');
}()).catch(e => {
  console.error('SMOKE CRASH', e);
  process.exit(1);
});
