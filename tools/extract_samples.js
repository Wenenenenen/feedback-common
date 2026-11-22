#!/usr/bin/env node
'use strict';
/* 从 samples/rice-pcm-cases.zip 重新生成 samples.js（内嵌示例）。
 * 用法：node tools/extract_samples.js */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const zip = path.join(root, 'samples/rice-pcm-cases.zip');
const outDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rpa-samples-'));
execFileSync('unzip', ['-o', zip, '-d', outDir], { stdio: 'ignore' });

function b64(name) {
  return fs.readFileSync(path.join(outDir, name)).toString('base64');
}

const out =
  '/* 示例录音（来自 samples/rice-pcm-cases.zip），base64 内嵌以便页面离线可用。\n' +
  '   由 tools/extract_samples.js 生成，请勿手工编辑。 */\n' +
  '(function(root){\n' +
  '  root.RPA_SAMPLES = {\n' +
  '    mono16: { name: "mono16.wav", b64: "' + b64('mono16.wav') + '" },\n' +
  '    stereo24: { name: "stereo24.wav", b64: "' + b64('stereo24.wav') + '" }\n' +
  '  };\n' +
  '})(typeof globalThis!=="undefined"?globalThis:this);\n';

fs.writeFileSync(path.join(root, 'samples.js'), out);
fs.rmSync(outDir, { recursive: true, force: true });
console.log('samples.js', out.length, 'chars');
