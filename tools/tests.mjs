// 测试套件（Node 原生 ESM，无第三方依赖）：
//   node --test tools/tests.mjs
// 覆盖：inflate 全块类型、PNG 16 位解码、marching squares 与 Python 基准逐项比对、
//       阈值校验、父环、掩膜开放线、改间距后几何重算。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import zlib from "node:zlib";
import { rawInflate } from "../app/inflate.js";
import { decodePng, decodeMask } from "../app/png.js";
import {
  buildTopology, buildGeometry, validateLevels, cellInfo, edgeCounts,
} from "../app/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const sampleDir = join(here, "..", "samples", "extracted");
const fixtureDir = join(here, "fixtures");

// ---------- inflate ----------
function randomBytes(n, seed = 12345) {
  // 确定性伪随机，避免测试依赖
  let s = seed;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 255;
  }
  return out;
}

test("inflate: 存储块/动态块（zlib level 0..9 往返）", () => {
  const payloads = [
    new Uint8Array(0),
    new TextEncoder().encode("Hello, contour!"),
    randomBytes(500),
    randomBytes(10000, 7),
    new Uint8Array(5000).fill(65), // 高压缩比
  ];
  for (const p of payloads) {
    for (let level = 0; level <= 9; level++) {
      const packed = zlib.deflateRawSync(Buffer.from(p), { level });
      const got = rawInflate(new Uint8Array(packed));
      assert.deepEqual(got, p, `level=${level} len=${p.length}`);
    }
  }
});

test("inflate: 手工构造的固定 Huffman 块", () => {
  // RFC1951 固定码长 -> canonical 码，按 LSB 先发写入
  const lengths = new Array(288).fill(0);
  for (let i = 0; i < 144; i++) lengths[i] = 8;
  for (let i = 144; i < 256; i++) lengths[i] = 9;
  for (let i = 256; i < 280; i++) lengths[i] = 7;
  for (let i = 280; i < 288; i++) lengths[i] = 8;
  const maxLen = Math.max(...lengths);
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l) blCount[l]++;
  const codes = new Array(288);
  let code = 0;
  const nextCode = new Array(maxLen + 1).fill(0);
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  for (let sym = 0; sym < 288; sym++) {
    if (lengths[sym]) codes[sym] = [nextCode[lengths[sym]]++, lengths[sym]];
  }
  const text = new TextEncoder().encode("FixedHuffmanBlock123");
  const symbols = [...text, 256];
  const bytes = [];
  let bitbuf = 0, bitcnt = 0;
  // 按 RFC1951：canonical 码的最高位先打包进位流最低位
  const putSym = (sym) => {
    const [c, len] = codes[sym];
    for (let k = 0; k < len; k++) {
      bitbuf |= ((c >> (len - 1 - k)) & 1) << bitcnt;
      bitcnt++;
      if (bitcnt === 8) { bytes.push(bitbuf & 255); bitbuf = 0; bitcnt = 0; }
    }
  };
  // bfinal=1, btype=01（固定），LSB 先：位上为 1,1,0
  bitbuf = 0b011; bitcnt = 3;
  for (const s of symbols) putSym(s);
  if (bitcnt) bytes.push(bitbuf & 255);
  const got = rawInflate(Uint8Array.from(bytes));
  assert.deepEqual(got, text);
});

test("inflate: 重叠回溯（距离小于长度）", () => {
  // zlib 对重复模式会产生重叠拷贝
  const p = new TextEncoder().encode("abcdefgh".repeat(500));
  const packed = zlib.deflateRawSync(Buffer.from(p), { level: 9 });
  assert.deepEqual(rawInflate(new Uint8Array(packed)), p);
});

// ---------- PNG ----------
test("PNG: 16 位灰度与 8 位掩膜解码值正确", () => {
  for (const name of ["radial", "tie", "constant"]) {
    const fx = JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"));
    const img = decodePng(readFileSync(join(sampleDir, `${name}.png`)));
    assert.equal(img.width, fx.width);
    assert.equal(img.height, fx.height);
    assert.deepEqual(Array.from(img.values), fx.values);
  }
  const mask = decodeMask(readFileSync(join(sampleDir, "slit-valid.png")), 65, 49);
  const fxSlit = JSON.parse(readFileSync(join(fixtureDir, "slit.json"), "utf8"));
  assert.deepEqual(Array.from(mask), fxSlit.mask);
});

test("PNG: 拒绝非灰度/交错/越界尺寸", () => {
  const makePng = (width, height, bitDepth, colorType, interlace = 0) => {
    // 构造最小 IHDR + 空 IDAT（解码在签名/IHDR 校验阶段就应抛错）
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = interlace;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(Buffer.alloc(0))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  };
  assert.throws(() => decodePng(makePng(4, 4, 8, 2)), /color type/);
  assert.throws(() => decodePng(makePng(4, 4, 8, 0, 1)), /交错/);
  assert.throws(() => decodePng(makePng(1025, 4, 8, 0)), /2\.\.1024/);
  assert.throws(() => decodePng(Buffer.from([1, 2, 3])), /签名/);
});

