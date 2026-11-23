#!/usr/bin/env node
/*
 * 极简静态服务器，用于在 http(s) 下打开页面（file:// 也能直接打开，
 * 只是会走内嵌样例）。运行：node scripts/serve.js，默认 http://localhost:8123/
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT) || 8123;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(root, safe === '/' || safe === '' ? 'index.html' : safe);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => {
  console.log(`静态服务已启动：http://localhost:${port}/（根目录 ${root}）`);
});
