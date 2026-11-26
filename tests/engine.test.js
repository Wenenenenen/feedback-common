'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const VSR = require('../app/engine.js');

/* ---------------- 小工具 ---------------- */
function f32hex(x, y) {
  const b = new ArrayBuffer(8);
  const dv = new DataView(b);
  dv.setFloat32(0, x, true);
  dv.setFloat32(4, y, true);
  return Buffer.from(b).toString('hex');
}
function u16hex(arr) {
  const b = new ArrayBuffer(arr.length * 2);
  const dv = new DataView(b);
  arr.forEach((v, i) => dv.setUint16(i * 2, v, true));
  return Buffer.from(b).toString('hex');
}
function u32hex(v) {
  const b = new ArrayBuffer(4);
  new DataView(b).setUint32(0, v >>> 0, true);
  return Buffer.from(b).toString('hex');
}
function i16hex(arr) {
  const b = new ArrayBuffer(arr.length * 2);
  const dv = new DataView(b);
  arr.forEach((v, i) => dv.setInt16(i * 2, v, true));
  return Buffer.from(b).toString('hex');
}
function drawCmd(over) {
  return Object.assign({
    op: 'draw',
    index: { b: 'ib', at: 0, type: 'u16' },
    firstIndex: 0,
    count: 3,
    baseVertex: 0,
    firstInstance: 0,
    instances: 1,
    attrs: {
      position: { b: 'vb', at: 0, stride: 8, divisor: 0, type: 'f32x2' },
      color: { b: 'cb', at: 0, stride: 4, divisor: 0, type: 'unorm8x4' }
    }
  }, over || {});
}

/* ---------------- 样例抓帧 ---------------- */
test('样例 capture：回放、写入时间线、writers', () => {
  const raw = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cases-extract', 'capture.json'), 'utf8'));
  const cap = VSR.parseCapture(raw);
  const r = new VSR.Replayer(cap);
  r.seek(1); // 执行 draw#0 时
  const t0 = r.evalTriangle(cap.commands[0], 0, 0, 0);
  assert.equal(t0.skipped, false);
  const c0 = t0.corners[0];
  assert.deepEqual(c0.vertex, 0);
  // position 非对齐读取 at=1
  assert.equal(c0.fields.position.address, 1);
  assert.equal(c0.fields.position.hex, '000040bf6666e6be');
  assert.ok(Math.abs(c0.fields.position.value[0] - -0.75) < 1e-7);
  // 初始字节 writers 全 -1
  assert.deepEqual(c0.fields.position.writers, new Array(8).fill(-1));
  // color at=9，slot0 读 9..12
  assert.equal(c0.fields.color.hex, 'e06a40ff');
  assert.deepEqual(c0.fields.color.writers, [-1, -1, -1, -1]);

  // draw#2 在 write#1 之后，color 前 3 字节被改写，第 4 字节仍是初始 ff
  r.seek(2);
  const t2 = r.evalTriangle(cap.commands[2], 2, 0, 0);
  assert.equal(t2.corners[0].fields.color.hex, 'd8b24eff');
  assert.deepEqual(t2.corners[0].fields.color.writers, [1, 1, 1, -1]);

  // 实例 offset：j=1 槽号 floor((0+1)/1)=1，读到 0.9
  const t2i1 = r.evalTriangle(cap.commands[2], 2, 1, 0);
  assert.ok(Math.abs(t2i1.corners[0].fields.offset.value[0] - 0.9) < 1e-7);
});

