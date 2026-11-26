#!/usr/bin/env node
// 极简静态服务器（Node 标准库，零依赖）。
// 关键：为每个响应加 COOP/COEP，使页面可用 SharedArrayBuffer → 投票走多 Worker 并行。
//
// 用法：node tools/serve.mjs [--port 8000] [--root src] [--host 127.0.0.1]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  // 同一来源隔离：开 SharedArrayBuffer 的前提
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function parseArgs(argv) {
  const out = { port: 8000, root: 'src', host: '127.0.0.1', clips: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--root') out.root = argv[++i];
    else if (argv[i] === '--host') out.host = argv[++i];
    else if (argv[i] === '--clips') out.clips = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(HERE, '..', args.root);
// 站点根之外的只读回退：/samples/… 直接读仓库里的素材（避免复制样例）
const fallbackRoot = resolve(HERE, '..');

async function readUnder(base, rel) {
  const file = normalize(join(base, rel));
  if (file !== base && !file.startsWith(base + sep)) return null;
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    return { file, body: await readFile(file) };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const send = (status, headers, body) => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  };
  const text = (status, msg) => send(status, { 'Content-Type': 'text/plain; charset=utf-8' }, msg);
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return text(405, 'Method Not Allowed');
    }
    const raw = new URL(req.url, 'http://x').pathname;
    let rel = decodeURIComponent(raw);
    if (rel.endsWith('/')) rel += 'index.html';
    rel = rel.replace(/^\/+/, '');
    let hit = await readUnder(root, rel);
    if (!hit && rel.startsWith('samples/')) hit = await readUnder(fallbackRoot, rel);
    // 仅开发/测试用：--clips DIR 时按 /__clip__/ 暴露该目录的 ZIP
    if (!hit && args.clips && rel.startsWith('__clip__/')) {
      hit = await readUnder(resolve(args.clips), rel.slice('__clip__/'.length));
    }
    if (!hit) return text(404, 'Not Found');
    const head = {
      'Content-Type': MIME[extname(hit.file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': hit.body.length,
    };
    if (req.method === 'HEAD') return send(200, head, undefined);
    send(200, head, hit.body);
  } catch {
    text(500, 'Internal Error');
  }
});

server.listen(args.port, args.host, () => {
  const shown = args.host === '0.0.0.0' ? 'localhost' : args.host;
  console.log(`光盘音轨合议台：http://${shown}:${args.port}/  (root=${root})`);
});
