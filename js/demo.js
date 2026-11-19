/*
 * demo.js — 内置演示数据（页面离线也能直接看到完整工作状态）
 * 60 槽、单声道、48kHz，anchor_seq 取 65530 制造序号回绕；
 * 含乱序、重复、迟到、PCM 长度错误、timestamp 错误各若干。
 * 真实数据请用页面上的“导入 JSON”。
 */

const FPP = 480;

function encodePcm(samples) {
  let bin = "";
  for (const s of samples) {
    const v = Math.max(-32768, Math.min(32767, s));
    bin += String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
  }
  return btoa(bin);
}

function toneSamples(k) {
  // 每槽一段 480 样本：基频随槽位变化的正弦 + 轻微幅度包络，波形可视化清晰可辨
  const freq = 220 + k * 12;
  const out = new Int16Array(FPP);
  for (let i = 0; i < FPP; i++) {
    const env = 0.55 * Math.sin((Math.PI * i) / FPP);
    out[i] = Math.round(18000 * env * Math.sin((2 * Math.PI * freq * i) / 48000));
  }
  return out; // Int16Array，交给 encodePcm 按 16 位小端编码
}

export function buildDemoDoc() {
  const total = 60;
  const anchorSeq = 65530;
  const anchorTs = 4294960000; // 靠近 2^32，触发时间戳回绕
  const originUs = 0;
  const U16 = 65536;
  const U32 = 2 ** 32;
  const packets = [];

  const seqOf = (k) => (anchorSeq + k) % U16;
  const tsOf = (k) => (anchorTs + FPP * k) % U32;

  for (let k = 0; k < total; k++) {
    // 制造乱序：大部分按时到达，少量提前/滞后交换，网络抖动 ±6ms
    const jitter = Math.round((((k * 37) % 13) - 6) * 1000);
    let arrival = originUs + 10000 * k + jitter;

    // 部分包明显迟到（超过 10ms 与 30ms 两档截止）
    if (k % 9 === 4) arrival += 45000;
    if (k % 7 === 3) arrival += 18000;
    if (arrival < 0) arrival = 0;

    packets.push({
      id: `p${k}`,
      arrival_us: arrival,
      seq: seqOf(k),
      timestamp: tsOf(k),
      pcm_b64: encodePcm(toneSamples(k)),
    });
  }

  // 重复包：对槽 2、11、40 各补一个更晚到达的同序号包
  for (const k of [2, 11, 40]) {
    packets.push({
      id: `dup${k}`,
      arrival_us: packets[k].arrival_us + 7000,
      seq: seqOf(k),
      timestamp: tsOf(k),
      pcm_b64: packets[k].pcm_b64,
    });
  }

  // 坏包 1：PCM 长度只有 1 字节（对应槽 7）
  packets.push({
    id: "badLen7",
    arrival_us: 71000,
    seq: seqOf(7),
    timestamp: tsOf(7),
    pcm_b64: btoa(String.fromCharCode(0)),
  });

  // 坏包 2：timestamp 与槽位不符（对应槽 14）
  packets.push({
    id: "badTs14",
    arrival_us: 141000,
    seq: seqOf(14),
    timestamp: (tsOf(14) + 960) % U32,
    pcm_b64: encodePcm(toneSamples(14)),
  });

  // 打乱输入顺序，模拟真实记录并非按到达排列
  const shuffled = packets
    .map((p, i) => ({ p, i }))
    .sort((a, b) => ((a.i * 1103515245 + 12345) % 97 - (b.i * 1103515245 + 12345) % 97))
    .map((x) => x.p);

  return {
    rate: 48000,
    channels: 1,
    frames_per_packet: FPP,
    anchor_seq: anchorSeq,
    anchor_ts: anchorTs,
    origin_us: originUs,
    total_packets: total,
    packets: shuffled,
  };
}
