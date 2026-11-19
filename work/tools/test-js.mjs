// node --input-type=module 校验脚本：对照 Python 参考向量
import { readFileSync } from "node:fs";
import { parseSave, encodeV2, semanticKey, canonicalJson, crc32, GWSVError } from "../../app/gwsv-core.js";

const vectors = JSON.parse(readFileSync(new URL("../test-vectors/vectors.json", import.meta.url)));
let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.log("  FAIL:", msg); }
}

for (const v of vectors) {
  console.log(`\n== ${v.name} ==`);
  const buf = Uint8Array.from(Buffer.from(v.inputB64, "base64"));
  if (v.fatal) {
    let got = null;
    try { parseSave(buf); } catch (e) { got = e; }
    check(got instanceof GWSVError, "应抛 GWSVError");
    check(got && got.message === v.fatal.msg, `fatal 消息一致\n    期望: ${v.fatal.msg}\n    实际: ${got && got.message}`);
    check(got && got.offset === v.fatal.offset, `fatal offset: 期望 ${v.fatal.offset} 实际 ${got && got.offset}`);
    continue;
  }
  const world = parseSave(buf);
  check(world.errors.length === v.errors.length, `错误数量: 期望 ${v.errors.length} 实际 ${world.errors.length}`);
  for (let i = 0; i < v.errors.length; i++) {
    const e = world.errors[i], pe = v.errors[i];
    check(e.msg === pe.msg, `错误[${i}] 消息\n    期望: ${pe.msg}\n    实际: ${e.msg}`);
    check(e.offset === pe.offset, `错误[${i}] offset: 期望 ${pe.offset} 实际 ${e.offset}`);
  }
  check(world.version === v.parsed.version, "version");
  check(world.chunks.length === v.parsed.chunks.length, "区块数");
  for (let i = 0; i < world.chunks.length; i++) {
    const c = world.chunks[i], pc = v.parsed.chunks[i];
    check(JSON.stringify(c.coord) === JSON.stringify(pc.coord), `区块${i} 坐标`);
    check(c.headOffset === pc.headOffset, `区块${i} headOffset`);
    check(c.payloadOffset === pc.payloadOffset, `区块${i} payloadOffset`);
    check(c.crcOffset === pc.crcOffset, `区块${i} crcOffset`);
    if (pc.voxels === null) {
      check(c.voxels === null, `区块${i} voxels 应为 null`);
    } else {
      check(c.voxels !== null && JSON.stringify(Array.from(c.voxels)) === JSON.stringify(pc.voxels), `区块${i} 512 voxels 一致`);
    }
  }
  check(world.entities.length === v.parsed.entities.length, "实体数");
  for (let i = 0; i < world.entities.length; i++) {
    const e = world.entities[i], pe = v.parsed.entities[i];
    check(e.id === pe.id && JSON.stringify(e.chunk) === JSON.stringify(pe.chunk)
      && e.cell === pe.cell && JSON.stringify(e.links) === JSON.stringify(pe.links)
      && e.offset === pe.offset, `实体${i} 字段与偏移一致`);
  }
  if (v.canonicalB64) {
    const enc = encodeV2(world);
    const want = Uint8Array.from(Buffer.from(v.canonicalB64, "base64"));
    check(enc.length === want.length, `规范化长度: 期望 ${want.length} 实际 ${enc.length}`);
    let same = enc.length === want.length;
    for (let i = 0; same && i < enc.length; i++) if (enc[i] !== want[i]) same = false;
    check(same, "规范化输出字节级一致");
    // 二次编码幂等
    const w2 = parseSave(enc);
    check(w2.errors.length === 0, "重新解析无错误");
    const enc2 = encodeV2(w2);
    check(Buffer.compare(Buffer.from(enc), Buffer.from(enc2)) === 0, "二次编码字节幂等");
    check(semanticKey(world) === JSON.stringify(v.semantic), "semanticKey 与 Python 一致");
  }
}

// canonicalJson 与 Python json.dumps(sort_keys, separators) 抽查
const doc = { cell: 0, chunk: [-4, 0, 0], id: 1, links: [2, 3] };
check(canonicalJson(doc) === '{"cell":0,"chunk":[-4,0,0],"id":1,"links":[2,3]}', "canonicalJson 格式");
// crc32 已知向量
check(crc32(new TextEncoder().encode("")) === 0x00000000, "crc32(\"\")");
check(crc32(new TextEncoder().encode("123456789")) === 0xcbf43926, "crc32 check");

console.log(failures === 0 ? "\n全部通过 ✔" : `\n${failures} 项失败 �’`);
process.exit(failures === 0 ? 0 : 1);
