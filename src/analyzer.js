// High-level analysis: wires ts-parser + psi-tables + clock unwrapping into
// per-PID clock series, segments, program membership and a unified anomaly list.

import { parseTs, Issue } from "./ts-parser.js";
import { PsiAssembler } from "./psi-tables.js";
import { ClockUnwrapper, PCR_MOD, PTS_MOD, pcrToSeconds, ptsToSeconds } from "./clock.js";

/**
 * @typedef {Object} ClockPoint
 * @property {number} packetIndex
 * @property {number} pid
 * @property {string} kind        'PCR' | 'PTS' | 'DTS'
 * @property {bigint} raw         raw modular clock value
 * @property {bigint} unwrapped   monotonically extended value
 * @property {bigint} delta       signed raw delta vs previous sample of this series
 * @property {string} deltaKind   'first'|'normal'|'wrap'|'regression'|'jump'
 * @property {number} seconds     unwrapped value converted to seconds
 * @property {boolean} discontinuity  (PCR only) adaptation discontinuity flag
 * @property {number} segmentId
 */

/**
 * @typedef {Object} Segment
 * @property {number} id
 * @property {number} startPacketIndex
 * @property {number|null} endPacketIndex
 * @property {string} reason      'start'|'discontinuity'|'program_switch'
 * @property {number} pid
 * @property {string} clockKind
 * @property {object|null} programInfo snapshot of program relationship at start
 */

