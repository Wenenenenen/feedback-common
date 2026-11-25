/* 合成与 PNG 编码单元测试 */
const assert = require('assert');
const zlib = require('zlib');
const C = require('../src/codec.js');

console.log('预乘反算半偶舍入：');
{
  assert.strictEqual(C.unpremultiplyExact(1, 6), 42);   // 42.5 -> 偶数42
  assert.strictEqual(C.unpremultiplyExact(1, 2), 128);  // 127.5 -> 偶数128
  assert.strictEqual(C.unpremultiplyExact(255, 255), 255);
  assert.strictEqual(C.unpremultiplyExact(0, 100), 0);
  assert.strictEqual(C.unpremultiplyExact(100, 0), 0);
  // 非中点普通四舍五入
  assert.strictEqual(C.unpremultiplyExact(10, 255), 10); // 255*10/255 = 10
  assert.strictEqual(C.unpremultiplyExact(128, 200), 163); // 163.2 -> 163
  console.log('  ✓ 42.5→42、127.5→128 等');
}

console.log('compositeFrame：');
{
  const w = 2, h = 1;
  // 两像素：fill 都是 (1,1,1)；key alpha 6、2
  const fill = { kind: 'rgb', width: w, height: h, rgb: new Uint8Array([1,1,1, 200,100,50]) };
  const key = { kind: 'gray', width: w, height: h, gray: new Uint8Array([6, 0]) };

  const pm = C.compositeFrame({ width: w, height: h, fill, key, paired: true, mode: 'premult' });
  assert.deepStrictEqual([...pm.slice(0, 4)], [42, 42, 42, 6]);
  assert.deepStrictEqual([...pm.slice(4, 8)], [0, 0, 0, 0]); // a=0 预乘清 RGB
  console.log('  ✓ premult：42 与 a0 清零');

  const st = C.compositeFrame({ width: w, height: h, fill, key, paired: true, mode: 'straight' });
  assert.deepStrictEqual([...st.slice(0, 4)], [1, 1, 1, 6]);
  assert.deepStrictEqual([...st.slice(4, 8)], [200, 100, 50, 0]); // 直通 a0 仍保留 RGB
  console.log('  ✓ straight：源色保留（含 a0 像素）');

  const un = C.compositeFrame({ width: w, height: h, fill, key: null, paired: false, mode: 'premult' });
  assert.ok(un.every((v) => v === 0));
  console.log('  ✓ 未配：RGBA 全 0');
}

console.log('PNG 编码结构 / IDAT 还原：');
{
  const w = 3, h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i*4]=i*10; rgba[i*4+1]=100; rgba[i*4+2]=200; rgba[i*4+3]=i%2?0:255; }
  const png = C.encodePNGWithDeflate(w, h, rgba, (raw) => zlib.deflateSync(raw));
  // 签名
  assert.deepStrictEqual([...png.slice(0,8)], [137,80,78,71,13,10,26,10]);
  // 收集 IDAT
  let p = 8; const idat = [];
  let ihdr = null;
  while (p < png.length) {
    const len = new DataView(png.buffer, png.byteOffset + p, 4).getUint32(0, false);
    const type = String.fromCharCode(png[p+4],png[p+5],png[p+6],png[p+7]);
    const data = png.subarray(p+8, p+8+len);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(...data);
    p += 12 + len;
  }
  assert.ok(ihdr, '有 IHDR');
  const dv = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  assert.strictEqual(dv.getUint32(0,false), w);
  assert.strictEqual(dv.getUint32(4,false), h);
  assert.strictEqual(ihdr[8], 8);  // bit depth
  assert.strictEqual(ihdr[9], 6);  // RGBA
  const raw = zlib.inflateSync(Buffer.from(idat));
  const stride = w*4;
  assert.strictEqual(raw.length, (stride+1)*h);
  // 每行 filter=0，像素逐字节一致
  for (let y=0;y<h;y++){
    assert.strictEqual(raw[y*(stride+1)], 0);
    assert.deepStrictEqual([...raw.subarray(y*(stride+1)+1, y*(stride+1)+1+stride)], [...rgba.subarray(y*stride,(y+1)*stride)]);
  }
  console.log('  ✓ PNG 签名/IHDR(RGBA8)/逐行 filter0/IDAT 解压像素一致');
}

console.log('\ncodec 测试通过');