// ---------- 阈值校验 ----------
test("validateLevels: 半整数、去重、排序、上限", () => {
  assert.deepEqual(validateLevels([3.5, 1.5, 1.5]), [1.5, 3.5]);
  assert.deepEqual(validateLevels("2.5, 10.5; 4.5"), [2.5, 4.5, 10.5]);
  assert.throws(() => validateLevels([2.0]), /半整数/);
  assert.throws(() => validateLevels([2.5001]), /半整数/);
  assert.throws(() => validateLevels(Array.from({ length: 33 }, (_, i) => i + 0.5)), /32/);
  assert.deepEqual(validateLevels(Array.from({ length: 32 }, (_, i) => i + 0.5)).length, 32);
});

// ---------- 核心拓扑/几何与 Python 基准比对 ----------
function normalizeSeq(seq, closed) {
  let s = [...seq];
  if (closed && s.length > 1 && s[0] === s[s.length - 1]) s.pop();
  const rev = [...s].reverse();
  const cmp = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  };
  let best = cmp(s, rev) <= 0 ? s : rev;
  if (closed) {
    // 旋转到最小首元素起
    let minIdx = 0;
    for (let i = 1; i < best.length; i++) if (best[i] < best[minIdx]) minIdx = i;
    best = best.slice(minIdx).concat(best.slice(0, minIdx));
  }
  return best.join(",");
}

function runCase(name) {
  const fx = JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"));
  const values = Uint16Array.from(fx.values);
  const mask = Uint8Array.from(fx.mask);
  const topo = buildTopology({
    width: fx.width, height: fx.height, values, mask,
    levels: fx.levels.map((l) => l.level),
  });
  const geom = buildGeometry(topo, fx.origin, fx.spacing);
  return { fx, topo, geom };
}

const caseNames = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", ""));

for (const name of caseNames) {
  test(`核心比对: ${name} — 折线边序列/开闭/父环/测量值与 Python 基准一致`, () => {
    const { fx, topo, geom } = runCase(name);
    assert.equal(topo.levels.length, fx.levels.length);
    fx.levels.forEach((fxLevel, li) => {
      const ld = topo.levelData[li];
      const gl = geom.levels[li];
      assert.equal(ld.level, fxLevel.level);
      assert.equal(ld.polylines.length, fxLevel.lines.length, "折线条数");

      // 边分数逐边比对
      ld.frac.forEach((f, e) => {
        const ref = fxLevel.fractions[e];
        if (Number.isNaN(f)) { assert.equal(ref, null); }
        else { assert.ok(Math.abs(f - ref) < 1e-12, `frac edge ${e}`); }
      });

      // 边序列集合比对
      const refOpen = fxLevel.lines.filter((l) => l.open)
        .map((l) => normalizeSeq(l.edge_ids, false)).sort();
      const refClosed = fxLevel.lines.filter((l) => !l.open)
        .map((l) => normalizeSeq(l.edge_ids, true)).sort();
      const jsOpen = ld.polylines.filter((l) => l.open)
        .map((l) => normalizeSeq(l.edgeIds, false)).sort();
      const jsClosed = ld.polylines.filter((l) => !l.open)
        .map((l) => normalizeSeq(l.edgeIds, true)).sort();
      assert.deepEqual(jsOpen, refOpen, "开放线边序列");
      assert.deepEqual(jsClosed, refClosed, "闭环边序列");

      // 每条线：点数、长度、面积、物理坐标、父环
      const refByKey = new Map();
      for (const l of fxLevel.lines) {
        refByKey.set(normalizeSeq(l.edge_ids, !l.open), l);
      }
      gl.lines.forEach((jl) => {
        const pl = ld.polylines.find((p) => p.id === jl.id);
        const key = normalizeSeq(pl.edgeIds, !pl.open);
        const ref = refByKey.get(key);
        assert.ok(ref, "基准中存在对应折线");
        assert.equal(jl.open, ref.open);
        assert.equal(jl.pointCount, ref.edge_ids.length);
        assert.equal(jl.points.length, ref.physical_points.length);
        jl.points.forEach((p, i) => {
          assert.ok(Math.abs(p[0] - ref.physical_points[i][0]) < 1e-9, `x ${i}`);
          assert.ok(Math.abs(p[1] - ref.physical_points[i][1]) < 1e-9, `y ${i}`);
        });
        assert.ok(Math.abs(jl.length - ref.length) < 1e-9, "长度");
        if (ref.area === null) {
          assert.equal(jl.area, null);
        } else {
          assert.ok(Math.abs(jl.area - ref.area) < 1e-9, "面积");
        }
      });

      // 父环：通过包含关系比对（基准 parent_index 指向 closed 列表序号）
      const refClosedLines = fxLevel.lines.filter((l) => !l.open);
      const jsClosedLines = ld.polylines.filter((l) => !l.open);
      const refKeyByClosed = refClosedLines.map((l) => normalizeSeq(l.edge_ids, true));
      jsClosedLines.forEach((jl) => {
        const key = normalizeSeq(jl.edgeIds, true);
        const refIdx = refKeyByClosed.indexOf(key);
        const refParent = refClosedLines[refIdx].parent_index;
        if (refParent === null) {
          assert.equal(jl.parentId, null);
        } else {
          const parentKey = refKeyByClosed[refParent];
          const jsParent = jsClosedLines.find((p) =>
            normalizeSeq(p.edgeIds, true) === parentKey);
          assert.ok(jsParent, "父环存在");
          assert.equal(jl.parentId, jsParent.id);
        }
      });
    });
  });
}

