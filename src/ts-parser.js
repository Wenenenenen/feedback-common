// MPEG-TS (ISO 13818-1) packet parser.
// Framing, adaptation fields, continuity counters, PES headers, PCR/PTS.
// Video payload is never parsed beyond the PES header.

export const TS_PACKET_SIZE = 188;
export const SYNC_BYTE = 0x47;
export const MAX_FILE_SIZE = 32 * 1024 * 1024;

// Continuity / packet-level issue markers
export const Issue = Object.freeze({
  SYNC_LOST: "sync_lost", // no 0x47 where a packet should start
  TRUNCATED_PACKET: "truncated_packet", // fewer than 188 bytes at EOF
  TEI_SET: "tei_set", // transport_error_indicator
  EXACT_DUPLICATE: "exact_duplicate", // whole 188 bytes identical, same CC
  SAME_CC_DIFFERENT: "same_cc_different", // same CC, different bytes
  CC_GAP: "cc_gap", // missing packet(s) inferred from CC jump
  DISCONTINUITY: "discontinuity", // adaptation_field discontinuity_indicator set
  ADAPTATION_ONLY: "adaptation_only", // afc=2: no payload, CC not incremented
  PAYLOAD_CLEAR_CC: "payload_clear_cc", // afc=0 with payload but CC == 0x0F+1... unused; kept for docs
});

// Adaptation field control values
const AFC_RESERVED = 0;
const AFC_PAYLOAD_ONLY = 1;
const AFC_ADAPTATION_ONLY = 2;
const AFC_ADAPTATION_AND_PAYLOAD = 3;

function readPcr27(b, i) {
  // 33-bit base + 6 reserved bits + 9-bit extension, total 48 bits
  const base =
    (BigInt(b[i]) << 25n) |
    (BigInt(b[i + 1]) << 17n) |
    (BigInt(b[i + 2]) << 9n) |
    (BigInt(b[i + 3]) << 1n) |
    (BigInt(b[i + 4]) >> 7n);
  const ext = BigInt(((b[i + 4] & 0x01) << 8) | b[i + 5]);
  return base * 300n + ext;
}

// Parse a PES header from a payload that begins with start_code 0x000001.
// Only the header is inspected; the rest of the PES is video data we ignore.
function parsePesHeader(payload) {
  if (payload.length < 9 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) {
    return null;
  }
  const streamId = payload[3];
  // padding stream (0xBC) and a few others have no PES header flags
  if (streamId === 0xbc || (streamId >= 0xf0 && streamId <= 0xf2) || streamId === 0xff) {
    return { streamId, ptsDtsFlags: 0, pts: null, dts: null, headerLength: 0 };
  }
  const ptsDtsFlags = payload[7] >> 6;
  const pesHeaderDataLength = payload[8];
  let pts = null;
  let dts = null;
  let p = 9;
  const readTs = (i) =>
    ((BigInt(payload[i] >> 1) & 7n) << 30n) |
    (BigInt(payload[i + 1]) << 22n) |
    ((BigInt(payload[i + 2] >> 1) & 0x7fn) << 15n) |
    (BigInt(payload[i + 3]) << 7n) |
    (BigInt(payload[i + 4] >> 1) & 0x7fn);
  if ((ptsDtsFlags === 2 || ptsDtsFlags === 3) && p + 5 <= payload.length) {
    pts = readTs(p);
    p += 5;
    if (ptsDtsFlags === 3 && p + 5 <= payload.length) {
      dts = readTs(p);
    }
  }
  return {
    streamId,
    ptsDtsFlags,
    pts,
    dts,
    headerLength: 3 + 3 + pesHeaderDataLength, // start code(3)+length(2)+flags(3)+data
  };
}

// Locate the first sync byte; returns -1 if none found within 188 bytes.
export function findFirstSync(view) {
  const limit = Math.min(view.byteLength, TS_PACKET_SIZE);
  for (let i = 0; i < limit; i++) {
    if (view.getUint8(i) === SYNC_BYTE) return i;
  }
  return -1;
}

