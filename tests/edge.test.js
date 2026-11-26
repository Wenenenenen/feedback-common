const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

function quadScene(z1, z2) {
  return {
    view: [32, 32], texture: [16, 16], base: [0, 0, 0],
    vertices: [[0, 0, z1], [8192, 0, z1], [8192, 8192, z1], [0, 8192, z1],
               [0, 0, z2], [8192, 0, z2], [8192, 8192, z2], [0, 8192, z2]],
    faces: [
      { v: [0, 1, 2], uv: [[0, 0], [4096, 0], [4096, 4096]] },
      { v: [0, 2, 3], uv: [[0, 0], [4096, 4096], [0, 4096]] },
      { v: [4, 5, 6], uv: [[0, 4096], [4096, 4096], [4096, 8192]] },
      { v: [4, 6, 7], uv: [[0, 4096], [4096, 8192], [0, 8192]] }
    ]
  };
}

test('等深面都通过可见性，两层同深纹素均可上色', () => {
  const scene = quadScene(50, 50);
  const m = C.createModel(scene);
  const tex = C.makeBaseTexture(scene);
  const patch = C.paintStroke(m, tex, { points: [[2048, 2048]], diameter: 16, rgb: [10, 20, 30], a: 255 });
  const owners = new Set();
  for (const i of patch.indices) owners.add(m.owner[i]);
  assert.ok(owners.size >= 2, '等深的不同归属面纹素都应上色');
});

test('半开预览范围：投影在预览外的纹素 inView=0，边界点判定正确', () => {
  const scene = {
    view: [16, 16], texture: [16, 16], base: [0, 0, 0],
    // 屏幕三角形整体在画面左上之外，UV 却在纹理内 → 归属纹素投影全部出界
    vertices: [[-8192, -8192, 5], [-1024, -8192, 5], [-1024, -1024, 5]],
    faces: [{ v: [0, 1, 2], uv: [[128, 128], [3968, 128], [3968, 3968]] }]
  };
  const m = C.createModel(scene);
  let outCount = 0;
  for (let i = 0; i < m.nTex; i++) if (m.owner[i] === 0 && !m.inView[i]) outCount++;
  assert.ok(outCount > 0, '应有投影出半开范围的归属纹素');
  const info = C.pickTexel(m, 0, 0);
  assert.equal(info.owner, 0);
  assert.equal(info.inView, false);
  assert.equal(info.front, null); // 选中纹素最前深度显示为无
  // 半开边界：恰在边界上的点算界外
  assert.equal(C.frontDepthAt(m, 0, 0), null);
});

test('半开预览范围：界内最前深度可取，右/下边界外不可取', () => {
  const scene = {
    view: [8, 8], texture: [8, 8], base: [0, 0, 0],
    vertices: [[0, 0, 5], [2048, 0, 5], [2048, 2048, 5]],
    faces: [{ v: [0, 1, 2], uv: [[0, 0], [2048, 0], [2048, 2048]] }]
  };
  const m = C.createModel(scene);
  assert.equal(C.frontDepthAt(m, 2048, 1024), null); // x=2048 恰在右边界外
  assert.equal(C.frontDepthAt(m, 1024, 2048), null); // y=2048 恰在下边界外
  assert.ok(C.frontDepthAt(m, 2047, 1024));
  assert.ok(C.frontDepthAt(m, 0, 0));
});

test('直径 1 的笔刷：半径 0.5px，只覆盖距离 <=128 定点的纹素', () => {
  const scene = {
    view: [16, 16], texture: [16, 16], base: [0, 0, 0],
    vertices: [[0, 0, 5], [4096, 0, 5], [4096, 4096, 5]],
    faces: [{ v: [0, 1, 2], uv: [[0, 0], [4096, 0], [4096, 4096]] }]
  };
  const m = C.createModel(scene);
  const tex = C.makeBaseTexture(scene);
  const patch = C.paintStroke(m, tex, { points: [[384, 384]], diameter: 1, rgb: [9, 9, 9], a: 255 });
  for (const i of patch.indices) {
    const d2 = C.distToPolylineSq(m.projX[i], m.projY[i], [[384, 384]]);
    assert.ok(d2 <= 128 * 128);
  }
  assert.ok(patch.count >= 1);
});

test('折线笔刷：段上垂足与端点圆都生效', () => {
  // 距离函数本身
  const pts = [[0, 0], [1000, 0]];
  assert.equal(C.distToPolylineSq(500, 100, pts), 10000); // 垂足
  assert.equal(C.distToPolylineSq(-30, 40, pts), 2500);   // 端点圆
  assert.equal(C.distToPolylineSq(1100, 0, pts), 10000);   // 尾端点圆
  // 单点
  assert.equal(C.distToPolylineSq(3, 4, [[0, 0]]), 25);
  // 零长段退化为点
  assert.equal(C.distToPolylineSq(3, 4, [[0, 0], [0, 0]]), 25);
});

test('撤销补丁回放：恢复原值后纹理与涂抹前一致', () => {
  const scene = {
    view: [16, 16], texture: [8, 8], base: [50, 60, 70],
    vertices: [[0, 0, 5], [4096, 0, 5], [4096, 4096, 5]],
    faces: [{ v: [0, 1, 2], uv: [[0, 0], [2048, 0], [2048, 2048]] }]
  };
  const m = C.createModel(scene);
  const tex = C.makeBaseTexture(scene);
  const before = tex.slice();
  const patch = C.paintStroke(m, tex, { points: [[1024, 1024]], diameter: 10, rgb: [1, 2, 3], a: 128 });
  assert.ok(patch.count > 0);
  for (let k = 0; k < patch.indices.length; k++) {
    const o = patch.indices[k] * 3;
    tex[o] = patch.old[k * 3]; tex[o + 1] = patch.old[k * 3 + 1]; tex[o + 2] = patch.old[k * 3 + 2];
  }
  assert.deepEqual(Array.from(tex), Array.from(before));
});

test('笔画校验：点数/直径/透明度/颜色越界', () => {
  assert.ok(C.validateStroke({ points: [], diameter: 4, rgb: [1, 1, 1], a: 10 }));
  assert.ok(C.validateStroke({ points: [[0, 0]], diameter: 0, rgb: [1, 1, 1], a: 10 }));
  assert.ok(C.validateStroke({ points: [[0, 0]], diameter: 65, rgb: [1, 1, 1], a: 10 }));
  assert.ok(C.validateStroke({ points: [[0, 0]], diameter: 4, rgb: [1, 1, 1], a: 256 }));
  assert.ok(C.validateStroke({ points: [[0, 0]], diameter: 4, rgb: [1, 1, 256], a: 10 }));
  assert.equal(C.validateStroke({ points: [[0, 0]], diameter: 1, rgb: [0, 0, 0], a: 0 }), null);
  assert.equal(C.validateStroke({ points: Array.from({ length: 256 }, () => [0, 0]), diameter: 64, rgb: [255, 255, 255], a: 255 }), null);
});
