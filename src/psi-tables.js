// PSI (PAT/PMT) reassembly and program relationship tracking.
//
// Rules implemented:
//  - Sections can span multiple TS packets; a payload_unit_start_indicator
//    carries a pointer_field and starts a new section buffer for that PID.
//  - A section is only accepted when complete AND its CRC-32/MPEG-2 is valid.
//  - Only "current" tables (current_next_indicator = 1) update the live
//    program relationships; next tables are recorded but not applied.
//  - A CRC-bad section is reported as an anomaly and never applied, so a bad
//    PMT cannot change the program map (the previous good one stays in force).

import { crc32Mpeg } from "./crc32.js";

export const TABLE_ID_PAT = 0x00;
export const TABLE_ID_PMT = 0x02;

const SECTION_PID_PAT = 0;

/**
 * @typedef {Object} SectionEvent
 * @property {number} packetIndex  TS packet where the section completed
 * @property {number} pid          PID carrying the section
 * @property {number} tableId
 * @property {number} version
 * @property {number} sectionNumber
 * @property {number} lastSectionNumber
 * @property {boolean} currentNext
 * @property {boolean} crcOk
 * @property {boolean} complete    false if the capture ended mid-section
 */

export class PsiAssembler {
  constructor() {
    // pid -> { buffer: Uint8Array[], startPacket: number, pointerDone: boolean }
    this.inProgress = new Map();
    /** @type {SectionEvent[]} */
    this.sections = [];
    this.crcFailures = []; // {packetIndex, pid, tableId, detail}
    // PMT PIDs named by an applied PAT; empty until the first PAT lands.
    this.pmtPids = new Set();
    // Effective program map timeline, appended only on accepted current tables
    // Each entry: { packetIndex, type:'PAT'|'PMT', ... }
    this.mapTimeline = [];
    // Last accepted PAT: transportStreamId -> { programNumber -> pmtPid }
    this.currentPat = null;
    // pmtPid -> last accepted PMT
    this.currentPmts = new Map();
  }

  _isPsiPid(pid) {
    if (pid === SECTION_PID_PAT) return true;
    if (this.pmtPids.has(pid)) return true;
    // Before the first applied PAT, tolerate PMTs in the table range.
    if (this.pmtPids.size === 0 && this.currentPat === null && pid >= 0x100 && pid <= 0x1ff) {
      return true;
    }
    return false;
  }

