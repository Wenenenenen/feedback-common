/*
 * 内核单元测试 + 性能压测（node tests/engine.test.js）
 * 纯 node:assert，无第三方依赖。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const FB = require('../engine.js');
const { exportVcd, exportJson } = require('../exporter.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

function waveOf(res, netName) {
  const wf = res.wave.find(w => w.name === netName);
  return wf.times.map((t, i) => `${t}:${FB.formatValue(wf.lo[i], wf.hi[i], wf.width)}`);
}

console.log('1) 样例 factory-bus.json（TRI 延迟 + 初态 + 透传）');
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '../samples/factory-bus.json'), 'utf8'));
test('模型合法', () => assert.equal(FB.validateModel(sample).length, 0));
const r0 = FB.run(sample);
test('运行成功', () => assert.equal(r0.ok, true));
test('src 波形 0:01 -> 6:10', () => assert.deepEqual(waveOf(r0, 'src'), ['0:01', '6:10']));
test('en 波形 0:1', () => assert.deepEqual(waveOf(r0, 'en'), ['0:1']));
test('bus 初态Z -> t2透传01 -> t8透传10', () =>
  assert.deepEqual(waveOf(r0, 'bus'), ['0:ZZ', '2:01', '8:10']));
test('空档不产生记录（bus 时刻仅 0/2/8）', () =>
  assert.deepEqual(r0.wave.find(w => w.name === 'bus').times, [0, 2, 8]));
test('处理时刻不超过 until', () => assert.ok(r0.times[r0.times.length - 1] <= r0.until));

console.log('2) 惯性延迟：短脉冲被门延迟吞掉，长脉冲通过');
// NOT 延迟3；输入初值0（输出排队1@3），t4 短暂变1（排队0@7），t5 变回0（撤销0@7）
const inertial = {
  until: 10,
  nets: { a: 1, y: 1 },
  ports: { p: 'a' },
  gates: [{ id: 'g1', op: 'NOT', in: ['a'], out: 'y', delay: 3 }],
  writes: [[0, 'p', '0'], [4, 'p', '1'], [5, 'p', '0']],
};
test('短脉冲未通过（输出只有 t3 的初态响应 1）', () =>
  assert.deepEqual(waveOf(FB.run(inertial), 'y'), ['0:Z', '3:1']));

// 长脉冲：t4 变1、t8 变0，间隔 4 > 延迟3 -> 输出 t7 变0，t11 超 until 丢弃
const longPulse = {
  until: 10,
  nets: { a: 1, y: 1 },
  ports: { p: 'a' },
  gates: [{ id: 'g1', op: 'NOT', in: ['a'], out: 'y', delay: 3 }],
  writes: [[0, 'p', '0'], [4, 'p', '1'], [8, 'p', '0']],
};
test('长脉冲通过（t3=1，t7=0）', () =>
  assert.deepEqual(waveOf(FB.run(longPulse), 'y'), ['0:Z', '3:1', '7:0']));

// 排队后目标回到当前值 -> 撤销（t0 输入0 排队1@4；t1 变1 排队0@5；t2 变回0 撤销0@5）
const replace = {
  until: 10,
  nets: { a: 1, y: 1 },
  ports: { p: 'a' },
  gates: [{ id: 'g1', op: 'NOT', in: ['a'], out: 'y', delay: 4 }],
  writes: [[0, 'p', '0'], [1, 'p', '1'], [2, 'p', '0']],
};
test('目标回到当前值时撤销排队（只剩初态响应 t6=1）', () =>
  assert.deepEqual(waveOf(FB.run(replace), 'y'), ['0:Z', '6:1']));

// 两位总线逐位独立：t0 a=00 排队11@4；t1 a=11 替换为00@5；
// t3 a=10：bit0 目标回到1（撤销其0@5），bit1 的 0@5 保留；t5 后 bit0 再次排队1@7
const bitwise = {
  until: 12,
  nets: { a: 2, y: 2 },
  ports: { p: 'a' },
  gates: [{ id: 'g1', op: 'NOT', in: ['a'], out: 'y', delay: 4 }],
  writes: [[0, 'p', '00'], [1, 'p', '11'], [3, 'p', '10']],
};
test('逐位独立排队：t5 仅 bit1 翻转为 0（bit0 撤销保持 Z），t7 bit0 翻为 1', () =>
  assert.deepEqual(waveOf(FB.run(bitwise), 'y'), ['0:ZZ', '5:0Z', '7:01']));

console.log('3) DFF：只认最终时钟 0->1，Z 数据采成 X，传输延迟保留每次采样');
const dff = {
  until: 14,
  nets: { d: 1, clk: 1, q: 1 },
  ports: { pd: 'd', pc: 'clk' },
  gates: [{ id: 'ff', op: 'DFF', in: ['d', 'clk'], out: 'q', delay: 2 }],
  // t1 时钟到0；t2 上升沿采1 -> q@4=1；t3 数据显式置Z、时钟回0；
  // t5 上升沿采Z -> q@7=X；t6 回0；t9 数据置0；t10 上升沿采0 -> q@12=0
  writes: [
    [1, 'pc', '0'],
    [2, 'pc', '1'], [2, 'pd', '1'],
    [3, 'pc', '0'], [3, 'pd', 'Z'],
    [5, 'pc', '1'],
    [6, 'pc', '0'],
    [9, 'pd', '0'],
    [10, 'pc', '1'],
  ],
};
const r2 = FB.run(dff);
test('DFF 波形 Z -> t4=1 -> t7=X -> t12=0', () =>
  assert.deepEqual(waveOf(r2, 'q'), ['0:Z', '4:1', '7:X', '12:0']));
test('DFF 初态 Z，t0 不触发', () => assert.equal(waveOf(r2, 'q')[0], '0:Z'));

// 初态 Z 直接到 1 不算 0->1
const noEdge = {
  until: 6,
  nets: { d: 1, clk: 1, q: 1 },
  ports: { pd: 'd', pc: 'clk' },
  gates: [{ id: 'ff', op: 'DFF', in: ['d', 'clk'], out: 'q', delay: 1 }],
  writes: [[4, 'pc', '1'], [4, 'pd', '1']],
};
test('Z->1 不算上升沿（输出保持 Z）', () =>
  assert.deepEqual(waveOf(FB.run(noEdge), 'q'), ['0:Z']));

// 同刻时钟最终为 0：不采样
const noEdge2 = {
  until: 6,
  nets: { d: 1, clk: 1, q: 1 },
  ports: { pd: 'd', pc: 'clk' },
  gates: [{ id: 'ff', op: 'DFF', in: ['d', 'clk'], out: 'q', delay: 1 }],
  writes: [[1, 'pc', '0'], [4, 'pc', '0'], [4, 'pd', '1']],
};
test('最终时钟非上升沿不采样', () =>
  assert.deepEqual(waveOf(FB.run(noEdge2), 'q'), ['0:Z']));

// 连续上升沿：延迟输出的每次采样都保留（传输队列，不做惯性合并）
const dffQueue = {
  until: 8,
  nets: { d: 1, clk: 1, q: 1 },
  ports: { pd: 'd', pc: 'clk' },
  gates: [{ id: 'ff2', op: 'DFF', in: ['d', 'clk'], out: 'q', delay: 3 }],
  writes: [
    [0, 'pc', '0'], [0, 'pd', '1'],
    [1, 'pc', '1'], [2, 'pc', '0'], [2, 'pd', '0'],
    [3, 'pc', '1'], [4, 'pc', '0'], [4, 'pd', '1'],
    [5, 'pc', '1'], [6, 'pc', '0'],
  ],
};
test('DFF 传输队列保留每次采样（t4=1 t6=0 t8=1）', () =>
  assert.deepEqual(waveOf(FB.run(dffQueue), 'q'), ['0:Z', '4:1', '6:0', '8:1']));

console.log('4) 线网解算：无驱动 Z、冲突 X、逐位忽略 Z 驱动');
const conflict = {
  until: 4,
  nets: { bus: 2 },
  ports: { a: 'bus', b: 'bus' },
  gates: [],
  writes: [
    [1, 'a', '0Z'],
    [2, 'b', '1Z'],
    [3, 'a', 'ZZ'],
  ],
};
const r3 = FB.run(conflict);
test('Z 驱动逐位忽略', () => assert.deepEqual(waveOf(r3, 'bus')[1], '1:0Z'));
test('冲突位变 X', () => assert.deepEqual(waveOf(r3, 'bus')[2], '2:XZ'));
test('撤驱动后恢复单驱值', () => assert.deepEqual(waveOf(r3, 'bus')[3], '3:1Z'));

const xDrive = {
  until: 2, nets: { s: 1 }, ports: { a: 's', b: 's' }, gates: [],
  writes: [[1, 'a', 'X'], [1, 'b', '1']],
};
test('X 与任何驱动同在均为 X', () =>
  assert.deepEqual(waveOf(FB.run(xDrive), 's'), ['0:Z', '1:X']));

console.log('5) AND / OR 四值规则（门输出初态 Z）');
const gates4 = {
  until: 2,
  nets: { a: 1, b: 1, x1: 1, x2: 1 },
  ports: { pa: 'a', pb: 'b' },
  gates: [
    { id: 'and1', op: 'AND', in: ['a', 'b'], out: 'x1', delay: 1 },
    { id: 'or1', op: 'OR', in: ['a', 'b'], out: 'x2', delay: 1 },
  ],
  writes: [[1, 'pa', '0'], [1, 'pb', 'Z']],
};
const r4 = FB.run(gates4);
test('AND 遇 0 为 0（忽略另一路 Z）', () => assert.deepEqual(waveOf(r4, 'x1'), ['0:Z', '1:X', '2:0']));
test('OR 无 1 且含 Z 按 X 读（t0 全 Z 即得 X，t1 到期后值不变）', () =>
  assert.deepEqual(waveOf(r4, 'x2'), ['0:Z', '1:X']));

console.log('6) 同刻同端口后项覆盖（中间值不泄漏）');
const override = {
  until: 2, nets: { s: 1 }, ports: { p: 's' }, gates: [],
  writes: [[1, 'p', '0'], [1, 'p', '1']],
};
const rOv = FB.run(override);
test('后项覆盖，最终为 1', () => assert.deepEqual(waveOf(rOv, 's'), ['0:Z', '1:1']));
test('驱动历史无中间值', () => {
  const h = rOv.driverHist[0];
  assert.deepEqual(h.times, [1]);
  assert.deepEqual([h.lo[0], h.hi[0]], [1, 1]);
});

console.log('7) 坏连接指出门号，且不产生结果');
const bad = {
  until: 3, nets: { a: 1, y: 2 }, ports: { p: 'a' },
  gates: [{ id: 'bad-gate', op: 'NOT', in: ['a'], out: 'y', delay: 1 }],
  writes: [],
};
test('位宽不一致报错带门号', () => assert.equal(FB.validateModel(bad)[0].gateId, 'bad-gate'));
test('run 返回 ok:false', () => assert.equal(FB.run(bad).ok, false));
const bad2 = {
  until: 3, nets: { a: 1, y: 1 }, ports: { p: 'a' },
  gates: [{ id: 'g', op: 'NOT', in: ['nope'], out: 'y', delay: 1 }], writes: [],
};
test('悬空输入指出门号', () => assert.equal(FB.validateModel(bad2)[0].gateId, 'g'));
const bad3 = { until: 3, nets: { s: 1 }, ports: { p: 's' }, gates: [], writes: [[1, 'p', '00']] };
test('写入位宽错误被拒', () => assert.equal(FB.validateModel(bad3).length, 1));
const bad4 = { until: 3, nets: { s: 1 }, ports: { p: 's' }, gates: [], writes: [[-1, 'p', '0']] };
test('负时刻被拒', () => assert.equal(FB.validateModel(bad4).length, 1));

console.log('8) 重演一致性自检 + VCD 四值导出');
test('样例重演与首演波形完全一致', () => assert.equal(FB.verifyReplay(sample, r0).ok, true));
test('DFF 用例重演一致', () => assert.equal(FB.verifyReplay(dff, r2).ok, true));
test('VCD 含四值与总线向量格式', () => {
  const vcd = exportVcd(r0);
  assert.ok(vcd.includes('$timescale 1tick $end'));
  assert.ok(vcd.includes('$enddefinitions $end'));
  assert.ok(/b01 \S+/.test(vcd)); // 总线向量
  const rX = FB.run(xDrive);
  const vcdX = exportVcd(rX);
  assert.ok(/x\S*\n|^x/m.test(vcdX) || vcdX.includes('x')); // X 值保留
});

console.log('9) 驱动来源回溯（valueAt 二分查找）');
test('任意时刻可回溯门驱动值', () => {
  const info = r0.driverInfo.find(d => d.kind === 'gate' && d.ref === 'gate');
  const h = r0.driverHist[info.id];
  assert.equal(FB.formatValue(FB.valueAt(h, 2).lo, FB.valueAt(h, 2).hi, 2), '01');
  assert.equal(FB.formatValue(FB.valueAt(h, 7).lo, FB.valueAt(h, 7).hi, 2), '01');
  assert.equal(FB.formatValue(FB.valueAt(h, 99).lo, FB.valueAt(h, 99).hi, 2), '10');
});
test('早于首条驱动记录返回 null（驱动此前为隐式初态 Z）', () => {
  const info = r0.driverInfo.find(d => d.kind === 'gate');
  assert.equal(FB.valueAt(r0.driverHist[info.id], 1), null);
});

console.log('10) 性能压测：4096 个独立反相门 + 合计 20 万次交替写入（含导出）');
{
  const G = 4096, W = 200000;
  const nets = {};
  const ports = {};
  const gates = [];
  for (let i = 0; i < G; i++) {
    nets[`a${i}`] = 1; nets[`y${i}`] = 1;
    ports[`p${i}`] = `a${i}`;
    gates.push({ id: `inv${i}`, op: 'NOT', in: [`a${i}`], out: `y${i}`, delay: 1 });
  }
  // 轮转写入：同门两次写入相隔 4096 刻 > 延迟，事件全部通过，最大吞吐
  const writes = new Array(W);
  for (let k = 0; k < W; k++) {
    writes[k] = [1 + k, `p${k % G}`, k % 2 === 0 ? '1' : '0'];
  }
  const model = { until: W + 2, nets, ports, gates, writes };

  const t0 = performance.now();
  const res = FB.run(model);
  const t1 = performance.now();
  assert.equal(res.ok, true);
  const vcd = exportVcd(res);
  const json = exportJson(res);
  const t2 = performance.now();

  const memMB = process.memoryUsage().heapUsed / 1048576;
  let changes = 0;
  for (const wf of res.wave) changes += wf.times.length;
  console.log(`    门=${G} 写入=${W} 内核=${(t1 - t0).toFixed(0)}ms 含导出=${(t2 - t0).toFixed(0)}ms 堆=${memMB.toFixed(0)}MB 变值=${changes} VCD=${(vcd.length / 1048576).toFixed(1)}MB JSON=${(json.length / 1048576).toFixed(1)}MB`);
  assert.ok(t2 - t0 < 10000, `运行到可导出 ${(t2 - t0).toFixed(0)}ms 超 10s`);
  assert.ok(memMB < 3000, `堆内存 ${memMB.toFixed(0)}MB 超预算`);
  passed++; console.log('  ✓ 10 秒预算内完成且内存可控');

  const vr = FB.verifyReplay(model, res);
  assert.equal(vr.ok, true, vr.reason);
  passed++; console.log('  ✓ 压测场景重演一致');

  // 导出内容可被重新解析，且与波形一致
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed.nets) && parsed.nets.length === G * 2);
  const one = parsed.nets.find(n => n.name === 'y0');
  assert.ok(one.changes.length > 0);
  passed++; console.log('  ✓ JSON 导出可解析且结构完整');
}

console.log(`\n${passed} 项通过${process.exitCode ? '（存在失败）' : '，全部通过'}`);
