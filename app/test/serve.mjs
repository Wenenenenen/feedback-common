// test/serve.mjs — 零依赖静态服务器：模块 Worker 需经 http(s) 加载，file:// 下无法启动
// 运行: npm run serve  然后浏览器打开 http://127.0.0.1:8123
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8123;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = normalize(join(ROOT, p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    const data = await readFile(fp);
    res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 not found');
  }
}).listen(PORT, '127.0.0.1', function () {
  console.log(`时域历史重投影校验台：http://127.0.0.1:${this.address().port}`);
});