  /**
   * Feed one parsed packet row plus its raw bytes.
   *
   * A PID is treated as PSI when it is:
   *   - the fixed PAT PID (0x0000), or
   *   - a PMT PID named by a PAT we have already applied, or
   *   - in the DVB table range 0x0100-0x01FF before any PAT has named it
   *     (tolerates a PMT arriving before its first PAT); once a PAT exists,
   *     only the PIDs it names stay enabled so PES streams in that range are
   *     never misread as tables.
   */
  feed(row, bytes) {
    const { pid, pusi, hasPayload, payloadLength, index } = row;
    if (!hasPayload || payloadLength === 0) return;
    if (!this._isPsiPid(pid)) return;
    const start = row.offset + row.payloadStart;

    if (pusi) {
      const pointerField = bytes[start];
      // Begin a new section buffer; bytes after pointer_field belong to it.
      const sectionStart = start + 1 + pointerField;
      this.inProgress.set(pid, {
        chunks: [bytes.subarray(sectionStart, row.offset + 188)],
        startPacket: index,
      });
    } else {
      const ip = this.inProgress.get(pid);
      if (!ip) return; // stray continuation without a section start: ignore
      ip.chunks.push(bytes.subarray(start, row.offset + 188));
    }

    // Try to consume every complete section currently buffered for this PID
    const ip = this.inProgress.get(pid);
    if (!ip) return;
    let buf = concatChunks(ip.chunks);
    let consumed = 0;

    for (;;) {
      // Skip 0xFF stuffing
      while (consumed < buf.length && buf[consumed] === 0xff) consumed++;
      if (buf.length - consumed < 3) break;
      const tableId = buf[consumed];
      if (tableId === 0xff) break;
      // Valid table_ids are 0x00-0x3F per ISO 13818-1; anything else here is
      // not a section (stray payload on a table-range PID), so stop walking.
      if (tableId > 0x3f) {
        this.inProgress.delete(pid);
        break;
      }
      const secLen = ((buf[consumed + 1] & 0x0f) << 8) | buf[consumed + 2];
      // Structural sanity before treating this as a section.
      // The byte after table_id is laid out as:
      //   section_syntax_indicator (1 bit, =1 for PAT/PMT)
      //   reserved                 (3 bits, fixed 011)
      //   section_length high nibble (4 bits)
      // so a valid PAT/PMT byte reads 0xBx. Checking the reserved triple
      // rejects PES payloads that merely start with a small table-like byte,
      // instead of misreading them and emitting bogus CRC failures.
      const syntaxByte = buf[consumed + 1];
      const hasSyntax = !!(syntaxByte & 0x80);
      const reservedTriple = (syntaxByte >> 4) & 0x07;
      if (!hasSyntax || reservedTriple !== 0x03 || secLen < 9 || secLen > 1021) {
        // Not a well-formed table section: stop walking this buffer rather
        // than emitting a bogus CRC failure against PES payload on this PID.
        break;
      }
      const total = 3 + secLen;
      if (buf.length - consumed < total) break; // wait for more packets

      const section = buf.subarray(consumed, consumed + total);
      this._handleSection(section, pid, index);
      consumed += total;
    }

    if (consumed > 0) {
      // Keep leftover (should normally be only 0xFF stuffing) for continuation
      const leftover = buf.subarray(consumed);
      this.inProgress.set(pid, { chunks: [leftover], startPacket: ip.startPacket });
    }
  }

  _handleSection(section, pid, packetIndex) {
    const tableId = section[0];
    if (tableId !== TABLE_ID_PAT && tableId !== TABLE_ID_PMT) return;
    if (section.length < 8) return;

    const version = section[5] >> 1;
    const currentNext = !!(section[5] & 0x01);
    const sectionNumber = section[6];
    const lastSectionNumber = section[7];

    const crcCalc = crc32Mpeg(section, 0, section.length - 4);
    const crcGot = readU32(section, section.length - 4);
    const crcOk = crcCalc === crcGot;

    const event = {
      packetIndex, pid, tableId, version, sectionNumber,
      lastSectionNumber, currentNext, crcOk, complete: true,
    };
    this.sections.push(event);

    if (!crcOk) {
      this.crcFailures.push({
        packetIndex, pid, tableId,
        detail: `CRC32 mismatch: calculated 0x${crcCalc.toString(16).padStart(8, "0")}, table carries 0x${crcGot.toString(16).padStart(8, "0")}`,
      });
      return;
    }
    if (!currentNext) {
      // Next table: valid but not yet applicable. Recorded above, not applied.
      return;
    }

    if (tableId === TABLE_ID_PAT) {
      this._applyPat(section, packetIndex, version);
    } else {
      this._applyPmt(section, pid, packetIndex, version);
    }
  }

  _applyPat(section, packetIndex, version) {
    const transportStreamId = (section[3] << 8) | section[4];
    const programs = new Map();
    // section_syntax_indicator..section_length (3) + tsid(2) + reserved/version(1)
    // + section_number(1) + last_section_number(1) => loop starts at offset 8
    let i = 8;
    const end = section.length - 4; // stop before CRC32
    while (i + 4 <= end) {
      const programNumber = (section[i] << 8) | section[i + 1];
      const pid = ((section[i + 2] & 0x1f) << 8) | section[i + 3];
      if (programNumber !== 0) programs.set(programNumber, pid);
      // program_number 0 is the network PID
      i += 4;
    }
    this.currentPat = { transportStreamId, version, programs, packetIndex };
    for (const pmtPid of programs.values()) this.pmtPids.add(pmtPid);
    this.mapTimeline.push({
      packetIndex, type: "PAT", transportStreamId, version,
      programs: [...programs.entries()].map(([programNumber, pmtPid]) => ({ programNumber, pmtPid })),
    });
  }

