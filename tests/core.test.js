const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

// 样例展板：底板两面（z=40），铭牌两面（z=20）
function sampleScene() {
  return {
    view: [160, 104], texture: [160, 96], base: [212, 221, 224],
    vertices: [
      [4096, 4096, 40], [36864, 4096, 40], [36864, 22528, 40], [4096, 22528, 40],
      [18944, 10496, 20], [28672, 10496, 20], [28672, 17920, 20], [18944, 17920, 20]
    ],
    faces: [
      { v: [0, 1, 2], uv: [[2048, 2048], [18432, 2048], [18432, 20480]] },
      { v: [0, 2, 3], uv: [[22528, 2048], [38912, 20480], [22528, 20480]] },
      { v: [4, 5, 6], uv: [[2560, 15360], [7680, 15360], [7680, 20480]] },
      { v: [4, 6, 7], uv: [[2560, 15360], [7680, 20480], [2560, 20480]] }
    ]
  };
}

test('validateScene: 接受合法场景（含样例）', () => {
  assert.equal(C.validateScene(sampleScene()), null);
});

test('validateScene: 逐字段报错', () => {
  const bad = sampleScene();
  bad.view = [0, 104];
  assert.match(C.validateScene(bad), /view\[0\]/);
  const bad2 = sampleScene();
  bad2.vertices[0][2] = -1;
  assert.match(C.validateScene(bad2), /vertices\[0\]\[2\]/);
  const bad3 = sampleScene();
  bad3.faces[1].v[0] = 99;
  assert.match(C.validateScene(bad3), /faces\[1\]\.v\[0\]/);
  const bad4 = sampleScene();
  bad4.faces[0].uv[1][0] = 160 * 256 + 1;
  assert.match(C.validateScene(bad4), /uv\[1\]\[0\]/);
  const bad5 = sampleScene();
  bad5.base = [1, 2];
  assert.match(C.validateScene(bad5), /base/);
  const bad6 = sampleScene();
  bad6.view = [513, 104];
  assert.match(C.validateScene(bad6), /view\[0\]/);
  const bad7 = sampleScene();
  bad7.vertices.push([1, 2]);
  assert.match(C.validateScene(bad7), /vertices\[\d+\]/);
});

test('validateScene: 退化三角形与 UV 重叠合法', () => {
  const s = sampleScene();
  s.faces.push({ v: [0, 0, 1], uv: [[256, 256], [256, 256], [512, 512]] }); // 双重退化
  s.faces.push(JSON.parse(JSON.stringify(s.faces[0]))); // 完全重叠 UV
  assert.equal(C.validateScene(s), null);
});

test('纹素归属：面号最小优先（重叠），未归属为 -1', () => {
  const scene = {
    view: [32, 32], texture: [16, 16], base: [0, 0, 0],
    vertices: [[0, 0, 10], [8192, 0, 10], [8192, 8192, 10]],
    faces: [
      { v: [0, 1, 2], uv: [[0, 0], [8192, 0], [8192, 8192]] },
      { v: [0, 1, 2], uv: [[0, 0], [8192, 0], [8192, 8192]] } // 同 UV 重叠，面号 1
    ]
  };
  const m = C.createModel(scene);
  assert.equal(m.owner[5 * 16 + 5], 0);
  assert.equal(m.owner[0], 0); // 纹素中心 (128,128) 在面 0 内
  // 纹素 (15,15) 中心 (3968,3968) 恰在斜边 u=v 上，边包含 → 仍归属小面号 0
  assert.equal(m.owner[15 * 16 + 15], 0);
  // 斜边外侧（v>u 区域）无归属
  assert.equal(m.owner[15 * 16 + 0], -1);
});

test('纹素归属：共边两侧归属各自的面，共边纹素取小面号', () => {
  // 屏幕一个四边形拆两个同向三角形；UV 上两个岛在 u=4096 处共边
  const scene = {
    view: [32, 32], texture: [32, 32], base: [10, 10, 10],
    vertices: [[0, 0, 5], [8192, 0, 5], [8192, 8192, 5], [0, 8192, 5]],
    faces: [
      // 面0：UV 左岛，逆时针，右边是共边 (4096,0)-(4096,8192)
      { v: [0, 1, 2], uv: [[0, 0], [4096, 0], [4096, 8192]] },
      // 面1：屏幕同绕序 (0,2,3) 为顺时针对应 UV 右岛，顶点序与屏幕一致
      { v: [0, 2, 3], uv: [[4096, 0], [8192, 8192], [4096, 8192]] }
    ]
  };
  const m = C.createModel(scene);
  // 纹素 x=15 中心 u=3968 在左岛(面0)；x=16 中心 u=4224 在右岛(面1)
  assert.equal(m.owner[10 * 32 + 15], 0);
  assert.equal(m.owner[10 * 32 + 16], 1);
  assert.equal(m.owner[20 * 32 + 15], 0);
  assert.equal(m.owner[20 * 32 + 16], 1);
});