test("掩膜: 触边/触掩膜的线保持开放，绝不自动封口", () => {
  const { geom } = runCase("slit");
  for (const gl of geom.levels) {
    assert.ok(gl.lines.length >= 2);
    for (const line of gl.lines) assert.equal(line.open, true);
  }
});

test("改间距/原点: 仅重算几何且同步缩放", () => {
  const fx = JSON.parse(readFileSync(join(fixtureDir, "radial.json"), "utf8"));
  const values = Uint16Array.from(fx.values);
  const topo = buildTopology({
    width: fx.width, height: fx.height, values,
    mask: Uint8Array.from(fx.mask),
    levels: fx.levels.map((l) => l.level),
  });
  const g1 = buildGeometry(topo, [0, 0], [1, 1]);
  const g2 = buildGeometry(topo, [10, -5], [2, 3]);
  const l1 = g1.levels[0].lines[0];
  const l2 = g2.levels[0].lines[0];
  assert.equal(l1.pointCount, l2.pointCount);
  // X' = 10 + 2x, Y' = -5 + 3y
  l1.points.forEach((p, i) => {
    assert.ok(Math.abs(l2.points[i][0] - (10 + 2 * p[0])) < 1e-12);
    assert.ok(Math.abs(l2.points[i][1] - (-5 + 3 * p[1])) < 1e-12);
  });
  // 长度：非均匀缩放下不等于简单倍数，逐段重算
  let expectLen = 0;
  for (let i = 1; i < l2.points.length; i++) {
    expectLen += Math.hypot(l2.points[i][0] - l2.points[i - 1][0],
                             l2.points[i][1] - l2.points[i - 1][1]);
  }
  expectLen += Math.hypot(l2.points[0][0] - l2.points.at(-1)[0],
                          l2.points[0][1] - l2.points.at(-1)[1]);
  assert.ok(Math.abs(l2.length - expectLen) < 1e-12);
  assert.throws(() => buildGeometry(topo, [0, 0], [0, 1]), /大于 0/);
  assert.throws(() => buildGeometry(topo, [0, 0], [1, -2]), /大于 0/);
});

test("cellInfo: 鞍点单元返回 Q 与实际/备选连接", () => {
  for (const name of ["positive", "negative", "tie"]) {
    const fx = JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"));
    const topo = buildTopology({
      width: fx.width, height: fx.height,
      values: Uint16Array.from(fx.values),
      mask: Uint8Array.from(fx.mask),
      levels: fx.levels.map((l) => l.level),
    });
    const info = cellInfo(topo, 0, 0, 0);
    assert.equal(info.isSaddle, true);
    assert.equal(info.intersections.length, 4);
    const caseJson = JSON.parse(readFileSync(join(sampleDir, `${name}.json`), "utf8"));
    assert.ok(Math.abs(info.Q - caseJson.Q) < 1e-12, `${name} Q`);
    // 实际连接与期望边对一致（顺序无关）
    const norm = (pairs) => pairs.map((p) => [...p].sort().join("-")).sort();
    const zh = { top: "上", right: "右", bottom: "下", left: "左" };
    const expected = norm(caseJson.expected_edge_pairs.map((p) => p.map((e) => zh[e])));
    assert.deepEqual(norm(info.chosenPairs), expected);
  }
});

test("无效单元（四角不全有效）不参与提线：valid=false 且无连接段", () => {
  const { topo } = runCase("slit");
  // 狭缝位于列 31..33：找一个无效单元确认
  const cols = topo.width - 1;
  let foundInvalid = false;
  for (let r = 0; r < topo.height - 1; r++) {
    for (let c = 30; c <= 33; c++) {
      if (!topo.validCell[r * cols + c]) {
        foundInvalid = true;
        const info = cellInfo(topo, 0, r, c);
        assert.equal(info.valid, false);
        assert.equal(info.chosenPairs.length, 0, "无效单元不产生任何连接段");
      }
    }
  }
  assert.ok(foundInvalid);
});

test("边 id 总数与网格规模一致", () => {
  const { horiz, total } = edgeCounts(65, 49);
  assert.equal(horiz, 49 * 64);
  assert.equal(total, 49 * 64 + 48 * 65);
});