test('样例 probes：批量结果与字段齐全，越界 draw 报错', () => {
  const raw = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cases-extract', 'capture.json'), 'utf8'));
  const cap = VSR.parseCapture(raw);
  const probes = VSR.parseProbes(
    JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'cases-extract', 'probes.json'), 'utf8')), cap);
  const results = new VSR.Replayer(cap).runProbes(probes);
  assert.equal(results.length, 2);
  assert.deepEqual([results[0].draw, results[1].draw], [0, 2]); // 同序
  assert.equal(results[0].vertex, 0);
  assert.equal(results[0].skipped, false);
  for (const f of ['index', 'position', 'color', 'offset']) {
    assert.ok(results[0].fields[f], f);
    for (const k of ['buffer', 'address', 'hex', 'value', 'writers', 'error']) {
      assert.ok(k in results[0].fields[f]);
    }
  }
  assert.equal(results[0].fields.index.value, 0);

  assert.throws(
    () => VSR.parseProbes([{ draw: 1, instance: 0, corner: 0 }], cap),
    /不是有效的绘制/);
});

/* ---------------- 重叠拷贝：一律取命令前源字节 ---------------- */
test('同缓冲重叠 copy 取命令前字节，writers 记 copy 命令号', () => {
  const cap = VSR.parseCapture({
    buffers: { b: '0011223344556677' },
    commands: [
      { op: 'copy', src: 'b', dst: 'b', from: 0, at: 2, size: 4 }
    ]
  });
  const r = new VSR.Replayer(cap);
  r.seek(1);
  assert.equal(VSR.toHex(r.bufs.b), '0011001122336677');
  assert.deepEqual(Array.from(r.writers.b), [-1, -1, 0, 0, 0, 0, -1, -1]);
});

test('跨缓冲 copy 保留源 writers 不动，目的 writers 更新', () => {
  const cap = VSR.parseCapture({
    buffers: {
      s: 'aabbccdd',
      d: '00000000'
    },
    commands: [
      { op: 'write', b: 's', at: 1, hex: 'ee' },
      { op: 'copy', src: 's', dst: 'd', from: 0, at: 0, size: 4 }
    ]
  });
  const r = new VSR.Replayer(cap);
  r.seek(2);
  assert.equal(VSR.toHex(r.bufs.d), 'aaeeccdd');
  assert.deepEqual(Array.from(r.writers.d), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(r.writers.s), [-1, 0, -1, -1]);
});

test('零 size copy 合法且不改写', () => {
  const cap = VSR.parseCapture({
    buffers: { b: '0102' },
    commands: [{ op: 'copy', src: 'b', dst: 'b', from: 0, at: 0, size: 0 }]
  });
  const r = new VSR.Replayer(cap);
  r.seek(1);
  assert.equal(VSR.toHex(r.bufs.b), '0102');
  assert.deepEqual(Array.from(r.writers.b), [-1, -1]);
});

/* ---------------- 取数错误按角/三角形处理 ---------------- */
test('索引越界：vertex=null，只报告 index 字段', () => {
  const cap = VSR.parseCapture({
    buffers: { ib: u16hex([0, 1]), vb: f32hex(0, 0).repeat(4), cb: 'ffffffff'.repeat(4) },
    commands: [drawCmd()]
  });
  const r = new VSR.Replayer(cap);
  const t = r.evalTriangle(cap.commands[0], 0, 0, 0);
  assert.equal(t.skipped, true);
  assert.equal(t.corners[2].vertex, null);
  assert.ok(t.corners[2].fields.index.error);
  assert.equal(t.corners[2].fields.index.hex, null);
  assert.equal(t.corners[2].fields.position, undefined);
  // 前两个角本身可读
  assert.equal(t.corners[0].vertex, 0);
});

test('负顶点槽号保留原索引字节并报错', () => {
  const cap = VSR.parseCapture({
    buffers: { ib: u16hex([5, 1, 2]), vb: f32hex(0, 0).repeat(4), cb: 'ffffffff'.repeat(4) },
    commands: [drawCmd({ baseVertex: -9 })]
  });
  const r = new VSR.Replayer(cap);
  const c = r.evalCorner(cap.commands[0], 0, 0, 0);
  assert.equal(c.vertex, -4);
  assert.equal(c.fields.index.value, 5);
  assert.ok(c.fields.index.hex);
  assert.ok(/顶点槽号为负/.test(c.fields.index.error));
  assert.equal(c.fields.position, undefined);
});