test('UV 退化面不产生归属', () => {
  const scene = {
    view: [32, 32], texture: [16, 16], base: [0, 0, 0],
    vertices: [[0, 0, 5], [8192, 0, 5], [8192, 8192, 5]],
    faces: [
      { v: [0, 1, 2], uv: [[256, 256], [512, 256], [768, 256]] }, // UV 共线
    ]
  };
  const m = C.createModel(scene);
  assert.ok(m.owner.every((o) => o === -1));
});

test('可见性：铭牌挡住底板，等深面都通过', () => {
  const m = C.createModel(sampleScene());
  // 铭牌中心屏幕约 (23808, 14208)，像素 (93,55)
  const front = C.frontDepthAt(m, 23808, 14208);
  assert.ok(front);
  assert.equal(front.depth, 20);
  // 底板区域（无铭牌）深度 40
  const back = C.frontDepthAt(m, 6000, 6000);
  assert.equal(back.depth, 40);
});

test('被遮挡纹素不上色，铭牌纹素上色', () => {
  const scene = sampleScene();
  const m = C.createModel(scene);
  const tex = C.makeBaseTexture(scene);
  // 笔刷直径 8（半径 4px=1024 定点），落在铭牌中心
  const stroke = { points: [[23808, 14208]], diameter: 8, rgb: [255, 0, 0], a: 255 };
  const patch = C.paintStroke(m, tex, stroke);
  assert.ok(patch.count > 0);
  // 铭牌 UV 纹素（面2/3 的 UV 区域 u≈10..30 纹素, v≈60..80）应有红
  let redCount = 0;
  for (let i = 0; i < m.nTex; i++) if (tex[i * 3] === 255) redCount++;
  assert.ok(redCount > 0);
  // 底板纹素（面0/1 的 UV 区，投影点在铭牌下）不能红：统计红纹素全部归属面 2/3
  for (let i = 0; i < m.nTex; i++) {
    if (tex[i * 3] === 255) assert.ok(m.owner[i] >= 2, `纹素 ${i} 属面 ${m.owner[i]} 不应上色`);
  }
});

test('跨 UV 接缝的两岛同时上色（共边屏幕三角形）', () => {
  // 一个屏幕四边形拆两个三角，UV 拆成两个不相邻的岛
  const scene = {
    view: [64, 64], texture: [64, 64], base: [100, 100, 100],
    vertices: [[2560, 2560, 7], [13824, 2560, 7], [13824, 13824, 7], [2560, 13824, 7]],
    faces: [
      { v: [0, 1, 2], uv: [[256, 256], [7936, 256], [7936, 7936]] },        // 岛 A
      { v: [0, 2, 3], uv: [[8448, 256], [16128, 7936], [8448, 7936]] }       // 岛 B
    ]
  };
  const m = C.createModel(scene);
  const tex = C.makeBaseTexture(scene);
  // 笔刷横跨屏幕对角线接缝
  const stroke = { points: [[2560, 8192], [13824, 8192]], diameter: 6, rgb: [0, 255, 0], a: 255 };
  const patch = C.paintStroke(m, tex, stroke);
  const owners = new Set();
  for (const i of patch.indices) owners.add(m.owner[i]);
  assert.ok(owners.has(0) && owners.has(1), '接缝两侧 UV 岛都应上色');
});

