/* Node 测试：用样例验证 lut-core.js。运行：node -I test/lut-core.test.js <样例目录> */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const LC = require('../lut-core.js');

const dir = process.argv[2];
if (!dir) { console.error('用法: node -I test/lut-core.test.js <样例目录>'); process.exit(2); }

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS', msg); }
  else { fail++; console.log('  FAIL', msg); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }
function readCube(name) { return fs.readFileSync(path.join(dir, name), 'utf8'); }

// 1. 解析 identity.cube 并求值
{
  const lut = LC.parseCube(readCube('identity.cube'));
  ok(lut.type === '3d' && lut.size === 2, 'identity: 3D size 2');
  ok(lut.title === '测试表', 'identity: TITLE 解析');
  const out = LC.applyLut(lut, 0.3, 0.7, 0.1);
  ok(near(out[0], 0.3, 1e-12) && near(out[1], 0.7, 1e-12) && near(out[2], 0.1, 1e-12),
    `identity: 恒等映射 (${out})`);
}

// 2. probes.json 全部命中（四面体插值正确性）
{
  const lut = LC.parseCube(readCube('nonlinear.cube'));
  const probes = JSON.parse(fs.readFileSync(path.join(dir, 'probes.json'), 'utf8'));
  ok(probes.table === 'nonlinear.cube', 'probes 对应 nonlinear.cube');
  let worst = 0;
  for (const p of probes.probes) {
    const out = LC.applyLut(lut, p.input[0], p.input[1], p.input[2]);
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[c] - p.expected[c]));
  }
  ok(worst <= probes.tolerance, `probes.json 全部命中，最大偏差 ${worst.toExponential(2)} ≤ ${probes.tolerance}`);
}

// 3. 1D shaper
{
  const lut = LC.parseCube(readCube('shaper.cube'));
  ok(lut.type === '1d' && lut.size === 3, 'shaper: 1D size 3');
  let out = LC.applyLut(lut, 0.5, 0.5, 0.5);
  ok(near(out[0], 0.2, 1e-12) && near(out[1], 0.6, 1e-12) && near(out[2], 0.4, 1e-12),
    'shaper: 中点命中节点 (0.2,0.6,0.4)');
  out = LC.applyLut(lut, 0.25, 0.25, 0.25); // x=0.5，节点0/1 各半
  ok(near(out[0], 0.1, 1e-12) && near(out[1], 0.3, 1e-12) && near(out[2], 0.2, 1e-12),
    'shaper: 线性插值中点');
}

// 4. 坏文件必须报错
{
  let threw = false;
  try { LC.parseCube(readCube('bad-count.cube')); } catch (e) { threw = e instanceof LC.CubeParseError && /数据条数/.test(e.message); }
  ok(threw, 'bad-count: 数据条数不符报错');
  threw = false;
  try { LC.parseCube(readCube('bad-domain.cube')); } catch (e) { threw = e instanceof LC.CubeParseError && /DOMAIN/.test(e.message); }
  ok(threw, 'bad-domain: min>=max 报错');
}

// 5. domain-wide：宽 DOMAIN，输出超范围不夹紧
{
  const lut = LC.parseCube(readCube('domain-wide.cube'));
  const out = LC.applyLut(lut, 0, 0, 0); // 归一化 (0.25,0.25,0.25)，平手按 R,G,B
  ok(near(out[0], 0, 1e-12) && near(out[1], 0, 1e-12) && near(out[2], 0, 1e-12),
    `domain-wide: 原点映射 (${out})`);
  const over = LC.applyLut(lut, 1.5, 1.5, 1.5);
  ok(near(over[0], 1.5, 1e-12), 'domain-wide: 超范围输出不夹紧 (1.5)');
}

// 6. 链：shaper → nonlinear，级间不夹紧
{
  const shaper = LC.parseCube(readCube('shaper.cube'));
  const nl = LC.parseCube(readCube('nonlinear.cube'));
  const stages = [{ lut: shaper, enabled: true }, { lut: nl, enabled: true }];
  const inp = [0.5, 0.25, 0.75];
  const s1 = LC.applyLut(shaper, ...inp);
  const expect = LC.applyLut(nl, ...s1);
  const { out, steps } = LC.applyChain(stages, ...inp);
  ok(out.every((v, i) => near(v, expect[i], 1e-12)), '链 = 逐级手动应用');
  ok(steps.length === 2 && steps[0].input.every((v, i) => v === inp[i]), '链步骤记录输入输出');
  // 开关：禁用 shaper 后应等于直接 nonlinear
  const off = LC.applyChain([{ lut: shaper, enabled: false }, { lut: nl, enabled: true }], ...inp);
  const direct = LC.applyLut(nl, ...inp);
  ok(off.out.every((v, i) => near(v, direct[i], 1e-12)), '禁用级被跳过');
}

