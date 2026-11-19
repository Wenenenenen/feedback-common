/*
 * engine.js — 分包音频播放缓冲的核心判定与补偿逻辑（无 DOM 依赖，可在 Node 中测试）
 *
 * 规则来源：samples/extracted/约定.txt
 *  - 槽位 k = (seq - anchor_seq) mod 65536，必须 < total_packets
 *  - timestamp 必须等于 (anchor_ts + 480*k) mod 2^32
 *  - 包先按 (arrival_us, 输入索引) 稳定排序；坏包 invalid 不占槽
 *  - 合法包槽位已占 -> duplicate；否则先占槽，再按
 *    arrival_us <= origin_us + delay_ms*1000 + 10000*k 判 accepted/late（恰好赶上也算）
 *  - 播放只用 accepted；未接收槽位：zero 补零，repeat_decay 以最后正常播放包
 *    为基准连续缺失第 r 槽乘 0.8^r，逐样本 |x| 四舍五入、保留符号
 */

export const U16_MOD = 1 << 16;
export const U32_MOD = 2 ** 32; // 注意：1<<32 在 JS 中会回绕成 1，必须用 **
export const DECAY_BASE = 0.8;

export const STATUS = {
  ACCEPTED: "accepted",
  LATE: "late",
  DUPLICATE: "duplicate",
  INVALID: "invalid",
};

const u16 = (x) => ((x % U16_MOD) + U16_MOD) % U16_MOD;
const u32 = (x) => ((x % U32_MOD) + U32_MOD) % U32_MOD;

function isNonNegInt(x, maxExclusive) {
  return (
    typeof x === "number" &&
    Number.isInteger(x) &&
    x >= 0 &&
    (maxExclusive === undefined || x < maxExclusive)
  );
}

function decodeBase64(b64) {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}

/* 读取小端有符号 16 位样本 */
function readInt16LE(bytes, offset) {
  const v = bytes[offset] | (bytes[offset + 1] << 8);
  return v << 16 >> 16;
}

function writeInt16LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

/**
 * 校验并分析一份输入文档。
 * @param {object} doc  解析后的 JSON 文档
 * @param {number} delayMs 固定缓冲延迟 0..200
 * @param {"zero"|"repeat_decay"} policy 丢包补偿策略
 * @returns {object} 完整分析结果
 */