test('属性越界：该字段 hex/value/writers 为 null，地址仍保留，同角其他属性仍报告', () => {
  const cap = VSR.parseCapture({
    buffers: {
      ib: u16hex([0, 1, 2]),
      vb: f32hex(0.1, 0.2) + f32hex(0.3, 0.4) + f32hex(0.5, 0.6),
      cb: 'ff0000ff' // 只够 slot0
    },
    commands: [drawCmd()]
  });
  const r = new VSR.Replayer(cap);
  const t = r.evalTriangle(cap.commands[0], 0, 0, 0);
  assert.equal(t.skipped, true); // slot1/2 color 越界
  const c1 = t.corners[1];
  assert.equal(c1.fields.color.hex, null);
  assert.equal(c1.fields.color.value, null);
  assert.equal(c1.fields.color.writers, null);
  assert.equal(typeof c1.fields.color.address, 'number'); // 地址保留
  assert.ok(/越界/.test(c1.fields.color.error));
  assert.ok(c1.fields.position.value); // position 仍可读
});

test('非有限 f32：保留 hex/writers，value=null，三角形跳过', () => {
  const nan = '0000c07f' + '00000000';
  const cap = VSR.parseCapture({
    buffers: {
      ib: u16hex([0, 1, 2]),
      vb: nan + f32hex(0.3, 0.4) + f32hex(0.5, 0.6),
      cb: 'ffffffff'.repeat(3)
    },
    commands: [drawCmd()]
  });
  const r = new VSR.Replayer(cap);
  const t = r.evalTriangle(cap.commands[0], 0, 0, 0);
  assert.equal(t.skipped, true);
  const p = t.corners[0].fields.position;
  assert.equal(p.value, null);
  assert.equal(p.hex, '0000c07f00000000');
  assert.deepEqual(p.writers, new Array(8).fill(-1));
  assert.ok(/非有限/.test(p.error));
});

test('一个角出错只跳过所属三角形，不影响其他三角形/实例', () => {
  // 两个三角形，第二个三角形的 color 缓冲只到 slot4（slot5 越界）
  const cap = VSR.parseCapture({
    buffers: {
      ib: u16hex([0, 1, 2, 3, 4, 5]),
      vb: f32hex(0, 0).repeat(6),
      cb: 'ffffffff'.repeat(5)
    },
    commands: [drawCmd({ count: 6, instances: 2 })]
  });
  const r = new VSR.Replayer(cap);
  const good = r.evalTriangle(cap.commands[0], 0, 0, 0);
  const bad = r.evalTriangle(cap.commands[0], 0, 0, 1);
  assert.equal(good.skipped, false);
  assert.equal(bad.skipped, true);
  assert.equal(bad.corners[2].vertex, 5);
  assert.ok(/越界/.test(bad.corners[2].fields.color.error));
  // 实例 1 同样结构，互不影响
  const goodI1 = r.evalTriangle(cap.commands[0], 0, 1, 0);
  assert.equal(goodI1.skipped, false);
});

/* ---------------- 步进率 / 零步长 / 基点 ---------------- */
test('实例属性 floor((firstInstance+j)/divisor)，零步长重复同址', () => {
  // offset 缓冲 16 字节，divisor=2，stride=0 => 地址恒 at
  const cap = VSR.parseCapture({
    buffers: {
      ib: u16hex([0, 1, 2]),
      vb: f32hex(0, 0).repeat(3),
      cb: 'ffffffff'.repeat(3),
      ob: f32hex(7, 8) + f32hex(9, 10)
    },
    commands: [drawCmd({
      firstInstance: 3,
      instances: 4,
      attrs: Object.assign(drawCmd().attrs, {
        offset: { b: 'ob', at: 8, stride: 0, divisor: 2, type: 'f32x2' }
      })
    })]
  });
  const r = new VSR.Replayer(cap);
  // j=0: floor(3/2)=1；j=1: floor(4/2)=2；stride=0 地址恒为 8
  for (const j of [0, 1, 2, 3]) {
    const c = r.evalCorner(cap.commands[0], 0, j, 0);
    assert.equal(c.fields.offset.address, 8);
    assert.deepEqual(c.fields.offset.value, [9, 10]);
  }
});

