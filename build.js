'use strict';
/* Build a single self-contained index.html from app/page.html plus the solver,
 * session, worker, app, and sample-deck sources.  Run: node build.js */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const template = fs.readFileSync(path.join(root, 'app', 'page.html'), 'utf8');
const solver = fs.readFileSync(path.join(root, 'solver.js'), 'utf8');
const session = fs.readFileSync(path.join(root, 'session.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'app', 'worker.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app', 'app.js'), 'utf8');
const sample = fs.readFileSync(path.join(root, 'samples', 'expedition-deck.json'), 'utf8');

function indent(src) {
  return src.split('\n').map(line => (line ? '  ' + line : line)).join('\n');
}

const sampleObj = JSON.stringify(JSON.parse(sample));

// The worker source is carried as a JSON string so the page can build a blob
// from it.  Solver + worker runtime together form the worker script.
const workerSource = solver + '\n' + worker;
// Escape "</" so the literal can never close the surrounding <script> element.
const workerLiteral = JSON.stringify(workerSource).replace(/<\//g, '<\\/');

const scripts = [
  '<script>',
  'window.EXPEDITION_SAMPLE = ' + sampleObj + ';',
  'window.WORKER_SOURCE = ' + workerLiteral + ';',
  '</script>',
  '<script>',
  indent(solver).trim(),
  '</script>',
  '<script>',
  indent(session).trim(),
  '</script>',
  '<script>',
  indent(app).trim(),
  '</script>'
].join('\n');

let out = template.replace('<!--__SCRIPTS__-->', scripts);
if (out.includes('__SCRIPTS__')) throw new Error('a placeholder was not replaced');

fs.writeFileSync(path.join(root, 'index.html'), out);
console.log('wrote index.html (' + out.length + ' bytes, worker ' + workerSource.length + ' chars)');
