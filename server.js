/* server.js — 零依赖静态服务器（断网可用）。
 * 在 WSL 中运行: node server.js  （可用 PORT 环境变量改端口）
 * Windows 浏览器访问: http://localhost:8123  （或打印出的 WSL IP） */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); }
  catch { res.writeHead(400); res.end(); return; }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`录音漂移校准工作台已启动（断网可用，无外部依赖）`);
  console.log(`  本机访问:   http://localhost:${PORT}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  Windows 访问: http://${a.address}:${PORT}  (${name})`);
      }
    }
  }
});
