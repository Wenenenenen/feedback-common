// Verify the no-CompressionStream fallback: hand-built zlib stored blocks,
// including a payload large enough to require multiple 65535-byte blocks.
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { encodePNG, decodePNG, storedDeflate } from '../src/png-codec.js';

const inflate = promisify(zlib.inflate);
const inflateFn = async (b) => Uint8Array.from(await inflate(Buffer.from(b)));

const w = 53, h = 31;
const samples = new Uint16Array(w * h);
for (let i = 0; i < samples.length; i++) samples[i] = 1 + (i * 37) % 65535;

// Sanity: Node zlib accepts the module's stored stream.
const probe = storedDeflate(new Uint8Array(70000).fill(7));
const restored = await inflate(Buffer.from(probe));
console.log('stored stream multi-block inflate:', restored.length === 70000 && restored.every((b) => b === 7) ? 'OK' : 'FAIL');

const big = await encodePNG(w, h, 1, 16, samples, async (raw) => storedDeflate(raw));
const back = await decodePNG(big, inflateFn);
let ok = back.width === w && back.height === h;
for (let i = 0; i < samples.length; i++) if (back.samples[i] !== samples[i]) { ok = false; break; }
console.log('fallback stored-deflate PNG round-trip:', ok ? 'OK' : 'FAIL', `(${(big.length / 1024).toFixed(1)} KB)`);
process.exit(ok ? 0 : 1);