export function analyzePlayout(doc, delayMs, policy) {
  const errors = validateHeader(doc);
  if (errors.length) {
    return { ok: false, errors, header: null, packets: [], slots: [], pcm: null };
  }

  const {
    rate,
    channels,
    frames_per_packet: fpp,
    anchor_seq: anchorSeq,
    anchor_ts: anchorTs,
    origin_us: originUs,
    total_packets: total,
  } = doc;

  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 200) {
    return { ok: false, errors: ["delay_ms 必须是 0..200 的整数"], header: null, packets: [], slots: [], pcm: null };
  }
  if (policy !== "zero" && policy !== "repeat_decay") {
    return { ok: false, errors: ["policy 必须是 zero 或 repeat_decay"], header: null, packets: [], slots: [], pcm: null };
  }

  const raw = Array.isArray(doc.packets) ? doc.packets : [];
  const expectedPcmBytes = fpp * channels * 2;
  const samplesPerPacket = fpp * channels;

  // 稳定排序：arrival_us 优先，输入索引兜底
  const order = raw
    .map((p, inputIndex) => ({ p, inputIndex }))
    .sort((a, b) => {
      const ta = typeof a.p.arrival_us === "number" ? a.p.arrival_us : Number.POSITIVE_INFINITY;
      const tb = typeof b.p.arrival_us === "number" ? b.p.arrival_us : Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return a.inputIndex - b.inputIndex;
    });

  const packets = [];
  const slotOwner = new Array(total).fill(null);

  for (const { p, inputIndex } of order) {
    const id = typeof p.id === "string" && p.id !== "" ? p.id : `#${inputIndex}`;
    const arrival = p.arrival_us;
    const reasons = [];

    if (!isNonNegInt(arrival, Number.MAX_SAFE_INTEGER)) {
      reasons.push("arrival_us 不是非负整数");
    }
    if (!isNonNegInt(p.seq, U16_MOD)) {
      reasons.push("seq 不是 16 位无符号整数（0..65535）");
    }
    if (!isNonNegInt(p.timestamp, U32_MOD)) {
      reasons.push("timestamp 不是 32 位无符号整数（0..4294967295）");
    }

    const pcm = decodeBase64(p.pcm_b64);
    if (pcm === null) {
      reasons.push("pcm_b64 缺失或不是合法 base64");
    } else if (pcm.length !== expectedPcmBytes) {
      reasons.push(`PCM 长度 ${pcm.length} 字节 ≠ 约定 ${expectedPcmBytes} 字节（480×${channels}×2）`);
    }

    let slot = null;
    let deadline = null;
    let expectedTs = null;
    if (isNonNegInt(p.seq, U16_MOD)) {
      slot = u16(p.seq - anchorSeq);
      expectedTs = u32(anchorTs + fpp * slot);
      if (slot >= total) {
        reasons.push(`序号对应槽位 ${slot} ≥ total_packets ${total}，超出播放范围`);
      }
      if (isNonNegInt(p.timestamp, U32_MOD) && slot < total && p.timestamp !== expectedTs) {
        reasons.push(`timestamp ${p.timestamp} ≠ 槽 ${slot} 的期望值 ${expectedTs}（序号回绕按模 2^32 计算）`);
      }
      if (slot < total) {
        deadline = originUs + delayMs * 1000 + 10000 * slot;
      }
    }

    const base = {
      id,
      input_index: inputIndex,
      arrival_us: isNonNegInt(arrival, Number.MAX_SAFE_INTEGER) ? arrival : null,
      seq: isNonNegInt(p.seq, U16_MOD) ? p.seq : null,
      timestamp: isNonNegInt(p.timestamp, U32_MOD) ? p.timestamp : null,
      slot,
      deadline_us: deadline,
    };

    if (reasons.length) {
      packets.push({ ...base, status: STATUS.INVALID, reason: reasons.join("；") });
      continue; // 坏包不占槽
    }

    const owner = slotOwner[slot];
    if (owner !== null) {
      packets.push({
        ...base,
        status: STATUS.DUPLICATE,
        reason: `槽 ${slot}（seq=${u16(anchorSeq + slot)}）已被先到的 ${owner.id} 占用，重复包不参与播放`,
      });
      continue;
    }

    // 先占槽
    slotOwner[slot] = { id, pcm, arrival_us: arrival };
    if (arrival <= deadline) {
      packets.push({
        ...base,
        status: STATUS.ACCEPTED,
        reason: `arrival_us=${arrival} ≤ 截止 ${deadline}（含恰好赶上），接收并占用播放槽 ${slot}`,
      });
    } else {
      packets.push({
        ...base,
        status: STATUS.LATE,
        reason: `arrival_us=${arrival} > 截止 ${deadline}，迟到 ${arrival - deadline} µs；已占槽但不参与播放`,
      });
    }
  }

  // ---- 逐槽播放与补偿 ----
  const pcmBytes = total * expectedPcmBytes;
  const pcm = new Uint8Array(pcmBytes);
  const slots = new Array(total);
  let lastGoodPcm = null;
  let missRun = 0;

  for (let k = 0; k < total; k++) {
    const deadline = originUs + delayMs * 1000 + 10000 * k;
    const owner = slotOwner[k];
    const accepted = owner !== null && owner.arrival_us <= deadline;
    let source = null;
    let conceal = null; // null | "zero" | "repeat_decay"

    if (accepted) {
      source = owner.id;
      pcm.set(owner.pcm, k * expectedPcmBytes);
      lastGoodPcm = owner.pcm;
      missRun = 0;
    } else {
      missRun += 1;
      const offset = k * expectedPcmBytes;
      if (policy === "zero" || lastGoodPcm === null) {
        // 初始没有正常包，或选了补零策略：该段保持全 0
        conceal = lastGoodPcm === null ? "zero(无历史正常包)" : "zero";
      } else {
        conceal = `repeat_decay r=${missRun} (×0.8^${missRun}=${Math.pow(DECAY_BASE, missRun).toFixed(6)})`;
        const factor = Math.pow(DECAY_BASE, missRun);
        for (let s = 0; s < samplesPerPacket; s++) {
          const pos = 2 * s;
          const sample = readInt16LE(lastGoodPcm, pos);
          // 逐样本绝对值四舍五入、保留符号
          const mag = Math.round(Math.abs(sample) * factor);
          let out = sample >= 0 ? mag : -mag;
          if (out > 32767) out = 32767;
          if (out < -32768) out = -32768;
          writeInt16LE(pcm, offset + pos, out);
        }
      }
    }

    slots[k] = {
      slot: k,
      deadline_us: deadline,
      source,
      status: accepted
        ? STATUS.ACCEPTED
        : owner === null
          ? (policy === "zero" || lastGoodPcm === null ? "concealed-zero" : "concealed-decay")
          : STATUS.LATE,
      conceal,
    };
  }

  return {
    ok: true,
    errors: [],
    header: {
      rate,
      channels,
      fpp,
      anchorSeq,
      anchorTs,
      originUs,
      total,
      expectedPcmBytes,
      durationSec: (total * fpp) / rate,
    },
    delayMs,
    policy,
    packets,
    slots,
    pcm,
  };
}