test('一笔经过同一纹素多次只混一次', () => {
  const scene = {
    view: [32, 32], texture: [16, 16], base: [0, 0, 0],
    // 单三角形：屏幕与 UV 同绕序，纹素 0 中心 (128,128) 投影到 (128,128)
    vertices: [[0, 0, 5], [8192, 0, 5], [8192, 8192, 5]],
    faces: [{ v: [0, 1, 2], uv: [[0, 0], [4096, 0], [4096, 4096]] }]
  };
  const m = C.createModel(scene);
  const t1 = C.makeBaseTexture(scene);
  const t2 = C.makeBaseTexture(scene);
  // 两笔覆盖同一区域：一笔折线来回经过，一笔单点；去重后结果必须一致
  const pts = [[1024, 1024], [3072, 1024], [1024, 1024], [3072, 1024], [1024, 1024]];
  C.paintStroke(m, t1, { points: pts, diameter: 10, rgb: [255, 255, 255], a: 128 });
  C.paintStroke(m, t2, { points: [[512, 256]], diameter: 16, rgb: [255, 255, 255], a: 128 });
  // 只比较两笔都覆盖到的纹素
  let compared = 0;
  for (let i = 0; i < m.nTex; i++) {
    if (t1[i * 3] !== 0 && t2[i * 3] !== 0) {
      compared++;
      assert.deepEqual([t1[i * 3], t1[i * 3 + 1], t1[i * 3 + 2]],
        [t2[i * 3], t2[i * 3 + 1], t2[i * 3 + 2]]);
    }
  }
  assert.ok(compared > 0);
  // 公式校验 floor(((255-128)*0 + 128*255 + 127)/255) = floor(32767/255) = 128
  // 纹素 0 中心投影 (512,256)，即单点笔中心
  assert.equal(t2[0], 128);
});

test('a=0 不改色且不产生补丁；a=255 直接覆盖', () => {
  const scene = {
    view: [16, 16], texture: [8, 8], base: [10, 20, 30],
    vertices: [[0, 0, 5], [4096, 0, 5], [4096, 4096, 5]],
    faces: [{ v: [0, 1, 2], uv: [[0, 0], [2048, 0], [2048, 2048]] }]
  };
  const m = C.createModel(scene);
  const tex = C.makeBaseTexture(scene);
  const p0 = C.paintStroke(m, tex, { points: [[1024, 1024]], diameter: 8, rgb: [9, 9, 9], a: 0 });
  assert.equal(p0.count, 0);
  assert.deepEqual([tex[0], tex[1], tex[2]], [10, 20, 30]);
  C.paintStroke(m, tex, { points: [[1024, 1024]], diameter: 8, rgb: [7, 8, 9], a: 255 });
  // 纹素 (2,2) 中心 UV(640,640) 同值投影，距笔中心 ≈543 < 半径 1024
  const off = (2 * 8 + 2) * 3;
  assert.deepEqual([tex[off], tex[off + 1], tex[off + 2]], [7, 8, 9]);
});

test('半格取较大值 halfUp', () => {
  assert.equal(C.halfUp(2.5), 3);
  assert.equal(C.halfUp(-2.5), -3);
  assert.equal(C.halfUp(2.4), 2);
  assert.equal(C.halfUp(-2.4), -2);
  assert.equal(C.halfUp(0.5), 1);
  assert.equal(C.halfUp(-0.5), -1);
});

test('预览：背景色、等深小面号、纹理采样', () => {
  const m = C.createModel(sampleScene());
  const tex = C.makeBaseTexture(sampleScene());
  const { rgba } = C.renderPreview(m, tex);
  // 角落背景
  assert.deepEqual([rgba[0], rgba[1], rgba[2]], C.BG);
  // 底板像素 (20,20) 中心 (5248,5248) 采到基色
  const i = (20 * 160 + 20) * 4;
  assert.deepEqual([rgba[i], rgba[i + 1], rgba[i + 2]], [212, 221, 224]);
});

test('预览与纹理同步：涂色后预览对应像素变色', () => {
  const scene = sampleScene();
  const m = C.createModel(scene);
  const tex = C.makeBaseTexture(scene);
  C.paintStroke(m, tex, { points: [[23808, 14208]], diameter: 8, rgb: [255, 0, 0], a: 255 });
  const { rgba } = C.renderPreview(m, tex);
  const i = (55 * 160 + 93) * 4;
  assert.deepEqual([rgba[i], rgba[i + 1], rgba[i + 2]], [255, 0, 0]);
});

test('pickTexel: 归属面/投影坐标/最前深度；出界为无', () => {
  const m = C.createModel(sampleScene());
  // 找一个铭牌归属纹素
  let ti = -1;
  for (let i = 0; i < m.nTex; i++) if (m.owner[i] >= 2) { ti = i; break; }
  const tx = ti % 160, ty = Math.floor(ti / 160);
  const info = C.pickTexel(m, tx, ty);
  assert.equal(info.owner, m.owner[ti]);
  assert.ok(info.inView);
  assert.ok(info.front);
  assert.equal(info.front.depth, 20);
  // 未归属纹素
  const none = C.pickTexel(m, 150, 90);
  assert.equal(none.owner, -1);
});

