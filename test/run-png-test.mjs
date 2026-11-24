// 用最小全局垫片在 Node 中加载真实 web/worker.js，验证其 PNG 编码：
// Python 解码导出的 PNG，与解码器输出的 RGBA 逐字节比对。
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'png-out');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let waiters = [];
const transfers = [];
const frameSnapshots = [];
globalThis.self = {
  postMessage(msg, transfer) {
    // 转移前留档，模拟浏览器端接收者拿到的独立内容
    if (transfer) {
      for (const t of transfer) {
        transfers.push(t);
        if (msg.type === 'frame') frameSnapshots.push(new Uint8Array(t).slice());
      }
    }
    const q = waiters;
    waiters = [];
    q.forEach((resolve) => resolve(msg));
  },
};
globalThis.CompressionStream = CompressionStream;
globalThis.Response = Response;
globalThis.Blob = Blob;
globalThis.TextEncoder = TextEncoder;

await import(new URL('../web/worker.js', import.meta.url));
const onMessage = globalThis.self.onmessage;
if (typeof onMessage !== 'function') throw new Error('worker 未注册 onmessage');

function post(msg) {
  const pending = new Promise((resolve) => waiters.push(resolve));
  onMessage({ data: msg });
  return pending;
}

// 用基准录制（也可用夹具，这里取 move-order 小文件，便于人工核对）
const cxrPath = join(HERE, 'fixtures', 'move-order.cxr');
const fileBytes = readFileSync(cxrPath);
const ab = fileBytes.buffer.slice(
  fileBytes.byteOffset,
  fileBytes.byteOffset + fileBytes.byteLength,
);

const opened = await post({ type: 'open', buffer: ab });
if (opened.type !== 'opened') throw new Error('打开失败：' + JSON.stringify(opened));
const targetIndex = 1;
const frameMsg = await post({ type: 'decode', index: targetIndex, requestId: 1 });
if (frameMsg.type !== 'frame') throw new Error('解码失败：' + JSON.stringify(frameMsg));
// 期望像素取转移前快照（浏览器中接收端天然拿到独立缓冲）
const expectedRgba = frameSnapshots[0];
const expectedLen = expectedRgba.length;
const W = frameMsg.width;
const H = frameMsg.height;

const pngMsg = await post({ type: 'export-png', index: targetIndex, requestId: 2 });
if (pngMsg.type !== 'png') throw new Error('PNG 导出失败：' + JSON.stringify(pngMsg));
const pngPath = join(OUT, 'f1.png');
writeFileSync(pngPath, pngMsg.bytes);

// PNG 魔数与 IHDR 健全性
const pb = pngMsg.bytes;
const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
for (let i = 0; i < sig.length; i++) {
  if (pb[i] !== sig[i]) throw new Error('PNG 魔数错误');
}

// Python 解码（标准库无 PNG 解码，用 zlib 手写最小 RGBA PNG 解析器，避免第三方依赖）
const rgbaPath = join(OUT, 'f1-decoded.rgba');
execFileSync('python3', ['-I', join(HERE, 'png_decode.py'), pngPath, rgbaPath]);
const decoded = readFileSync(rgbaPath);
if (decoded.length !== expectedLen) {
  throw new Error(`长度不符：${decoded.length} != ${expectedLen}`);
}
let diff = -1;
for (let i = 0; i < decoded.length; i++) {
  if (decoded[i] !== expectedRgba[i]) { diff = i; break; }
}
if (diff >= 0) throw new Error(`像素在字节 ${diff} 不一致`);

// frame 消息确实通过 transfer 携带了像素缓冲
if (transfers.length === 0) {
  throw new Error('frame 消息未 transfer 像素缓冲');
}

console.log(JSON.stringify({
  ok: true,
  png: pngPath,
  width: W,
  height: H,
  rgbaBytes: expectedLen,
  pngBytes: pb.length,
  transferCount: transfers.length,
}));
