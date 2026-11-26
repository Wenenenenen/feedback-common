/*
 * zip.js — 最小 ZIP 读取（仅取文件），零依赖。
 * 使用浏览器内建 DecompressionStream('deflate-raw') 解压（method 0 直取）。
 * 压缩包内容按不可信数据处理：只解压白名单文件名，拒绝穿越路径与目录项。
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const SAFE_NAME = /^[A-Za-z0-9_.\-]+$/;

function u16(dv, o) {
  return dv.getUint16(o, true);
}
function u32(dv, o) {
  return dv.getUint32(o, true);
}

function findEOCD(dv) {
  const len = dv.byteLength;
  const maxBack = Math.min(len, 22 + 65535);
  for (let i = len - 22; i >= len - maxBack; i--) {
    if (i < 0) break;
    if (u32(dv, i) === EOCD_SIG) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("浏览器不支持 DecompressionStream，无法解压 ZIP");
  }
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 读取 ZIP，返回 {ok, entries:[{name, bytes}], errors:[string]}。
 * 只保留名字符合 SAFE_NAME 的文件（不含子目录），其余记入 errors。
 */
export async function readZip(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const u8 = new Uint8Array(arrayBuffer);
  const eocd = findEOCD(dv);
  if (eocd < 0) return { ok: false, entries: [], errors: ["找不到 ZIP 结尾记录（EOCD）"] };
  const count = u16(dv, eocd + 10);
  const cenOff = u32(dv, eocd + 16);
  if (cenOff >= u8.length) return { ok: false, entries: [], errors: ["中央目录偏移越界"] };

  const entries = [];
  const errors = [];
  let p = cenOff;
  const dec = new TextDecoder("utf-8");
  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || u32(dv, p) !== CEN_SIG) {
      errors.push(`中央目录第 ${i} 项损坏`);
      break;
    }
    const method = u16(dv, p + 10);
    const compSize = u32(dv, p + 20);
    const uncompSize = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const localOff = u32(dv, p + 42);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // 目录项跳过
    if (name.includes("/") || name.includes("\\") || !SAFE_NAME.test(name)) {
      errors.push(`跳过不安全文件名：${name}`);
      continue;
    }
    if (localOff + 30 > u8.length || u32(dv, localOff) !== LOC_SIG) {
      errors.push(`${name}: 本地头损坏`);
      continue;
    }
    const lNameLen = u16(dv, localOff + 26);
    const lExtraLen = u16(dv, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > u8.length) {
      errors.push(`${name}: 数据越界`);
      continue;
    }
    const comp = u8.subarray(dataStart, dataStart + compSize);
    try {
      let out;
      if (method === 0) out = comp.slice();
      else if (method === 8) out = await inflateRaw(comp);
      else {
        errors.push(`${name}: 不支持的压缩方式 ${method}`);
        continue;
      }
      if (uncompSize && out.length !== uncompSize) {
        errors.push(`${name}: 解压长度 ${out.length} ≠ 声明 ${uncompSize}`);
        continue;
      }
      entries.push({ name, bytes: out });
    } catch (err) {
      errors.push(`${name}: 解压失败（${err.message || err}）`);
    }
  }
  return { ok: entries.length > 0, entries, errors };
}