test('pickTexel: 投影出界时最前深度为无', () => {
  const scene = {
    view: [16, 16], texture: [16, 16], base: [0, 0, 0],
    vertices: [[-8192, -8192, 5], [-1024, -8192, 5], [-1024, -1024, 5]],
    faces: [{ v: [0, 1, 2], uv: [[128, 128], [3968, 128], [3968, 3968]] }]
  };
  const m = C.createModel(scene);
  const info = C.pickTexel(m, 0, 0);
  assert.equal(info.owner, 0);
  assert.equal(info.inView, false);
  assert.equal(info.front, null);
});

test('投影退化面：归属纹素不可上色且拾取标记', () => {
  const scene = {
    view: [16, 16], texture: [16, 16], base: [0, 0, 0],
    // 屏幕共线（都在 y=2560），UV 不退化
    vertices: [[1024, 2560, 5], [4096, 2560, 5], [2560, 2560, 5]],
    faces: [{ v: [0, 1, 2], uv: [[128, 128], [3968, 128], [2048, 3968]] }]
  };
  const m = C.createModel(scene);
  const tex = C.makeBaseTexture(scene);
  assert.equal(m.owner[5 * 16 + 5], 0);
  const p = C.paintStroke(m, tex, { points: [[2048, 2560]], diameter: 16, rgb: [1, 2, 3], a: 255 });
  assert.equal(p.count, 0);
  const info = C.pickTexel(m, 5, 5);
  assert.equal(info.ownerDegenerate, true);
});

test('PNG 编码：签名/尺寸/颜色类型，且可被 Node 解码一致', async () => {
  const zlib = require('node:zlib');
  const w = 4, h = 3;
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = (i * 37) % 256; rgb[i * 3 + 1] = (i * 71) % 256; rgb[i * 3 + 2] = (i * 113) % 256; }
  const png = C.encodePng(rgb, w, h);
  assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  // 手工解析 IHDR/IDAT
  const dv = new DataView(png.buffer);
  assert.equal(dv.getUint32(8), 13);
  assert.equal(String.fromCharCode(png[12], png[13], png[14], png[15]), 'IHDR');
  assert.equal(dv.getUint32(16), w);
  assert.equal(dv.getUint32(20), h);
  assert.equal(png[24], 8);
  assert.equal(png[25], 2);
  // 收集 IDAT
  let off = 8;
  const idat = [];
  while (off < png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat.map((b) => Buffer.from(b))));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 3 + 1);
    assert.equal(raw[rowStart], 0);
    for (let x = 0; x < w * 3; x++) assert.equal(raw[rowStart + 1 + x], rgb[y * w * 3 + x]);
  }
});

test('撤销/重做：补丁回放与新笔清空重做', () => {
  const scene = sampleScene();
  const m = C.createModel(scene);
  const tex = C.makeBaseTexture(scene);
  const undo = [], redo = [];
  const p1 = C.paintStroke(m, tex, { points: [[23808, 14208]], diameter: 6, rgb: [255, 0, 0], a: 255 });
  undo.push(p1);
  const p2 = C.paintStroke(m, tex, { points: [[8000, 8000]], diameter: 6, rgb: [0, 0, 255], a: 255 });
  undo.push(p2);
  // 撤销 p2
  const last = undo.pop();
  for (let k = 0; k < last.indices.length; k++) {
    const o = last.indices[k] * 3;
    tex[o] = last.old[k * 3]; tex[o + 1] = last.old[k * 3 + 1]; tex[o + 2] = last.old[k * 3 + 2];
  }
  redo.push(last);
  // 从撤销位置新画一笔 → 重做记录应被清空（由 UI 负责 redo.length = 0，这里模拟语义）
  redo.length = 0;
  const p3 = C.paintStroke(m, tex, { points: [[8000, 8000]], diameter: 6, rgb: [0, 255, 0], a: 255 });
  undo.push(p3);
  assert.equal(redo.length, 0);
  // p1 的红色仍在
  let red = 0;
  for (let i = 0; i < m.nTex; i++) if (tex[i * 3] === 255 && tex[i * 3 + 1] === 0) red++;
  assert.ok(red > 0);
});

test('有理数深度比较：等深判定准确（BigInt 兜底）', () => {
  assert.equal(C.cmpRational(6, 4, 3, 2), 0);
  assert.equal(C.cmpRational(5, 4, 3, 2), -1);
  assert.equal(C.cmpRational(7, 4, 3, 2), 1);
  // 超大整数比（模拟 z 插值）
  const big = 1e11;
  assert.equal(C.cmpRational(big * 3, big * 2, 3, 2), 0);
});