test('divisor 步进槽号正确', () => {
  const cap = VSR.parseCapture({
    buffers: {
      ib: u16hex([0, 1, 2]),
      vb: f32hex(0, 0).repeat(3),
      cb: 'ffffffff'.repeat(3),
      ob: f32hex(1, 0) + f32hex(2, 0) + f32hex(3, 0)
    },
    commands: [drawCmd({
      instances: 4,
      attrs: Object.assign(drawCmd().attrs, {
        offset: { b: 'ob', at: 0, stride: 8, divisor: 2, type: 'f32x2' }
      })
    })]
  });
  const r = new VSR.Replayer(cap);
  const slots = [0, 1, 2, 3].map((j) =>
    r.evalCorner(cap.commands[0], 0, j, 0).fields.offset.value[0]);
  // 槽号 floor(j/2) = 0,0,1,1 => 取值 1,1,2,2
  assert.deepEqual(slots, [1, 1, 2, 2]);
});

test('baseVertex 有符号基点', () => {
  const cap = VSR.parseCapture({
    buffers: {
      ib: u16hex([10, 11, 12]),
      vb: f32hex(0, 0).repeat(13),
      cb: 'ffffffff'.repeat(13)
    },
    commands: [drawCmd({ baseVertex: -10 })]
  });
  const r = new VSR.Replayer(cap);
  const t = r.evalTriangle(cap.commands[0], 0, 0, 0);
  assert.deepEqual(t.corners.map(c => c.vertex), [0, 1, 2]);
});

/* ---------------- 打包/归一化类型与非对齐 ---------------- */
test('snorm16x2 边界值 -32768 => -1，32767 => 1，非对齐读取', () => {
  // at=1 非对齐：字节 1..4 为 -32768(LE 0080) 与 32767(ff7f)
  const cap = VSR.parseCapture({
    buffers: {
      ib: u16hex([0, 1, 2]),
      vb: 'ff' + i16hex([-32768, 32767]) + i16hex([100, -100]) + i16hex([0, 0]),
      cb: 'ffffffff'.repeat(3)
    },
    commands: [drawCmd({
      attrs: Object.assign(drawCmd().attrs, {
        position: { b: 'vb', at: 1, stride: 4, divisor: 0, type: 'snorm16x2' }
      })
    })]
  });
  const r = new VSR.Replayer(cap);
  const c0 = r.evalCorner(cap.commands[0], 0, 0, 0);
  assert.equal(c0.fields.position.address, 1); // 非对齐
  assert.ok(Math.abs(c0.fields.position.value[0] - -1) < 1e-9);
  assert.ok(Math.abs(c0.fields.position.value[1] - 1) < 1e-9);
  // slot1：100/32767 与 -100/32767
  const c1 = r.evalCorner(cap.commands[0], 0, 0, 1);
  assert.ok(Math.abs(c1.fields.position.value[0] - 100 / 32767) < 1e-9);
  assert.ok(Math.abs(c1.fields.position.value[1] - -100 / 32767) < 1e-9);
});

test('rgb10a2unorm 位解码', () => {
  const u = 1 | (2 << 10) | (3 << 20) | (2 << 30);
  const cap = VSR.parseCapture({
    buffers: {
      ib: u16hex([0, 1, 2]),
      vb: f32hex(0, 0).repeat(3),
      cb: u32hex(u).repeat(3)
    },
    commands: [drawCmd({
      attrs: Object.assign(drawCmd().attrs, {
        color: { b: 'cb', at: 0, stride: 4, divisor: 0, type: 'rgb10a2unorm' }
      })
    })]
  });
  const r = new VSR.Replayer(cap);
  const v = r.evalCorner(cap.commands[0], 0, 0, 0).fields.color.value;
  assert.ok(Math.abs(v[0] - 1 / 1023) < 1e-12);
  assert.ok(Math.abs(v[1] - 2 / 1023) < 1e-12);
  assert.ok(Math.abs(v[2] - 3 / 1023) < 1e-12);
  assert.ok(Math.abs(v[3] - 2 / 3) < 1e-12);
});

