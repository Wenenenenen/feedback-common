#!/usr/bin/env node
'use strict';

/* 静态文件服务器：仅服务本项目目录，供 npm start 使用。 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const args = process.argv.slice(2);
let port = Number(process.env.PORT) || 8123;
let host = process.env.HOST || '127.0.0.1';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--port=')) port = Number(arg.slice(7));
  else if (arg === '--port' && args[i + 1]) port = Number(args[++i]);
  else if (arg.startsWith('--host=')) host = arg.slice(7);
  else if (arg === '--host' && args[i + 1]) host = args[++i];
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.pgm': 'image/x-portable-graymap',
  '.zip': 'application/zip',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${host}:${port}`).pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, host, () => {
  console.log(`纸格合边复核台：http://${host}:${port}/`);
});
