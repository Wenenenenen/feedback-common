// Per-frame CSV / JSON export with an explicit time base.
// Required columns per spec: center_frame, time_s, hz, confidence, voiced,
// note, cents. Unvoiced frames emit null for hz/note/cents.

import { noteFromHz } from "./tracker.js";

function round(x, digits) {
  if (x == null || !Number.isFinite(x)) return null;
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

export function buildRows(frames, a4) {
  return frames.map((f) => {
    const { note, cents } = noteFromHz(f.hz, a4);
    return {
      center_frame: f.centerFrame,
      time_s: round(f.timeS, 4),
      hz: f.voiced ? round(f.hz, 3) : null,
      confidence: round(f.confidence, 4),
      voiced: f.voiced,
      note: f.voiced ? note : null,
      cents: f.voiced ? round(cents, 2) : null,
    };
  });
}

export function toCSV(rows, meta) {
  const header = [
    `# monophonic pitch contour export`,
    `# sample_rate_hz=${meta.sampleRate}`,
    `# hop_samples=${meta.hop} (${meta.hopMs} ms, center frames 0,H,2H,...)`,
    `# window_ms=${meta.windowMs}`,
    `# search_hz=${meta.fMin}-${meta.fMax}`,
    `# yin_threshold=${meta.yinThreshold}`,
    `# voiced_threshold=${meta.voicedThreshold}`,
    `# a4_reference_hz=${meta.a4}`,
    `# time_base: time_s = center_frame / sample_rate_hz`,
  ].join("\n");
  const cols = ["center_frame", "time_s", "hz", "confidence", "voiced", "note", "cents"];
  const lines = [cols.join(",")];
  for (const r of rows) {
    lines.push(cols.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return "null";
      if (typeof v === "boolean") return v ? "true" : "false";
      return String(v);
    }).join(","));
  }
  return header + "\n" + lines.join("\n") + "\n";
}

export function toJSON(rows, meta) {
  return JSON.stringify({
    schema: "monophonic-pitch-contour/v1",
    time_base: {
      sample_rate_hz: meta.sampleRate,
      hop_samples: meta.hop,
      hop_ms: meta.hopMs,
      center_frames: "0,H,2H,... while center_frame < total_samples",
      time_s_relation: "time_s = center_frame / sample_rate_hz",
    },
    parameters: {
      window_ms: meta.windowMs,
      search_hz: [meta.fMin, meta.fMax],
      yin_threshold: meta.yinThreshold,
      voiced_threshold: meta.voicedThreshold,
      a4_reference_hz: meta.a4,
    },
    gate: meta.gate,
    frame_count: rows.length,
    frames: rows,
  }, null, 2);
}

export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