test('u32 索引', () => {
  const cap = VSR.parseCapture({
    buffers: {
      ib: u32hex(2) + u32hex(0) + u32hex(1),
      vb: f32hex(0, 0).repeat(3),
      cb: 'ffffffff'.repeat(3)
    },
    commands: [drawCmd({
      index: { b: 'ib', at: 0, type: 'u32' }
    })]
  });
  const r = new VSR.Replayer(cap);
  const t = r.evalTriangle(cap.commands[0], 0, 0, 0);
  assert.deepEqual(t.corners.map(c => c.vertex), [2, 0, 1]);
});

/* ---------------- 跳转语义：跳到任意 draw 按当时缓冲取数 ---------------- */
test('seek 前进/后退，draw 始终看到当时的缓冲', () => {
  const cap = VSR.parseCapture({
    buffers: {
      ib: u16hex([0, 1, 2]),
      vb: f32hex(1, 1).repeat(3),
      cb: 'ffffffff'.repeat(3)
    },
    commands: [
      drawCmd(),                                   // 0
      { op: 'write', b: 'vb', at: 0, hex: f32hex(9, 9) }, // 1
      drawCmd(),                                   // 2
      { op: 'write', b: 'vb', at: 0, hex: f32hex(5, 5) }, // 3
      drawCmd()                                    // 4
    ]
  });
  const r = new VSR.Replayer(cap);
  r.seek(5);
  assert.deepEqual(
    r.evalCorner(cap.commands[4], 4, 0, 0).fields.position.value, [5, 5]);
  r.seek(3); // 回退到 draw#2 时刻
  assert.deepEqual(
    r.evalCorner(cap.commands[2], 2, 0, 0).fields.position.value, [9, 9]);
  r.seek(1); // 继续回退到 draw#0 时刻
  assert.deepEqual(
    r.evalCorner(cap.commands[0], 0, 0, 0).fields.position.value, [1, 1]);
  r.seek(5); // 再前进
  assert.deepEqual(
    r.evalCorner(cap.commands[4], 4, 0, 0).fields.position.value, [5, 5]);
});

/* ---------------- 非法抓帧拒绝并指出编号 ---------------- */
test('非法命令指出编号且不影响已加载抓帧', () => {
  const good = {
    buffers: { b: '00' },
    commands: [{ op: 'write', b: 'b', at: 0, hex: '11' }]
  };
  const cap = VSR.parseCapture(good);
  const bad = {
    buffers: { b: '00' },
    commands: [
      { op: 'write', b: 'b', at: 0, hex: '11' },
      { op: 'copy', src: 'b', dst: 'b', from: 0, at: 1, size: 99 }
    ]
  };
  try {
    VSR.parseCapture(bad);
    assert.fail('应拒绝');
  } catch (e) {
    assert.equal(e.name, 'CaptureError');
    assert.deepEqual(e.ref, { kind: 'command', index: 1 });
  }
  // 上一份抓帧仍可用
  const r = new VSR.Replayer(cap);
  r.seek(1);
  assert.equal(VSR.toHex(r.bufs.b), '11');
});

