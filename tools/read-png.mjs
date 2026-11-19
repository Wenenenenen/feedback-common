// 离线 PNG 检查 CLI（测试辅助）：复用 src/image-io.mjs 的自研解码器。
// Usage: node read-png.mjs <file.png> [...]
import fs from 'node:fs';
import { decodePNG } from '../src/image-io.mjs';

for (const f of process.argv.slice(2)) {
  const img = await decodePNG(new Uint8Array(fs.readFileSync(f)));
  console.log(`${f}: ${img.width}x${img.height} colorType=${img.colorType} bitDepth=${img.bitDepth ?? 8} ch=${img.channels}`);
  if (img.width <= 12) {
    for (let y = 0; y < img.height; y++) {
      const row = [];
      for (let x = 0; x < img.width; x++) row.push(img.data[y * img.width * img.channels + x * img.channels]);
      console.log(JSON.stringify(row));
    }
  } else {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < img.width * img.height; i++) hist[img.data[i * img.channels]]++;
    const levels = [];
    hist.forEach((c, l) => { if (c) levels.push(`${l}:${c}`); });
    console.log('levels:', levels.join(' '));
  }
}