/**
 * Parse an entire TS capture.
 *
 * @param {ArrayBuffer} buffer
 * @returns {object} {
 *   packets: PacketRow[],          // one entry per 188-byte slot (plus sync-loss notes)
 *   pcrSamples: PcrSample[],       // every PCR in capture order
 *   ptsSamples: PtsSample[],       // every PES PTS/DTS in capture order
 *   anomalies: Anomaly[],          // flat, exportable issue list
 *   firstSyncOffset, byteLength, packetCount, trailingBytes
 * }
 *
 * PacketRow fields: index, offset, pid, pusi, tei, priority, scrambling,
 *   afc, cc, hasPayload, payloadStart, payloadLength, adaptation (object|null),
 *   pes (object|null), issues: string[]
 */
export function parseTs(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const byteLength = bytes.byteLength;

  const firstSyncOffset = findFirstSync(view);
  const packets = [];
  const pcrSamples = [];
  const ptsSamples = [];
  const anomalies = [];

  const addAnomaly = (type, packetIndex, pid, detail) => {
    anomalies.push({ type, packetIndex, pid: pid ?? null, detail: detail ?? null });
  };

  if (firstSyncOffset < 0) {
    return {
      packets, pcrSamples, ptsSamples, anomalies,
      firstSyncOffset: -1, byteLength, packetCount: 0, trailingBytes: byteLength,
    };
  }
  if (firstSyncOffset > 0) {
    addAnomaly(Issue.SYNC_LOST, null, null,
      `${firstSyncOffset} leading byte(s) before first 0x47 sync byte`);
  }

  // Per-PID continuity state
  const ccState = new Map(); // pid -> { lastCc, lastPacketIndex, lastBytes, sawPayload }

  let offset = firstSyncOffset;
  let index = 0;

  while (offset < byteLength) {
    const remaining = byteLength - offset;
    if (remaining < TS_PACKET_SIZE) {
      addAnomaly(Issue.TRUNCATED_PACKET, index, null,
        `only ${remaining} byte(s) at offset ${offset}, expected 188`);
      break;
    }

    if (view.getUint8(offset) !== SYNC_BYTE) {
      addAnomaly(Issue.SYNC_LOST, index, null,
        `expected sync byte at offset ${offset}, found 0x${view.getUint8(offset).toString(16).padStart(2, "0")}`);
      // resync at the next 0x47
      let next = offset + 1;
      while (next < byteLength && view.getUint8(next) !== SYNC_BYTE) next++;
      if (next >= byteLength) break;
      offset = next;
      continue;
    }

    const b0 = view.getUint8(offset + 1);
    const b1 = view.getUint8(offset + 2);
    const b2 = view.getUint8(offset + 3);
    const tei = (b0 >> 7) & 1;
    const pusi = (b0 >> 6) & 1;
    const priority = (b0 >> 5) & 1;
    const pid = ((b0 & 0x1f) << 8) | b1;
    const scrambling = (b2 >> 6) & 3;
    const afc = (b2 >> 4) & 3;
    const cc = b2 & 0x0f;

    const row = {
      index,
      offset,
      pid,
      pusi,
      tei: !!tei,
      priority: !!priority,
      scrambling,
      afc,
      cc,
      hasPayload: !!(afc & 1),
      payloadStart: 0,
      payloadLength: 0,
      adaptation: null,
      pes: null,
      issues: [],
    };

    // Adaptation field
    let payloadStart = 4;
    let af = null;
    if (afc & 2) {
      const afLength = view.getUint8(offset + 4);
      af = { length: afLength, flags: 0, discontinuity: false, randomAccess: false, pcr: null };
      if (afLength > 0) {
        const flags = view.getUint8(offset + 5);
        af.flags = flags;
        af.discontinuity = !!(flags & 0x80);
        af.randomAccess = !!(flags & 0x40);
        if ((flags & 0x10) && afLength >= 7 && offset + 12 <= byteLength) {
          af.pcr = readPcr27(bytes, offset + 6);
        }
      }
      row.adaptation = af;
      payloadStart = 5 + afLength;
      if (payloadStart > TS_PACKET_SIZE) payloadStart = TS_PACKET_SIZE;
    }

    if (afc === AFC_RESERVED) {
      row.issues.push("reserved_afc");
      addAnomaly("reserved_afc", index, pid, "adaptation_field_control reserved value 00");
    }

    // Payload (afc 1 or 3). afc 2 is adaptation-only and legally keeps the CC.
    if (afc & 1) {
      row.payloadStart = payloadStart;
      row.payloadLength = TS_PACKET_SIZE - payloadStart;
      if (pusi && row.payloadLength > 0) {
        const pes = parsePesHeader(bytes.subarray(offset + payloadStart, offset + TS_PACKET_SIZE));
        if (pes) {
          row.pes = pes;
          if (pes.pts !== null) {
            ptsSamples.push({
              packetIndex: index, pid, kind: "PTS", value: pes.pts,
              dts: pes.dts, streamId: pes.streamId,
            });
          }
          if (pes.dts !== null) {
            ptsSamples.push({
              packetIndex: index, pid, kind: "DTS", value: pes.dts,
              dts: null, streamId: pes.streamId,
            });
          }
        }
      }
    } else if (afc === AFC_ADAPTATION_ONLY) {
      row.issues.push(Issue.ADAPTATION_ONLY);
      addAnomaly(Issue.ADAPTATION_ONLY, index, pid,
        "adaptation-field-only packet (no payload); CC held without increment");
    }

    if (af && af.pcr !== null) {
      pcrSamples.push({
        packetIndex: index,
        pid,
        pcrBase: af.pcr / 300n,
        pcrExtension: af.pcr % 300n,
        value: af.pcr,
        discontinuity: af.discontinuity,
      });
    }

    if (af && af.discontinuity) {
      row.issues.push(Issue.DISCONTINUITY);
      addAnomaly(Issue.DISCONTINUITY, index, pid,
        "adaptation_field discontinuity_indicator set");
    }
    if (tei) {
      row.issues.push(Issue.TEI_SET);
      addAnomaly(Issue.TEI_SET, index, pid, "transport_error_indicator set");
    }

    // --- Continuity check per PID (ISO 13818-1 §2.4.3.3) ---
    // baselineCc is the CC of the last *non-duplicate* packet: a repeated
    // packet must not advance the sequence baseline, otherwise a gap hiding
    // behind the duplicate becomes invisible.
    const state = ccState.get(pid);
    const packetBytes = bytes.subarray(offset, offset + TS_PACKET_SIZE);
    let isDuplicate = false;
    if (state) {
      const expected = (state.baselineCc + 1) & 0x0f;
      const sameCc = state.baselineCc === cc;

      if (sameCc) {
        if (afc & 1) {
          // Same CC with payload: either an exact repeat or same-CC/different.
          let identical = true;
          const prev = state.lastBytes;
          for (let i = 0; i < TS_PACKET_SIZE; i++) {
            if (prev[i] !== packetBytes[i]) { identical = false; break; }
          }
          if (identical) {
            isDuplicate = true;
            row.issues.push(Issue.EXACT_DUPLICATE);
            addAnomaly(Issue.EXACT_DUPLICATE, index, pid,
              `identical repeat of packet #${state.lastPacketIndex} (CC 0x${cc.toString(16)})`);
          } else {
            row.issues.push(Issue.SAME_CC_DIFFERENT);
            addAnomaly(Issue.SAME_CC_DIFFERENT, index, pid,
              `same CC 0x${cc.toString(16)} as #${state.lastPacketIndex} but content differs`);
          }
        }
        // afc=2 adaptation-only: same CC is legal and not a gap
      } else if (afc !== AFC_ADAPTATION_ONLY && cc !== expected) {
        // CC jumped. The number of missing payload packets is the modular
        // distance minus one (E -> 0 means one packet, CC F, is missing).
        const modDelta = (cc - state.baselineCc) & 0x0f;
        const missing = modDelta - 1;
        if (missing > 0) {
          row.issues.push(Issue.CC_GAP);
          addAnomaly(Issue.CC_GAP, index, pid,
            `CC 0x${state.baselineCc.toString(16)} -> 0x${cc.toString(16)}: ${missing} packet(s) missing (expected CC 0x${expected.toString(16)} at this position)`);
        }
      }
    }
    ccState.set(pid, {
      // Duplicates hold the baseline; every other packet adopts its own CC.
      baselineCc: isDuplicate && state ? state.baselineCc : cc,
      lastCc: cc,
      lastPacketIndex: index,
      lastBytes: packetBytes.slice(),
      sawPayload: !!(afc & 1),
    });

    packets.push(row);
    offset += TS_PACKET_SIZE;
    index++;
  }

  return {
    packets,
    pcrSamples,
    ptsSamples,
    anomalies,
    firstSyncOffset,
    byteLength,
    packetCount: packets.length,
    trailingBytes: byteLength - offset,
  };
}