  _applyPmt(section, pmtPid, packetIndex, version) {
    const programNumber = (section[3] << 8) | section[4];
    const pcrPid = ((section[8] & 0x1f) << 8) | section[9];
    const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
    const streams = [];
    let i = 12 + programInfoLength;
    const end = section.length - 4;
    while (i + 5 <= end) {
      const streamType = section[i];
      const elementaryPid = ((section[i + 1] & 0x1f) << 8) | section[i + 2];
      const esInfoLength = ((section[i + 3] & 0x0f) << 8) | section[i + 4];
      streams.push({ streamType, elementaryPid });
      i += 5 + esInfoLength;
    }
    const pmt = { programNumber, pmtPid, pcrPid, version, streams, packetIndex };
    this.currentPmts.set(pmtPid, pmt);
    this.mapTimeline.push({
      packetIndex, type: "PMT", programNumber, pmtPid, pcrPid, version,
      streams: streams.map((s) => ({ ...s })),
    });
  }

  /**
   * Program relationships in force at a given packet index.
   * Returns { programs: [{ programNumber, pmtPid, pcrPid, streams: [{streamType, elementaryPid}] }] }
   * Only current, CRC-valid tables seen at or before the index are considered.
   */
  mapAt(packetIndex) {
    const pat = this._latestAt(this.mapTimeline.filter((e) => e.type === "PAT"), packetIndex);
    const programs = [];
    if (!pat) return { programs, ready: false };
    for (const { programNumber, pmtPid } of pat.programs) {
      const pmtEvent = this._latestAt(
        this.mapTimeline.filter((e) => e.type === "PMT" && e.pmtPid === pmtPid),
        packetIndex,
      );
      programs.push({
        programNumber,
        pmtPid,
        pcrPid: pmtEvent ? pmtEvent.pcrPid : null,
        streams: pmtEvent ? pmtEvent.streams.map((s) => ({ ...s })) : [],
      });
    }
    return { programs, ready: programs.length > 0 };
  }

  _latestAt(events, packetIndex) {
    let latest = null;
    for (const e of events) {
      if (e.packetIndex <= packetIndex) latest = e;
      else break;
    }
    return latest;
  }

  // Flush at end of capture. A genuinely unfinished PSI section is reported
  // only when the buffered bytes actually begin with a well-formed section
  // header (valid table_id + syntax/reserved pattern); a leftover PES payload
  // on a table-range PID is left alone instead of raising a false alarm.
  flush() {
    for (const [pid, ip] of this.inProgress) {
      const buf = concatChunks(ip.chunks);
      let i = 0;
      while (i < buf.length && buf[i] === 0xff) i++;
      if (buf.length - i < 3) continue;
      const tableId = buf[i];
      const syntaxByte = buf[i + 1];
      const secLen = ((syntaxByte & 0x0f) << 8) | buf[i + 2];
      const hasSyntax = !!(syntaxByte & 0x80);
      const reservedTriple = (syntaxByte >> 4) & 0x07;
      const looksLikeSection =
        tableId <= 0x3f && hasSyntax && reservedTriple === 0x03 &&
        secLen >= 9 && secLen <= 1021 && 3 + secLen > buf.length - i;
      if (!looksLikeSection) continue;
      this.sections.push({
        packetIndex: ip.startPacket, pid, tableId,
        version: null, sectionNumber: null, lastSectionNumber: null,
        currentNext: null, crcOk: false, complete: false,
      });
    }
  }
}

function concatChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
function readU32(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}
