/* Node 测试：加载核心模块，对样例图片验证算法与输出格式。
 * 用法：node test/run-tests.js <样例目录> */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
for (const f of ["js/ips-core.js", "js/ips-zip.js", "js/ips-png.js"]) {
  eval(fs.readFileSync(path.join(root, f), "utf8"));
}
const IPS = globalThis.IPS;

const casesDir = process.argv[2];
if (!casesDir) {
  console.error("用法：node test/run-tests.js <样例目录>");
  process.exit(1);
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("  PASS", name);
  } else {
    failures++;
    console.error("  FAIL", name, extra === undefined ? "" : extra);
  }
}

async function load(name) {
  const buf = fs.readFileSync(path.join(casesDir, name));
  const img = await IPS.decodePng(buf);
  return { name: name.replace(/\.png$/, ""), ...img };
}

function paletteOf(images, K) {
  const sorted = images
    .map((im) => ({ ...im, hash: IPS.imageHash(im) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const bins = IPS.buildBins(sorted);
  const boxes = IPS.medianCut(bins, K - 1);
  return IPS.buildPalette(boxes);
}

(async () => {
  const [g0, g1, g2, transparent, threshold, fewColors] = await Promise.all(
    ["gradient-0.png", "gradient-1.png", "gradient-2.png", "transparent.png", "threshold.png", "few-colors.png"].map(load)
  );
  const gradients = [g0, g1, g2];

  console.log("== 解码 ==");
  check("gradient-0 尺寸 96×64", g0.width === 96 && g0.height === 64);
  check("threshold 尺寸 4×1", threshold.width === 4 && threshold.height === 1);
  check(
    "threshold alpha 阈值 [127,128,255,255]",
    threshold.data[3] === 127 && threshold.data[7] === 128 && threshold.data[11] === 255
  );

  console.log("== 调色板确定性 ==");
  const K = 16;
  const palA = paletteOf(gradients, K);
  const palB = paletteOf([g2, g0, g1], K); // 改变文件顺序
  const palC = paletteOf([g0, g1, g2, g0, g1, g2], K); // 整套重复导入
  check("槽数 = K（颜色足够时）", palA.length === K, `got ${palA.length}`);
  check("槽 0 为黑色透明", palA[0].r === 0 && palA[0].g === 0 && palA[0].b === 0 && palA[0].a === 0);
  check("改变文件顺序调色板不变", JSON.stringify(palA) === JSON.stringify(palB));
  check("重复导入调色板不变", JSON.stringify(palA) === JSON.stringify(palC));

  console.log("== 全透明组 ==");
  const palT = paletteOf([transparent], 8);
  check("全透明组色表仅 1 槽", palT.length === 1, `got ${palT.length}`);
  check("该槽为黑色透明", palT[0].a === 0 && palT[0].r === 0 && palT[0].g === 0 && palT[0].b === 0);
  const resT = IPS.quantizeImage(transparent, palT, true);
  check("全透明图全部落槽 0", resT.indices.every((v) => v === 0));
  check("全透明图使用量全在槽 0", resT.usage[0] === transparent.width * transparent.height);
  check("全透明图热图全 0", resT.heat.every((v) => v === 0));

  console.log("== alpha 阈值与量化 ==");
  const palTh = paletteOf([threshold], 4);
  check("threshold 组：3 不透明色 + 透明槽", palTh.length === 4, `got ${palTh.length}`);
  const resTh = IPS.quantizeImage(threshold, palTh, false);
  check("alpha=127 → 槽 0", resTh.indices[0] === 0);
  check("alpha=128 → 不透明槽", resTh.indices[1] > 0);
  check("使用量含槽 0 且总数正确", resTh.usage.reduce((a, b) => a + b, 0) === 4 && resTh.usage[0] === 1);

  const palFew = paletteOf([fewColors], 2);
  check("K=2 → 1 不透明代表色", palFew.length === 2, `got ${palFew.length}`);
  // 红绿各半 → 线性均值 (0.5,0.5,0) → sRGB ≈ 188
  check(
    "红绿等量的代表色约为 (188,188,0)",
    Math.abs(palFew[1].r - 188) <= 1 && Math.abs(palFew[1].g - 188) <= 1 && palFew[1].b === 0,
    JSON.stringify(palFew[1])
  );

  console.log("== 抖动确定性与透明隔离 ==");
  const palG = paletteOf(gradients, 16);
  const r1 = IPS.quantizeImage(g0, palG, true);
  const r2 = IPS.quantizeImage(g0, palG, true);
  check("抖动结果可复现", Buffer.from(r1.indices).equals(Buffer.from(r2.indices)));
  const mixed = [g0, transparent];
  const palM = paletteOf(mixed, 16);
  const resTrans = IPS.quantizeImage(transparent, palM, true);
  check("组内全透明图仍全部落槽 0", resTrans.indices.every((v) => v === 0));
  check("组内全透明图热图全 0", resTrans.heat.every((v) => v === 0));

  console.log("== 索引 PNG 编码 ==");
  const res0 = IPS.quantizeImage(g0, palG, true);
  const png = IPS.encodeIndexedPng(g0.width, g0.height, res0.indices, palG);
  fs.writeFileSync("/tmp/ips-test-out.png", Buffer.from(png));
  // 结构自检
  check("PNG 签名", png[0] === 0x89 && png[1] === 0x50);
  const dv = new DataView(png.buffer, png.byteOffset);
  check("IHDR bitdepth=8 colortype=3", png[24] === 8 && png[25] === 3);
  // 找 PLTE / tRNS
  let pos = 8, plteLen = -1, trns = null;
  while (pos < png.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
    if (type === "PLTE") plteLen = len;
    if (type === "tRNS") trns = png.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
  }
  check("PLTE 长度 = 3×槽数", plteLen === palG.length * 3, `got ${plteLen}`);
  check("tRNS = [0,255,...] 且长度=槽数",
    trns && trns.length === palG.length && trns[0] === 0 && [...trns.subarray(1)].every((v) => v === 255));

  console.log("== ZIP ==");
  const zip = IPS.createZip([
    { name: "a.png", data: png },
    { name: "palette.json", data: new TextEncoder().encode('{"ok":true}') },
  ]);
  fs.writeFileSync("/tmp/ips-test-out.zip", Buffer.from(zip));
  check("ZIP 本地头签名", zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 3 && zip[3] === 4);

  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
