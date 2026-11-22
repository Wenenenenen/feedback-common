/*
 * scripts/serve.mjs — 零依赖静态服务器
 * 用法：node scripts/serve.mjs [端口，默认 8000]
 * ES module 在 file:// 下会被浏览器 CORS 拦截，本地校验请用本服务器。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(new URL('..', import.meta.url).pathname, '/');
const port = Number(process.argv[2]) || 8000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0]));
  const file = join(root, rel === '/' ? 'index.html' : rel);
  // 防目录穿越：解析后的真实路径必须仍在根目录内（root 已带尾斜杠）
  if (!file.startsWith(root)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`排版校验页面：http://127.0.0.1:${port}/index.html`);
});
