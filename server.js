#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const args = process.argv.slice(2);
let port = Number(process.env.PORT) || 8123;
let host = process.env.HOST || '127.0.0.1';

for (const arg of args) {
  if (arg.startsWith('--port=')) port = Number(arg.split('=')[1]);
  if (arg === '--port') port = Number(args[args.indexOf(arg) + 1]);
  if (arg.startsWith('--host=')) host = arg.split('=')[1];
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.normalize(path.join(root, pathname));
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': mime[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (err) {
    res.writeHead(400);
    res.end('Bad request');
  }
});

server.listen(port, host, () => {
  console.log(`shared-label-outline running at http://${host}:${port}`);
});