// 7. 烘焙：网格点应精确；含 1D shaper 的链在非对齐边长下连续探针能测到误差，且随边长下降
{
  const shaper = LC.parseCube(readCube('shaper.cube'));
  const nl = LC.parseCube(readCube('nonlinear.cube'));
  const stages = [{ lut: shaper, enabled: true }, { lut: nl, enabled: true }];
  const dom = [0, 0, 0], domMax = [1, 1, 1];
  // N=10/20：shaper 折点 0.5 不在烘焙网格上（步长 1/9、1/19），网格间必有误差
  const baked10 = LC.bakeChain(stages, dom, domMax, 10);
  const baked20 = LC.bakeChain(stages, dom, domMax, 20);
  // 网格点：烘焙表在自身网格点上应等于原链
  let gridErr = 0;
  for (let b = 0; b < 10; b++) for (let g = 0; g < 10; g++) for (let r = 0; r < 10; r++) {
    const p = [r / 9, g / 9, b / 9];
    const a = LC.applyChain(stages, ...p).out;
    const c = LC.applyLut(baked10, ...p);
    for (let k = 0; k < 3; k++) gridErr = Math.max(gridErr, Math.abs(a[k] - c[k]));
  }
  ok(gridErr < 1e-12, `烘焙网格点精确 (err=${gridErr.toExponential(2)})`);
  // 连续探针
  const probes = LC.makeProbes(dom, domMax, 500, 12345);
  const e10 = LC.compareProbes(stages, baked10, probes);
  const e20 = LC.compareProbes(stages, baked20, probes);
  ok(e10.maxErr > 1e-4, `连续探针能发现网格间误差 (N=10 max=${e10.maxErr.toExponential(2)})`);
  ok(e20.maxErr < e10.maxErr, `误差随边长下降 (N=10 ${e10.maxErr.toExponential(2)} → N=20 ${e20.maxErr.toExponential(2)})`);
}

// 8. cube 文本往返不丢精度
{
  const nl = LC.parseCube(readCube('nonlinear.cube'));
  const rt = LC.parseCube(LC.cubeToText(nl));
  let same = rt.type === nl.type && rt.size === nl.size && rt.data.length === nl.data.length;
  for (let i = 0; same && i < nl.data.length; i++) same = rt.data[i] === nl.data[i];
  ok(same, 'cubeToText → parseCube 逐位一致');
  ok(rt.domainMin.every((v, i) => v === nl.domainMin[i]), 'DOMAIN 往返一致');
}

// 9. PNG 编码：保留 alpha=0 的 RGB，可被标准 zlib 解码
(async () => {
  const w = 3, h = 2;
  const rgba = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,   // 行0：含 alpha=0 的纯蓝
    10, 20, 30, 0, 40, 50, 60, 255, 70, 80, 90, 200, // 行1：alpha=0 但 RGB=(10,20,30)
  ]);
  const png = Buffer.from(await LC.encodePng(w, h, rgba));
  ok(png[0] === 0x89 && png[1] === 0x50, 'PNG 签名');
  // 手工解 chunk
  let off = 8, idat = null, ihdr = null;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    const crc = png.readUInt32BE(off + 8 + len);
    const crcBuf = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    ok((LC.crc32(crcBuf) >>> 0) === crc, `CRC 校验: ${type}`);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat = idat ? Buffer.concat([idat, data]) : data;
    off += 12 + len;
  }
  ok(ihdr && ihdr[8] === 8 && ihdr[9] === 6, 'IHDR: 8-bit RGBA');
  const raw = zlib.inflateSync(idat);
  ok(raw.length === h * (1 + w * 4), 'IDAT 解压长度正确');
  const stride = 1 + w * 4;
  const px = (x, y) => [raw[y * stride + 1 + x * 4], raw[y * stride + 2 + x * 4], raw[y * stride + 3 + x * 4], raw[y * stride + 4 + x * 4]];
  const p = px(0, 1);
  ok(p[0] === 10 && p[1] === 20 && p[2] === 30 && p[3] === 0, 'alpha=0 像素的 RGB 原样保留');
  const q = px(2, 0);
  ok(q[0] === 0 && q[1] === 0 && q[2] === 255 && q[3] === 0, '透明蓝像素 RGB 保留');

  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
