// zip-reader.js — 最小 ZIP 读取器, 仅处理本任务的导入包
// 支持 STORE(0) 与 DEFLATE(8); 依赖全局 DecompressionStream('deflate-raw')
// (Chrome 103+ / Firefox 113+ / Safari 16.4+ / Node 22+)

export async function readZip(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const dec = new TextDecoder('utf-8');

  // 1. 定位 EOCD(0x06054b50), 从尾部扫描(允许其后有注释)
  let eocd = -1;
  for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 结构损坏: 找不到中央目录结尾记录');
  const cdEntries = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);

  // 2. 遍历中央目录
  const entries = [];
  let p = cdOff;
  for (let n = 0; n < cdEntries; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 中央目录记录损坏');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const flags = dv.getUint16(p + 8, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, uncompSize, localOff, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }

  // 3. 逐个取本地文件头并解压
  const files = new Map();
  for (const e of entries) {
    if (e.name.endsWith('/')) continue; // 目录项
    const q = e.localOff;
    if (dv.getUint32(q, true) !== 0x04034b50) throw new Error(`ZIP 本地文件头损坏: ${e.name}`);
    const lNameLen = dv.getUint16(q + 26, true);
    const lExtraLen = dv.getUint16(q + 28, true);
    const dataOff = q + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(dataOff, dataOff + e.compSize);
    let content;
    if (e.method === 0) {
      content = new Uint8Array(raw);
    } else if (e.method === 8) {
      content = await inflateRaw(raw);
    } else {
      throw new Error(`不支持的压缩方式(${e.method}): ${e.name}`);
    }
    files.set(e.name, content);
  }
  return files;
}

async function inflateRaw(compressed) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前环境不支持 DecompressionStream, 无法解压 ZIP');
  }
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