export function validateHeader(doc) {
  const errors = [];
  if (typeof doc !== "object" || doc === null) {
    return ["JSON 顶层必须是对象"];
  }
  if (doc.rate !== 48000) errors.push("rate 必须为 48000");
  if (doc.channels !== 1 && doc.channels !== 2) errors.push("channels 必须为 1 或 2");
  if (doc.frames_per_packet !== 480) errors.push("frames_per_packet 必须为 480");
  if (!isNonNegInt(doc.anchor_seq, U16_MOD)) errors.push("anchor_seq 必须是 16 位无符号整数");
  if (!isNonNegInt(doc.anchor_ts, U32_MOD)) errors.push("anchor_ts 必须是 32 位无符号整数");
  if (!isNonNegInt(doc.origin_us, Number.MAX_SAFE_INTEGER)) errors.push("origin_us 必须是非负整数");
  if (!Number.isInteger(doc.total_packets) || doc.total_packets < 1 || doc.total_packets > 6000) {
    errors.push("total_packets 必须是 1..6000 的整数");
  }
  if (!Array.isArray(doc.packets)) errors.push("packets 必须是数组");
  else if (doc.packets.length > 12000) errors.push("包数不能超过 12000");
  const durationSec = (doc.total_packets * (doc.frames_per_packet || 0)) / (doc.rate || 1);
  if (durationSec > 60) errors.push("总时长超过 60 秒上限");
  return errors;
}

/** 构造与样例 expected.json 同结构（并含详细原因）的导出对象 */
export function buildExportJson(result) {
  const packetStatus = {};
  const packetDetails = [];
  for (const v of result.packets) {
    packetStatus[v.id] = v.status;
    packetDetails.push({
      id: v.id,
      input_index: v.input_index,
      arrival_us: v.arrival_us,
      seq: v.seq,
      timestamp: v.timestamp,
      slot: v.slot,
      deadline_us: v.deadline_us,
      status: v.status,
      reason: v.reason,
    });
  }
  return {
    delay_ms: result.delayMs,
    policy: result.policy,
    packets: packetStatus,
    packet_details: packetDetails,
    slots: result.slots.map((s) => ({
      slot: s.slot,
      deadline_us: s.deadline_us,
      source: s.source,
      status: s.status,
      conceal: s.conceal,
    })),
  };
}
