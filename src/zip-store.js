// zip-store.js — Minimal ZIP archive writer using method 0 (STORE, no compression).
// Sufficient for bundling a rendered PNG sequence; all multi-byte fields are little-endian.
import { crc32 } from './crc32.js';

function u16(v) {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
}
function u32le(v) {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const enc = new TextEncoder();

// files: [{ name: string, data: Uint8Array }]
export function buildZip(files) {
  const localParts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = concat([
      u32le(0x04034b50),
      u16(20),             // version needed
      u16(0x0800),         // flags: UTF-8 names
      u16(0),              // method STORE
      u16(0), u16(0),      // mod time/date
      u32le(crc),
      u32le(data.length),  // compressed size
      u32le(data.length),  // uncompressed size
      u16(nameBytes.length),
      u16(0),              // extra length
      nameBytes,
      data,
    ]);
    localParts.push(local);

    central.push(concat([
      u32le(0x02014b50),
      u16(20), u16(20),
      u16(0x0800),
      u16(0),
      u16(0), u16(0),
      u32le(crc),
      u32le(data.length),
      u32le(data.length),
      u16(nameBytes.length),
      u16(0), u16(0),
      u16(0), u16(0),
      u32le(0),
      u32le(offset),
      nameBytes,
    ]));
    offset += local.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const end = concat([
    u32le(0x06054b50),
    u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32le(centralSize),
    u32le(centralStart),
    u16(0),
  ]);

  return concat([...localParts, ...central, end]);
}
