#!/usr/bin/env node
/* Tiny static server for local viewing: `node tools/serve.js [port]` */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'dist');
const port = Number(process.argv[2] || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.obj': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/boxed-hermite-extractor.html';
  const file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found: ' + p); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(port, () => console.log('serving dist/ at http://localhost:' + port + '/'));
