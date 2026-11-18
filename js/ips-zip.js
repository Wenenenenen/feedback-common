/* 极简 ZIP 写入器：stored（不压缩）、UTF-8 文件名、固定时间戳，输出确定。 */
(function () {
  const IPS = (globalThis.IPS = globalThis.IPS || {});

  // entries: [{name: string, data: Uint8Array}] → Uint8Array
  IPS.createZip = function (entries) {
    const enc = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const DOS_TIME = 0; // 1980-01-01 00:00:00，保证输出确定
    const DOS_DATE = 0x21;

    for (const e of entries) {
      const name = enc.encode(e.name);
      const crc = IPS.crc32(e.data);
      const size = e.data.length;

      const lh = new Uint8Array(30 + name.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0x0800, true); // UTF-8 文件名
      lv.setUint16(8, 0, true); // stored
      lv.setUint16(10, DOS_TIME, true);
      lv.setUint16(12, DOS_DATE, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      lh.set(name, 30);
      localParts.push(lh, e.data);

      const ch = new Uint8Array(46 + name.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, DOS_TIME, true);
      cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true);
      // 30..41: extra/comment/disk/int attr = 0；42: ext attr = 0
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      centralParts.push(ch);

      offset += lh.length + e.data.length;
    }

    let centralSize = 0;
    for (const c of centralParts) centralSize += c.length;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    let total = offset + centralSize + end.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of localParts) { out.set(p, o); o += p.length; }
    for (const p of centralParts) { out.set(p, o); o += p.length; }
    out.set(end, o);
    return out;
  };
})();