test('各类非法输入', () => {
  const base = {
    buffers: { ib: u16hex([0, 1, 2]), vb: f32hex(0, 0).repeat(3), cb: 'ffffffff'.repeat(3) },
    commands: [drawCmd()]
  };
  const cases = [
    [{ buffers: {}, commands: [{ op: 'write', b: 'x', at: 0, hex: '00' }] }, /未知缓冲/],
    [{ buffers: { b: 'zz' }, commands: [] }, /十六进制/],
    [{ buffers: { b: '00' }, commands: [{ op: 'write', b: 'b', at: 0, hex: '0' }] }, /hex/],
    [{ buffers: { b: '00' }, commands: [{ op: 'write', b: 'b', at: 0, hex: '0011' }] }, /越界/],
    [{ buffers: { b: '0000' }, commands: [{ op: 'frobnicate' }] }, /未知 op/],
    [{ buffers: base.buffers, commands: [drawCmd({ count: 4 })] }, /3 的倍数/],
    [{ buffers: base.buffers, commands: [drawCmd({ instances: 0 })] }, /instances/],
    [{ buffers: base.buffers, commands: [drawCmd({ baseVertex: 1.5 })] }, /baseVertex/],
    [{ buffers: base.buffers, commands: [drawCmd({
      attrs: { position: base.commands[0].attrs.position, color: base.commands[0].attrs.color,
        weird: { b: 'vb', at: 0, stride: 8, divisor: 0, type: 'f32x2' } } })] }, /未知属性/],
    [{ buffers: base.buffers, commands: [drawCmd({
      attrs: { position: Object.assign({}, base.commands[0].attrs.position, { type: 'u16' }),
        color: base.commands[0].attrs.color } })] }, /不接受类型/]
  ];
  for (const [json, re] of cases) {
    assert.throws(() => VSR.parseCapture(json), re);
  }
});

test('初始缓冲超限拒绝', () => {
  assert.throws(() => VSR.parseCapture({
    buffers: { big: '00'.repeat(16 * 1024 * 1024 + 1) },
    commands: []
  }), /16 MiB/);
});

/* ---------------- 探针输入校验与顺序 ---------------- */
test('探针越界与超量', () => {
  const cap = VSR.parseCapture({
    buffers: { ib: u16hex([0, 1, 2]), vb: f32hex(0, 0).repeat(3), cb: 'ffffffff'.repeat(3) },
    commands: [drawCmd()]
  });
  assert.throws(() => VSR.parseProbes([{ draw: 0, instance: 1, corner: 0 }], cap), /instance/);
  assert.throws(() => VSR.parseProbes([{ draw: 0, instance: 0, corner: 3 }], cap), /corner/);
  assert.throws(() => VSR.parseProbes(new Array(257).fill({ draw: 0, instance: 0, corner: 0 }), cap),
    /256/);
});

