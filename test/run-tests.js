/*
 * test/run-tests.js — 用 samples 中的 manifest.json 真值校验 png-core.js
 * 用法: node test/run-tests.js <样例解压目录>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PNGCore = require('../js/png-core.js');

const dir = process.argv[2];
if (!dir) {
  console.error('用法: node test/run-tests.js <样例解压目录>');
  process.exit(2);
}

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

(async () => {
  /* ---------- 有效样例：解码结果与 manifest 完全一致 ---------- */
  for (const entry of manifest) {
    console.log(`\n[解码] ${entry.file}`);
    const bytes = new Uint8Array(fs.readFileSync(path.join(dir, entry.file)));
    let dec;
    try {
      dec = await PNGCore.decode(bytes);
    } catch (e) {
      ok(false, '解码成功', `${e.name}: ${e.message}`);
      continue;
    }
    ok(dec.width === entry.width && dec.height === entry.height,
      `尺寸 ${entry.width}×${entry.height}`, `实际 ${dec.width}×${dec.height}`);
    ok(dec.depth === entry.depth && dec.colorType === entry.color_type,
      `位深 ${entry.depth} / 类型 ${entry.color_type}`,
      `实际 ${dec.depth}/${dec.colorType}`);
    ok(dec.interlace === entry.interlace, `隔行=${entry.interlace}`, `实际 ${dec.interlace}`);
    ok(dec.scanlineBytes === entry.scanline_bytes,
      `扫描行字节 ${entry.scanline_bytes}`, `实际 ${dec.scanlineBytes}`);
    ok(dec.idatBytes === entry.idat_bytes,
      `IDAT 字节 ${entry.idat_bytes}`, `实际 ${dec.idatBytes}`);
    ok(eq(dec.palette, entry.palette), '调色板一致',
      `实际 ${JSON.stringify(dec.palette)}`);
    ok(eq(dec.transparency, entry.transparency), '透明度一致',
      `实际 ${JSON.stringify(dec.transparency)}`);

    // 样本（行优先、原始位深）
    const ch = dec.channels;
    const flat = Array.from(dec.samples);
    const expectFlat = entry.samples.flat();
    ok(eq(flat, expectFlat), `像素样本一致（${expectFlat.length} 个值）`,
      (() => {
        for (let i = 0; i < expectFlat.length; i++) {
          if (flat[i] !== expectFlat[i]) {
            const px = Math.floor(i / ch);
            return `第 ${px % dec.width},${Math.floor(px / dec.width)} 像素通道 ${i % ch}：` +
              `期望 ${expectFlat[i]} 实际 ${flat[i]}`;
          }
        }
        return '长度不一致';
      })());

    // 逐行过滤记录
    ok(eq(dec.rows, entry.rows), `逐行过滤记录一致（${entry.rows.length} 行）`,
      `实际 ${JSON.stringify(dec.rows.slice(0, 5))}...`);

    /* ---------- 重编码：auto + 五种固定过滤器 ---------- */
    for (const mode of ['auto', 0, 1, 2, 3, 4]) {
      const enc = await PNGCore.encode(dec, mode);
      // 输出必须能被自己解码，且像素/调色板/透明度完全一致
      const re = await PNGCore.decode(enc.bytes);
      const samePixels = eq(Array.from(re.samples), Array.from(dec.samples));
      const sameMeta = re.depth === dec.depth && re.colorType === dec.colorType &&
        re.interlace === 0 && eq(re.palette, dec.palette) &&
        eq(re.transparency, dec.transparency);
      ok(samePixels && sameMeta, `重编码(${mode}) 往返一致`,
        sameMeta ? '像素不一致' : '元数据不一致');
      if (mode !== 'auto') {
        ok(enc.rows.every((r) => r.filter === mode && r.pass === 0),
          `重编码(${mode}) 全部行使用该过滤器`);
      } else {
        // 独立验证 auto 选择：逐行重算代价
        const bpp = dec.bpp;
        const rowBytes = PNGCore.rowBytesOf(dec.width, ch, dec.depth);
        const raw = new Uint8Array(rowBytes);
        const prev = new Uint8Array(rowBytes);
        const scratch = new Uint8Array(rowBytes);
        let allOk = true;
        for (let y = 0; y < dec.height; y++) {
          PNGCore.packRow(dec.samples, y * dec.width * ch, dec.width, ch, dec.depth, raw);
          const want = PNGCore.chooseFilter(raw, prev, bpp, scratch);
          if (enc.rows[y].filter !== want) { allOk = false; break; }
          prev.set(raw);
        }
        ok(allOk, '重编码(auto) 逐行择优规则正确');
      }
    }
  }

  /* ---------- 损坏样例：必须报错并指出位置 ---------- */
  const badCases = [
    { file: 'bad-crc.png', re: /CRC/, desc: 'CRC 校验失败' },
    { file: 'unknown-critical.png', re: /未知关键块/, desc: '未知关键块' },
    { file: 'truncated.png', re: /截断|不完整|超出|不足/, desc: '文件截断' },
  ];
  for (const c of badCases) {
    console.log(`\n[损坏] ${c.file}（期望：${c.desc}）`);
    const bytes = new Uint8Array(fs.readFileSync(path.join(dir, c.file)));
    try {
      await PNGCore.decode(bytes);
      ok(false, '应当拒绝', '解码意外成功');
    } catch (e) {
      ok(e instanceof PNGCore.PNGError, '抛出 PNGError', `${e.name}: ${e.message}`);
      ok(c.re.test(e.message), `错误信息匹配 ${c.re}`, e.message);
      ok(!!e.loc, '错误带位置信息', JSON.stringify(e.loc));
      console.log(`    → ${e.message}`);
    }
  }

  /* ---------- 边界：超限拒绝 ---------- */
  console.log('\n[边界]');
  {
    // 构造宽度 2049 的 IHDR
    const tiny = new Uint8Array(fs.readFileSync(path.join(dir, 'tiny.png')));
    const view = new DataView(tiny.buffer);
    view.setUint32(16, 2049); // IHDR 数据偏移 8(签名)+8(块头)=16
    // 修正 CRC
    const crc = PNGCore.crc32(tiny, 12, 29);
    view.setUint32(29, crc);
    try {
      await PNGCore.decode(tiny);
      ok(false, '宽度 2049 应被拒绝');
    } catch (e) {
      ok(/超出允许范围/.test(e.message), '宽度 2049 被拒绝', e.message);
    }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试运行异常:', e); process.exit(1); });
