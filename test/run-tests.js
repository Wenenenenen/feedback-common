// 用 samples 包内的参考数据校验解码器：
//   - 系数 JSON 完全一致（coefficient_tolerance = 0）
//   - RGB 与参考 PNG 最大误差 <= rgb_max_error
//   - 损坏样例必须报错（含偏移与原因），不得产出部分结果
'use strict';
const fs = require('fs');
const path = require('path');
const JpegDecoder = require('../js/jpeg-decoder.js');
const { decodePng } = require('./png-decode.js');

const dir = process.argv[2] || path.join(__dirname, 'cases');
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

function coeffsOf(result) {
  const out = [];
  for (const mcu of result.mcus)
    for (const b of mcu.blocks)
      out.push({
        mcu: mcu.index, component: b.component,
        block_x: b.blockX, block_y: b.blockY,
        coefficients: Array.from(b.coefficients),
      });
  return out;
}

// ---- 正常样例 ----
for (const name of ['gray', '444', '422', '420-restart']) {
  const jpg = fs.readFileSync(path.join(dir, name + '.jpg'));
  let result;
  try {
    result = JpegDecoder.decode(new Uint8Array(jpg));
  } catch (e) {
    check(name, false, `解码抛错 @${e.offset}: ${e.message}`);
    continue;
  }

  // 系数比对
  const refCoeffs = JSON.parse(fs.readFileSync(path.join(dir, name + '-coefficients.json'), 'utf8'));
  const mine = coeffsOf(result);
  let coefOk = mine.length === refCoeffs.length;
  let firstBad = -1;
  if (coefOk) {
    for (let i = 0; i < mine.length; i++) {
      const a = mine[i], b = refCoeffs[i];
      if (a.mcu !== b.mcu || a.component !== b.component ||
          a.block_x !== b.block_x || a.block_y !== b.block_y ||
          a.coefficients.length !== 64 ||
          a.coefficients.some((v, k) => v !== b.coefficients[k])) {
        coefOk = false; firstBad = i; break;
      }
    }
  }
  check(`${name} 系数`, coefOk,
    coefOk ? `${mine.length} 块完全一致` : `第 ${firstBad} 块不一致（共 ${mine.length}/${refCoeffs.length}）`);

  // RGB 比对
  const png = decodePng(fs.readFileSync(path.join(dir, name + '-expected.png')));
  let maxErr = 0, sizeOk = result.width === png.width && result.height === png.height;
  if (sizeOk) {
    for (let i = 0; i < png.rgb.length; i++)
      maxErr = Math.max(maxErr, Math.abs(result.rgb[i] - png.rgb[i]));
  }
  check(`${name} RGB`, sizeOk && maxErr <= expected.rgb_max_error,
    sizeOk ? `最大误差 ${maxErr}（上限 ${expected.rgb_max_error}）`
           : `尺寸 ${result.width}x${result.height} != ${png.width}x${png.height}`);
}

// ---- 损坏样例 ----
const badCases = [
  ['bad-restart', /重启标记序号错误/],
  ['truncated', /截断/],
  ['unsupported-progressive', /渐进/],
];
for (const [name, pattern] of badCases) {
  const jpg = fs.readFileSync(path.join(dir, name + '.jpg'));
  try {
    JpegDecoder.decode(new Uint8Array(jpg));
    check(name, false, '应当报错却解码成功');
  } catch (e) {
    const ok = e instanceof JpegDecoder.JpegError &&
      typeof e.offset === 'number' && pattern.test(e.message);
    check(name, ok, ok ? `@${e.offset} (0x${e.offset.toString(16)}): ${e.message}`
                       : `异常不符合预期: ${e.message}`);
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
