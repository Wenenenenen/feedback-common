#!/usr/bin/env node
'use strict';
// 生成 tools/py_oracle.py 所需的 /tmp/ccl-default-*.json/wav 对照产物。
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const CCL = require(path.join(ROOT, 'js', 'ccl-core.js'));
const WAV = CCL.WAV || require(path.join(ROOT, 'js', 'wav-codec.js'));

const wav = WAV.decodeWav(fs.readFileSync(path.join(ROOT, 'samples', 'loop.wav')).buffer.slice(0));
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'settings.json'), 'utf8'));
const result = CCL.processCycle(
  { left: wav.channelData[0], right: wav.channelData[1], length: wav.frames },
  settings
);
if (!result.ok) throw new Error('default settings produced lock conflicts');
fs.writeFileSync('/tmp/ccl-default-gains.json', JSON.stringify({
  n: result.n,
  gains: Array.from(result.gains),
  caps: Array.from(result.caps),
}));
fs.writeFileSync('/tmp/ccl-default-js.wav', Buffer.from(WAV.encodeWav16([result.outL, result.outR], 192000)));
console.log('dumped', result.n, 'frames to /tmp/ccl-default-gains.json and /tmp/ccl-default-js.wav');
