// 零依赖静态服务器，并把样例数据打包成 /api/cases 供页面加载：
// RAW 与 PNG 均以 base64 传输，页面侧复用同一套 lib（浏览器原生 fetch + CompressionStream）。
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'samples', 'extracted');
const PORT = Number(process.env.PORT) || 8123;
const CASES = ['zone', 'edges', 'lines', 'colorbars'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function buildCasesPayload() {
  const cases = [];
  for (const name of CASES) {
    const [rawB64, wb, truthB64, refB64] = await Promise.all([
      readFile(join(DATA, `${name}.raw`)).then((b) => b.toString('base64')),
      readFile(join(DATA, `${name}.json`), 'utf8').then((t) => JSON.parse(t)),
      readFile(join(DATA, 'truth', `${name}.png`)).then((b) => b.toString('base64')),
      readFile(join(DATA, 'ref-bilinear', `${name}.png`)).then((b) => b.toString('base64')),
    ]);
    cases.push({ name, rawBase64: rawB64, wb, truthBase64: truthB64, refBase64: refB64 });
  }
  const reference = JSON.parse(await readFile(join(DATA, 'reference.json'), 'utf8'));
  return { cases, reference };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/cases') {
      const payload = await buildCasesPayload();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return;
    }
    let path = url.pathname === '/' ? '/web/index.html' : url.pathname;
    const filePath = normalize(join(ROOT, path));
    const rel = filePath.slice(ROOT.length);
    if (!filePath.startsWith(ROOT) || rel.includes('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404: ${e.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`拜耳去马赛克对比台: http://localhost:${PORT}/`);
});