test('探针结果与输入同序，字段可 JSON 序列化', () => {
  const cap = VSR.parseCapture({
    buffers: { ib: u16hex([0, 1, 2]), vb: f32hex(0.1, 0.2).repeat(3), cb: 'ffffffff'.repeat(3) },
    commands: [drawCmd(), drawCmd()]
  });
  const probes = [
    { draw: 2 - 2, instance: 0, corner: 2 },
    { draw: 1, instance: 0, corner: 0 }
  ];
  const out = new VSR.Replayer(cap).runProbes(VSR.parseProbes(probes, cap));
  assert.deepEqual(out.map(r => [r.draw, r.corner]), [[0, 2], [1, 0]]);
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('综合坏数据：负槽/索引越界/属性越界混合，各角错误互不串扰', () => {
  const cap = VSR.parseCapture({
    buffers: {
      ib: u16hex([0, 1, 2]),
      vb: f32hex(0.1, 0.2) + f32hex(0.3, 0.4) + f32hex(0.5, 0.6),
      cb: 'ffffffff' // 只够 slot0
    },
    commands: [drawCmd({ baseVertex: -100, firstIndex: 2 })] // 角0/1 负槽；角2 索引读到缓冲尾后，越界
  });
  const r = new VSR.Replayer(cap);
  const t = r.evalTriangle(cap.commands[0], 0, 0, 0);
  assert.equal(t.skipped, true);
  // 角0：索引 ib[2]=2，槽 2-100=-98 负槽，保留索引字节，无属性
  assert.equal(t.corners[0].vertex, -98);
  assert.ok(t.corners[0].fields.index.hex);
  assert.equal(t.corners[0].fields.position, undefined);
  // 角1：索引 ib[3] 已越界，vertex=null，停止取属性
  const c1 = t.corners[1];
  assert.equal(c1.vertex, null);
  assert.ok(/越界/.test(c1.fields.index.error));
  assert.equal(c1.fields.position, undefined);
  // 角2：索引越界，vertex=null
  assert.equal(t.corners[2].vertex, null);
  assert.ok(/越界/.test(t.corners[2].fields.index.error));
  // cornerPoint 对坏角返回 null（供画布放警告记号）
  assert.equal(VSR.cornerPoint(t.corners[0]), null);
  assert.equal(VSR.cornerPoint(t.corners[2]), null);

  // 另一组：合法索引但属性缓冲不够，验证属性级越界与非有限值并存
  const nan = '0000c07f00000000';
  const cap2 = VSR.parseCapture({
    buffers: {
      ib: u16hex([0, 1, 2]),
      vb: nan + f32hex(0.3, 0.4) + f32hex(0.5, 0.6),
      cb: 'ffffffff'
    },
    commands: [drawCmd()]
  });
  const r2 = new VSR.Replayer(cap2);
  const t2 = r2.evalTriangle(cap2.commands[0], 0, 0, 0);
  assert.equal(t2.skipped, true);
  assert.ok(/非有限/.test(t2.corners[0].fields.position.error));
  assert.equal(t2.corners[0].fields.position.value, null);
  assert.ok(t2.corners[0].fields.position.hex);
  assert.ok(/越界/.test(t2.corners[1].fields.color.error));
  assert.equal(t2.corners[1].fields.color.hex, null);
  assert.ok(t2.corners[1].fields.position.value); // 同角其他属性照常

  // 探针导出仍可序列化
  const out = r.runProbes(VSR.parseProbes([
    { draw: 0, instance: 0, corner: 0 },
    { draw: 0, instance: 0, corner: 2 }
  ], cap));
  assert.equal(out[0].skipped, true);
  assert.equal(out[1].vertex, null);
  assert.doesNotThrow(() => JSON.stringify(out));
});

/* ---------------- 性能：满额日志 + 256 条前后半段交替探针 <2s ---------------- */
test('性能：5 万命令 / 64MiB 改写，256 交替探针 2 秒内完成', { timeout: 30000 }, () => {
  const VBO = 3 * 8;
  const CBO = 3 * 4;
  const big = new Uint8Array(4 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const cap0 = {
    buffers: {
      ib: u16hex([0, 1, 2]),
      vb: f32hex(0, 0).repeat(3),
      cb: 'ffffffff'.repeat(3),
      scratch: Buffer.from(big).toString('hex')
    },
    commands: []
  };
  // 40000 条 write（每条 1500B = 60MiB）+ 10000 条 draw
  const cmds = cap0.commands;
  const chunk = 'ab'.repeat(1500);
  for (let i = 0; i < 40000; i++) {
    cmds.push({ op: 'write', b: 'scratch', at: (i * 1500) % (big.length - 1500), hex: chunk });
  }
  for (let i = 0; i < 10000; i++) cmds.push(drawCmd());
  const cap = VSR.parseCapture(cap0);
  assert.equal(cap.commands.length, 50000);

  const drawIds = cap.commands.map((c, i) => c.op === 'draw' ? i : -1).filter(i => i >= 0);
  const half = drawIds.length / 2;
  const probes = [];
  for (let i = 0; i < 256; i++) {
    probes.push({
      draw: drawIds[i % 2 === 0 ? i / 2 : half + Math.floor(i / 2)],
      instance: 0,
      corner: i % 3
    });
  }
  const t0 = process.hrtime.bigint();
  const results = new VSR.Replayer(cap).runProbes(VSR.parseProbes(probes, cap));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, '耗时 ' + ms.toFixed(1) + 'ms 超过 2000ms');
  assert.equal(results.length, 256);
  assert.ok(results.every(r => r.fields.position && r.fields.color && r.fields.index));
});
