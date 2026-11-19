// 极简 ZIP 读取（仅 stored / deflate），用于解包样例包。
// 样例是外部数据：调用方应解压到独立的新目录，并用 -I / 隔离方式运行任何脚本。
// 浏览器与 Node 共用（Node 18+ 同样有 DecompressionStream('deflate-raw')）。

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 返回 Map<name, Uint8Array>。不写盘、不执行包内任何内容。
export async function readZip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // 找 EOCD（可能带注释，向前最多扫描 64KB）
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 缺少 EOCD 记录');
  const count = u16(b, eocd + 10);
  let off = u32(b, eocd + 16);
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (u32(b, off) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = u16(b, off + 10);
    const compSize = u32(b, off + 20);
    const nameLen = u16(b, off + 28);
    const extraLen = u16(b, off + 30);
    const commentLen = u16(b, off + 32);
    const localOff = u32(b, off + 42);
    const name = new TextDecoder().decode(b.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (u32(b, localOff) !== 0x04034b50) throw new Error(`ZIP 本地头损坏：${name}`);
    const lNameLen = u16(b, localOff + 26);
    const lExtraLen = u16(b, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = b.subarray(dataStart, dataStart + compSize);
    if (method === 0) out.set(name, new Uint8Array(raw));
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new Error(`ZIP 条目 ${name} 使用不支持的压缩方式 ${method}`);
  }
  return out;
}
