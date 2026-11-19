// 零依赖静态服务器 + 样例数据接口。
// 样例按不可信数据隔离在 samples/extracted/（.gitignore），首次启动时自动解包；
// 以 base64 传给页面，页面复用与 Node 校验完全相同的 js/ 模块解码并计算。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSamples } from './extract-samples.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'samples', 'extracted');
const PORT = Number(process.env.PORT) || 8123;

const CASES = [
  {
    id: 'focus-3',
    label: 'focus-0/1/2 + lock.png（65×49，5 层）',
    images: ['focus-0.png', 'focus-1.png', 'focus-2.png'],
    levels: 5,
    lock: 'lock.png',
  },
  {
    id: 'constant-2',
    label: 'constant-40 / constant-160（低纹理）',
    images: ['constant-40.png', 'constant-160.png'],
    levels: 5,
    lock: null,
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function readB64(name) {
  return (await readFile(join(DATA, name))).toString('base64');
}

async function buildCasesPayload() {
  await extractSamples().catch((e) => console.warn(`样例解包失败：${e.message}`));
  const cases = [];
  for (const c of CASES) {
    try {
      const images = [];
      for (const name of c.images) images.push({ name, pngBase64: await readB64(name) });
      let lockBase64 = null;
      if (c.lock) lockBase64 = await readB64(c.lock);
      cases.push({ id: c.id, label: c.label, levels: c.levels, images, lockBase64 });
    } catch (e) {
      // 样例未解包时跳过该用例，页面给出提示
      console.warn(`样例 ${c.id} 不可用：${e.message}`);
    }
  }
  return { cases };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/cases') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(await buildCasesPayload()));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = normalize(join(ROOT, rel));
    if (!filePath.startsWith(ROOT + sep) || filePath.includes(`${sep}..${sep}`)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404: ${e.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`焦点堆栈 · 多尺度金字塔融合: http://localhost:${PORT}/`);
  console.log(`样例目录: ${DATA}`);
});