test('性能：满额双层规则网格 20 笔 × 16 点在预算内', () => {
  const viewW = 512, viewH = 384, texW = 1024, texH = 1024;
  const verts = [];
  const faces = [];
  const cols = 80, rows = 75; // 81*76=6156 顶点/层，12000 面/层，双层共 24000 面（满额）
  const sx = viewW * 256 / cols, sy = viewH * 256 / rows;
  // 后层（z=100）铺满屏幕
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= cols; x++) {
      verts.push([Math.round(x * sx), Math.round(y * sy), 100]);
    }
  }
  const baseCount = verts.length;
  // 前层（z=50）只占屏幕左半，模拟铭牌遮挡
  const frontCols = 40;
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= frontCols; x++) {
      verts.push([Math.round(x * sx), Math.round(y * sy), 50]);
    }
  }
  const idx = (x, y) => y * (cols + 1) + x;
  const fidx = (x, y) => y * (frontCols + 1) + x;
  // 后层 UV 占纹理左半（u: 0..512 纹素）
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const a = idx(x, y), b = idx(x + 1, y), c = idx(x + 1, y + 1), d = idx(x, y + 1);
      const u = (xx) => Math.round(xx * (texW / 2) * 256 / cols);
      const v = (yy) => Math.round(yy * texH * 256 / rows);
      faces.push({ v: [a, b, c], uv: [[u(x), v(y)], [u(x + 1), v(y)], [u(x + 1), v(y + 1)]] });
      faces.push({ v: [a, c, d], uv: [[u(x), v(y)], [u(x + 1), v(y + 1)], [u(x), v(y + 1)]] });
    }
  }
  // 前层 UV 占纹理右半（u: 512..1024 纹素），无重叠
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < frontCols; x++) {
      const a = baseCount + fidx(x, y), b = baseCount + fidx(x + 1, y),
            c = baseCount + fidx(x + 1, y + 1), d = baseCount + fidx(x, y + 1);
      const u = (xx) => Math.round((texW / 2) * 256 + xx * (texW / 2) * 256 / frontCols);
      const v = (yy) => Math.round(yy * texH * 256 / rows);
      faces.push({ v: [a, b, c], uv: [[u(x), v(y)], [u(x + 1), v(y)], [u(x + 1), v(y + 1)]] });
      faces.push({ v: [a, c, d], uv: [[u(x), v(y)], [u(x + 1), v(y + 1)], [u(x), v(y + 1)]] });
    }
  }
  const scene = { view: [viewW, viewH], texture: [texW, texH], base: [200, 200, 200], vertices: verts, faces };
  assert.equal(C.validateScene(scene), null);
  assert.ok(faces.length <= 24000 && verts.length <= 72000);

  const t0 = Date.now();
  const m = C.createModel(scene);
  const t1 = Date.now();
  const tex = C.makeBaseTexture(scene);
  // 20 笔，每笔 16 点，直径 8，各落在 32×32 像素框内；部分框在左半（前层）部分在右半（后层）
  const strokes = [];
  for (let s = 0; s < 20; s++) {
    const boxX = (s % 14) * 32, boxY = Math.floor(s / 14) * 32 + 40;
    const pts = [];
    for (let k = 0; k < 16; k++) {
      const px = (boxX + (k % 32)) * 256 + 128;
      const py = (boxY + Math.floor(k / 2) % 32) * 256 + 128;
      pts.push([px, py]);
    }
    strokes.push({ points: pts, diameter: 8, rgb: [(s * 13) % 256, (s * 29) % 256, (s * 53) % 256], a: 200 });
  }
  let painted = 0;
  for (const st of strokes) painted += C.paintStroke(m, tex, st).count;
  const t2 = Date.now();
  const r = C.renderPreview(m, tex);
  const t3 = Date.now();
  assert.ok(painted > 0, '必须有纹素被上色');
  // 画面必须真的变了
  assert.ok(r.rgba.some((v, i) => i % 4 === 0 && v !== 200));
  console.log(`  满载: 建模 ${t1 - t0}ms, 20笔 ${t2 - t1}ms(${painted}纹素), 预览 ${t3 - t2}ms, 合计 ${t3 - t0}ms`);
  assert.ok(t3 - t0 < 3000, '满载总耗时应在 3 秒内');
});