export function analyze(buffer) {
  const parsed = parseTs(buffer);
  const bytes = new Uint8Array(buffer);
  const psi = new PsiAssembler();

  // Feed PSI from every packet (parser rows carry payload offsets).
  for (const row of parsed.packets) {
    psi.feed(row, bytes);
  }
  psi.flush();

  // Surface PSI CRC failures and incomplete sections in the unified anomaly list.
  for (const f of psi.crcFailures) {
    parsed.anomalies.push({
      type: "psi_crc_error",
      packetIndex: f.packetIndex,
      pid: f.pid,
      detail: f.detail,
    });
  }
  for (const s of psi.sections) {
    if (!s.complete) {
      parsed.anomalies.push({
        type: "psi_incomplete",
        packetIndex: s.packetIndex,
        pid: s.pid,
        detail: "section started but capture ended before it completed",
      });
    }
  }

  // --- Clock series per PID, with segments ---
  const pcrUnwrappers = new Map(); // pid -> ClockUnwrapper
  const ptsUnwrappers = new Map(); // pid -> ClockUnwrapper
  const pcrSegments = new Map();   // pid -> Segment[]
  const ptsSegments = new Map();
  const clockPoints = [];

  const getUnwrapper = (map, pid, mod) => {
    let u = map.get(pid);
    if (!u) { u = new ClockUnwrapper(mod); map.set(pid, u); }
    return u;
  };
  const startSegment = (segments, pid, packetIndex, reason, kind, programInfo) => {
    const list = segments.get(pid) ?? [];
    if (list.length) list[list.length - 1].endPacketIndex = packetIndex - 1;
    const seg = {
      id: list.length, startPacketIndex: packetIndex, endPacketIndex: null,
      reason, pid, clockKind: kind, programInfo: programInfo ?? null,
    };
    list.push(seg);
    segments.set(pid, list);
    return seg;
  };

  // Detect PID switches per program from the PMT timeline.
  const pendingSwitch = buildSwitchEvents(psi.mapTimeline);
  const lastPcrIndex = new Map();
  const lastPtsIndex = new Map();

  const programInfoAt = (packetIndex, pid) => {
    const map = psi.mapAt(packetIndex);
    const hits = [];
    for (const prog of map.programs) {
      const isPcr = prog.pcrPid === pid;
      const stream = prog.streams.find((s) => s.elementaryPid === pid);
      if (isPcr || stream) {
        hits.push({
          programNumber: prog.programNumber,
          pmtPid: prog.pmtPid,
          role: isPcr ? "PCR" : "elementary",
          streamType: stream ? stream.streamType : null,
        });
      }
    }
    return hits;
  };

  // PCR samples (already in capture order)
  for (const s of parsed.pcrSamples) {
    const u = getUnwrapper(pcrUnwrappers, s.pid, PCR_MOD);
    const switched = consumesSwitch(pendingSwitch, s.pid, s.packetIndex, lastPcrIndex);
    const firstSeries = !pcrSegments.has(s.pid);

    if (switched) {
      // A PMT change affecting this PID starts a fresh segment even when the
      // PID itself is newly introduced (its first sample is switch-born).
      if (!firstSeries) u.reset();
      startSegment(pcrSegments, s.pid, s.packetIndex, "program_switch", "PCR",
        programInfoAt(s.packetIndex, s.pid));
      parsed.anomalies.push({
        type: "program_switch_segment",
        packetIndex: s.packetIndex, pid: s.pid,
        detail: firstSeries
          ? "clock series starts on a PMT program switch (newly assigned PID)"
          : "new PCR segment started because the PMT changed this PID's role",
      });
    } else if (s.discontinuity) {
      u.reset();
      startSegment(pcrSegments, s.pid, s.packetIndex, "discontinuity", "PCR",
        programInfoAt(s.packetIndex, s.pid));
      parsed.anomalies.push({
        type: "pcr_discontinuity_segment",
        packetIndex: s.packetIndex, pid: s.pid,
        detail: "new PCR segment started due to adaptation discontinuity",
      });
    } else if (firstSeries) {
      startSegment(pcrSegments, s.pid, s.packetIndex, "start", "PCR",
        programInfoAt(s.packetIndex, s.pid));
    }
    lastPcrIndex.set(s.pid, s.packetIndex);

    const r = u.push(s.value);
    const segs = pcrSegments.get(s.pid);
    const seg = segs[segs.length - 1];
    const point = {
      packetIndex: s.packetIndex, pid: s.pid, kind: "PCR",
      raw: r.raw, unwrapped: r.unwrapped, delta: r.delta, deltaKind: r.kind,
      seconds: pcrToSeconds(r.unwrapped),
      discontinuity: s.discontinuity, segmentId: seg.id, segmentReason: seg.reason,
    };
    clockPoints.push(point);
    if (r.kind === "wrap") {
      parsed.anomalies.push({
        type: "pcr_wrap", packetIndex: s.packetIndex, pid: s.pid,
        detail: `PCR wrapped through 2^42 boundary (raw delta ${r.delta.toString()})`,
      });
    } else if (r.kind === "regression") {
      parsed.anomalies.push({
        type: "pcr_regression", packetIndex: s.packetIndex, pid: s.pid,
        detail: `PCR went backwards by ${(-r.delta).toString()} 27MHz ticks without wrap or discontinuity`,
      });
    } else if (r.kind === "jump") {
      parsed.anomalies.push({
        type: "pcr_large_jump", packetIndex: s.packetIndex, pid: s.pid,
        detail: `unexplained PCR forward jump of ${r.delta.toString()} ticks`,
      });
    }
  }

  // PTS/DTS samples
  for (const s of parsed.ptsSamples) {
    const u = getUnwrapper(ptsUnwrappers, s.pid, PTS_MOD);
    const switched = consumesSwitch(pendingSwitch, s.pid, s.packetIndex, lastPtsIndex);
    const firstSeries = !ptsSegments.has(s.pid);

    if (switched) {
      if (!firstSeries) u.reset();
      startSegment(ptsSegments, s.pid, s.packetIndex, "program_switch", s.kind,
        programInfoAt(s.packetIndex, s.pid));
      parsed.anomalies.push({
        type: "program_switch_segment",
        packetIndex: s.packetIndex, pid: s.pid,
        detail: firstSeries
          ? `${s.kind} series starts on a PMT program switch (newly assigned PID)`
          : `new ${s.kind} segment started because the PMT changed this PID's role`,
      });
    } else if (firstSeries) {
      startSegment(ptsSegments, s.pid, s.packetIndex, "start", s.kind,
        programInfoAt(s.packetIndex, s.pid));
    }
    lastPtsIndex.set(s.pid, s.packetIndex);

    const r = u.push(s.value);
    const segs = ptsSegments.get(s.pid);
    const seg = segs[segs.length - 1];
    const point = {
      packetIndex: s.packetIndex, pid: s.pid, kind: s.kind,
      raw: r.raw, unwrapped: r.unwrapped, delta: r.delta, deltaKind: r.kind,
      seconds: ptsToSeconds(r.unwrapped),
      discontinuity: false, segmentId: seg.id, segmentReason: seg.reason,
    };
    clockPoints.push(point);
    if (r.kind === "wrap") {
      parsed.anomalies.push({
        type: "pts_wrap", packetIndex: s.packetIndex, pid: s.pid,
        detail: `${s.kind} wrapped through 2^33 boundary (raw delta ${r.delta.toString()})`,
      });
    } else if (r.kind === "regression") {
      parsed.anomalies.push({
        type: "pts_regression", packetIndex: s.packetIndex, pid: s.pid,
        detail: `${s.kind} small backward step of ${(-r.delta).toString()} 90kHz ticks (not a wrap)`,
      });
    } else if (r.kind === "jump") {
      parsed.anomalies.push({
        type: "pts_large_jump", packetIndex: s.packetIndex, pid: s.pid,
        detail: `unexplained ${s.kind} forward jump of ${r.delta.toString()} ticks`,
      });
    }
  }

  // Close open segments at end of capture.
  for (const list of [...pcrSegments.values(), ...ptsSegments.values()]) {
    if (list.length && list[list.length - 1].endPacketIndex === null) {
      list[list.length - 1].endPacketIndex = parsed.packets.length
        ? parsed.packets[parsed.packets.length - 1].index
        : 0;
    }
  }

  // Deduplicate anomalies (same type+packetIndex+pid), keep first detail.
  const seen = new Set();
  const anomalies = [];
  for (const a of parsed.anomalies) {
    const key = `${a.type}|${a.packetIndex}|${a.pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anomalies.push(a);
  }
  anomalies.sort((a, b) => {
    const ai = a.packetIndex ?? -1;
    const bi = b.packetIndex ?? -1;
    return ai - bi || String(a.pid).localeCompare(String(b.pid));
  });

  return {
    ...parsed,
    anomalies,
    psi: {
      sections: psi.sections,
      mapTimeline: psi.mapTimeline,
      currentPat: psi.currentPat,
      currentPmts: [...psi.currentPmts.entries()],
      mapAt: (idx) => psi.mapAt(idx),
    },
    clockPoints,
    segments: { pcr: pcrSegments, pts: ptsSegments },
    pids: collectPidInfo(parsed, psi),
  };
}

// Build a per-PID set of packet indices at/after which a PMT role change is in
// force. A PMT arrives on its own PID packet, but the affected clock samples
// appear on their own PIDs at later packet indices, so a switch is recorded as
// "the first clock point for this PID at index >= switchIndex".
function buildSwitchEvents(timeline) {
  // pid -> earliest packet index at which its changed role is in force
  const pending = new Map();
  let prevPmt = new Map(); // pmtPid -> { pcrPid, streams }
  for (const e of timeline) {
    if (e.type !== "PMT") continue;
    const prev = prevPmt.get(e.pmtPid);
    const nowPids = new Set(e.streams.map((s) => s.elementaryPid));
    nowPids.add(e.pcrPid);
    const mark = (pid) => {
      if (!pending.has(pid) || e.packetIndex < pending.get(pid)) {
        pending.set(pid, e.packetIndex);
      }
    };
    if (prev) {
      const prevPids = new Set(prev.streams.map((s) => s.elementaryPid));
      prevPids.add(prev.pcrPid);
      for (const p of nowPids) if (!prevPids.has(p)) mark(p);
      for (const p of prevPids) if (!nowPids.has(p)) mark(p);
      if (prev.pcrPid !== e.pcrPid) {
        mark(prev.pcrPid);
        mark(e.pcrPid);
      }
    }
    prevPmt.set(e.pmtPid, { pcrPid: e.pcrPid, streams: e.streams });
  }
  return pending;
}

// True when this clock point is the first one at/after a pending PMT switch.
// Consumes the pending entry so a single switch creates exactly one segment.
function consumesSwitch(pending, pid, packetIndex, lastIndexByPid) {
  const switchAt = pending.get(pid);
  if (switchAt === undefined) return false;
  if (packetIndex < switchAt) return false;
  const last = lastIndexByPid.get(pid);
  if (last !== undefined && last >= switchAt) return false;
  return true;
}

function collectPidInfo(parsed, psi) {
  const map = new Map();
  for (const row of parsed.packets) {
    if (!map.has(row.pid)) {
      map.set(row.pid, {
        pid: row.pid, packetCount: 0, pcrCount: 0, ptsCount: 0,
        pusiCount: 0, roles: new Set(),
      });
    }
    const info = map.get(row.pid);
    info.packetCount++;
    if (row.pusi) info.pusiCount++;
  }
  for (const p of parsed.pcrSamples) map.get(p.pid) && map.get(p.pid).pcrCount++;
  for (const p of parsed.ptsSamples) map && map.get(p.pid) && map.get(p.pid).ptsCount++;

  const finalMap = psi.mapAt(parsed.packets.length ? parsed.packets[parsed.packets.length - 1].index + 1 : 0);
  for (const prog of finalMap.programs) {
    if (map.has(prog.pmtPid)) map.get(prog.pmtPid).roles.add(`PMT(p${prog.programNumber})`);
    if (prog.pcrPid !== null && map.has(prog.pcrPid)) map.get(prog.pcrPid).roles.add(`PCR(p${prog.programNumber})`);
    for (const s of prog.streams) {
      if (map.has(s.elementaryPid)) {
        map.get(s.elementaryPid).roles.add(`stream 0x${s.streamType.toString(16).padStart(2, "0")}(p${prog.programNumber})`);
      }
    }
  }
  return [...map.values()].map((i) => ({ ...i, roles: [...i.roles] }))
    .sort((a, b) => a.pid - b.pid);
}

export { Issue };
