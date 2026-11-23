// UTF-8 与 CRC-32 基础测试
import { ok, eq, group } from './harness.mjs';
import { encodeUtf8, decodeUtf8, compareBytes, countCodePoints } from '../web/src/utf8.js';
import { crc32 } from '../web/src/crc32.js';

group('utf8 编解码', () => {
  const cases = ['', 'a', 'LCP1', '中文台词', 'emoji😀🎉', '混排 A中😀\n换行', '𝄞'];
  for (const s of cases) {
    eq(decodeUtf8(encodeUtf8(s)), s, `往返 ${JSON.stringify(s)}`);
  }
  eq(Array.from(encodeUtf8('A')), [0x41], 'ASCII 单字节');
  eq(Array.from(encodeUtf8('中')), [0xe4, 0xb8, 0xad], '中文三字节');
  eq(Array.from(encodeUtf8('😀')), [0xf0, 0x9f, 0x98, 0x80], 'emoji 四字节');

  // 严格解码拒绝非法序列
  let threw = false;
  try {
    decodeUtf8(Uint8Array.of(0xe4, 0xb8));
  } catch {
    threw = true;
  }
  ok(threw, '截断序列被拒绝');
  threw = false;
  try {
    decodeUtf8(Uint8Array.of(0xf4, 0x90, 0x80, 0x80)); // U+110000 越界
  } catch {
    threw = true;
  }
  ok(threw, '越界码点被拒绝');
  threw = false;
  try {
    decodeUtf8(Uint8Array.of(0xed, 0xa0, 0x80)); // 代理项 U+D800
  } catch {
    threw = true;
  }
  ok(threw, '代理项编码被拒绝');
  threw = false;
  try {
    decodeUtf8(Uint8Array.of(0xc0, 0xaf)); // 超长编码
  } catch {
    threw = true;
  }
  ok(threw, '超长编码被拒绝');
});

group('utf8 字节序比较', () => {
  ok(compareBytes(encodeUtf8('a'), encodeUtf8('b')) < 0, 'a < b');
  ok(compareBytes(encodeUtf8('ab'), encodeUtf8('abc')) < 0, '前缀更短更小');
  ok(compareBytes(encodeUtf8('Z'), encodeUtf8('a')) < 0, '大写 Z < 小写 a（字节序）');
  ok(compareBytes(encodeUtf8('en'), encodeUtf8('zh')) < 0, 'en < zh');
  eq(compareBytes(encodeUtf8('同'), encodeUtf8('同')), 0, '相等为 0');
});

group('码点计数', () => {
  eq(countCodePoints(''), 0, '空串 0');
  eq(countCodePoints('abc'), 3, 'ASCII 3');
  eq(countCodePoints('中文'), 2, '中文 2 码点');
  eq(countCodePoints('😀🎉'), 2, '两个 emoji 2 码点（4 个 UTF-16 单元）');
  eq(countCodePoints('a中😀'), 3, '混排 3 码点');
});

group('CRC-32', () => {
  // 已知向量：CRC32("123456789") = 0xCBF43926
  eq(crc32(encodeUtf8('123456789')) >>> 0, 0xcbf43926, '标准校验向量');
  eq(crc32(new Uint8Array(0)) >>> 0, 0x00000000, '空输入 CRC 为 0');
  const a = crc32(encodeUtf8('LCP1'));
  const b = crc32(encodeUtf8('LCP1'));
  eq(a, b, '同输入稳定');
  ok(crc32(encodeUtf8('LCP2')) !== a, '不同输入不同');
});
