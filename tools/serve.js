// 零依赖静态服务器：npm start 或 node tools/serve.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT_ARG = Number(process.argv[2] || process.env.PORT || 0);
const PORT_EXPLICIT = Boolean(process.argv[2] || process.env.PORT);
const PREFERRED_PORT = PORT_ARG || 8123;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ppm': 'image/x-portable-pixmap',
  '.pgm': 'image/x-portable-graymap',
  '.zip': 'application/zip',
  '.csv': 'text/csv; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 not found: ' + rel);
      }
      fs.readFile(file, (e, data) => {
        if (e) {
          res.writeHead(500);
          return res.end('read error');
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });
    });
  } catch (e) {
    res.writeHead(400);
    res.end('bad request');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !PORT_EXPLICIT && server.listening === false) {
    // 默认端口被占（例如本机已有其他服务）：回退到系统分配的空闲端口
    console.log(`端口 ${PREFERRED_PORT} 被占用，改用系统分配的空闲端口…`);
    server.listen(0, HOST);
  } else {
    console.error('静态服务启动失败：', err.message);
    process.exit(1);
  }
});

server.on('listening', () => {
  const addr = server.address();
  console.log(`genlock-key-fill 已启动：http://localhost:${addr.port}/`);
});

server.listen(PREFERRED_PORT, HOST);
