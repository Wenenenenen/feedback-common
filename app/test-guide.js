const fs = require('fs');
const path = require('path');
const S = require('./solver.js');

function wavSampleCount(buf) {
  // 定位 data chunk
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'data') return size / 2;
    i += 8 + size + (size & 1);
  }
  throw new Error('WAV 中找不到 data chunk');
}

const dir = process.argv[2] || '../samples/cases';
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'guide.json'), 'utf8'));
const wav = fs.readFileSync(path.join(dir, 'guide.wav'));
const samples = wavSampleCount(wav);
const frameCount = Math.floor(samples / 240);
console.log('samples=', samples, 'frameCount=', frameCount);

const v = S.validate({
  beats: meta.beats, frameCount, anchors: meta.anchors, onsets: meta.onsets
});
console.log('validate:', v.ok, v.errors || '');
if (!v.ok) process.exit(1);

const res = S.solve({
  beats: meta.beats, frameCount, anchorFrame: v.anchorFrame, onsets: meta.onsets
});
console.log(JSON.stringify(res, null, 1));
