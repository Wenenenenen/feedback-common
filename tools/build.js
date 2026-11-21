#!/usr/bin/env node
/* Build the single-file bench: src/index.template.html + css + js + sample data. */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const outPath = path.join(root, 'index.html');

let page = src('index.template.html');
const styles = src('styles.css');
const mvr1 = src('mvr1.js');
const samples = src('samples.generated.js');
const app = src('app.js');

// Guard: inline scripts must not contain a literal </script>.
for (const [name, body] of [['mvr1.js', mvr1], ['samples.generated.js', samples], ['app.js', app]]) {
  if (/<\/script/i.test(body)) throw new Error(name + ' contains a literal </script>');
}

page = page.replace('<!--STYLES-->', () => styles.trimEnd());
page = page.replace('<!--MVR1_JS-->', () => mvr1.trimEnd());
page = page.replace('<!--SAMPLES_JS-->', () => samples.trimEnd());
page = page.replace('<!--APP_JS-->', () => app.trimEnd());

const leftover = page.match(/<!--(STYLES|MVR1_JS|SAMPLES_JS|APP_JS)-->/);
if (leftover) throw new Error('unreplaced placeholder ' + leftover[0]);

fs.writeFileSync(outPath, page);
console.log('wrote index.html  ' + (Buffer.byteLength(page) / 1024).toFixed(1) + ' KB');
