/*
 * 导入校验：位深/声道/采样率/时长与固定长度计算。
 * 纯函数，不依赖 DOM，可在 Node 测试中直接使用。
 *
 * 规则：
 *  - 四条 IR 必须齐备（LL/LR/RL/RR 各一个单声道文件）；
 *  - 干声可以缺失（视为零输入），存在时必须是双声道；
 *  - 所有文件的采样率必须一致，不一致时逐文件指出；
 *  - 只接受 44.1/48 kHz、16/24 bit PCM（解析阶段已拒绝其它格式）。
 */

export const MAX_DRY_SECONDS = 60;
export const MAX_IR_SECONDS = 4;
export const MAX_PREDELAY_MS = 200;
export const SUPPORTED_RATES = [44100, 48000];
export const ROUTES = ['LL', 'LR', 'RL', 'RR'];
export const ROUTE_LABELS = {
  LL: { out: 'L', in: 'L', desc: '左出 ← 左入' },
  LR: { out: 'L', in: 'R', desc: '左出 ← 右入（串音）' },
  RL: { out: 'R', in: 'L', desc: '右出 ← 左入（串音）' },
  RR: { out: 'R', in: 'R', desc: '右出 ← 右入' },
};

const rateLabel = (rate) => `${rate.toLocaleString('en-US')} Hz`;

/** 时长文案：保留到毫秒，并给出精确到采样的位数，边界值不会被四舍五入成“正好等于上限”。 */
function formatDuration(frames, sampleRate) {
  const seconds = frames / sampleRate;
  const rounded = seconds.toFixed(3);
  if (Math.abs(Number(rounded) - seconds) > 1e-9) {
    return `${seconds.toFixed(6)} 秒`;
  }
  return `${rounded} 秒`;
}

/**
 * @param {object} files
 * @param {{name:string, parsed:object}|null} [files.dry]
 * @param {{name:string, parsed:object}} files.LL 等四路由
 */
export function validateFiles(files) {
  const errors = [];
  const addError = (file, message) => errors.push({ file, message });

  const dry = files.dry?.parsed ? files.dry : null;
  const irEntries = ROUTES.map((route) => {
    const entry = files[route]?.parsed ? files[route] : null;
    if (!entry) {
      addError(route, `缺少 ${route} 脉冲响应（需要单声道 ${route}.wav）`);
    }
    return entry;
  });

  // 采样率一致性：列出每个文件的采样率，明确点名不一致的文件
  const present = [];
  if (dry) present.push({ label: `干声（${dry.name}）`, rate: dry.parsed.sampleRate });
  ROUTES.forEach((route, i) => {
    if (irEntries[i]) {
      present.push({
        label: `${route}（${irEntries[i].name}）`,
        rate: irEntries[i].parsed.sampleRate,
      });
    }
  });

  let sampleRate = null;
  if (present.length) {
    const counts = new Map();
    for (const item of present) {
      counts.set(item.rate, (counts.get(item.rate) || 0) + 1);
    }
    if (counts.size > 1) {
      // 以出现次数最多的采样率为基准（并列时取先出现的），其余文件逐一点名
      let baseline = present[0].rate;
      let best = 0;
      for (const [rate, count] of counts) {
        if (count > best) {
          best = count;
          baseline = rate;
        }
      }
      const grouped = new Map();
      for (const item of present) {
        if (!grouped.has(item.rate)) grouped.set(item.rate, []);
        grouped.get(item.rate).push(item.label);
      }
      const parts = [...grouped.entries()].map(
        ([rate, labels]) => `${rateLabel(rate)} → ${labels.join('、')}`,
      );
      const bad = present.filter((item) => item.rate !== baseline);
      addError(
        '采样率',
        `各文件采样率必须一致：${parts.join('；')}。不一致的文件：` +
          bad.map((item) => `${item.label} 为 ${rateLabel(item.rate)}`).join('、') +
          `，其余为 ${rateLabel(baseline)}。`,
      );
    } else {
      sampleRate = present[0].rate;
      if (!SUPPORTED_RATES.includes(sampleRate)) {
        addError(
          '采样率',
          `${rateLabel(sampleRate)} 不受支持，仅支持 44.1 kHz 与 48 kHz。`,
        );
      }
    }
  }

  if (dry) {
    const p = dry.parsed;
    if (p.channels !== 2) {
      addError(dry.name, `干声必须是双声道（当前 ${p.channels} 声道）`);
    }
    if (p.duration > MAX_DRY_SECONDS) {
      addError(
        dry.name,
        `干声时长 ${formatDuration(p.frames, p.sampleRate)}（${p.frames.toLocaleString('en-US')} 帧），超过 60 秒上限`,
      );
    }
  }

  irEntries.forEach((entry) => {
    if (!entry) return;
    const p = entry.parsed;
    if (p.channels !== 1) {
      addError(entry.name, `IR 必须是单声道（当前 ${p.channels} 声道）`);
    }
    if (p.duration > MAX_IR_SECONDS) {
      addError(
        entry.name,
        `IR 时长 ${formatDuration(p.frames, p.sampleRate)}（${p.frames.toLocaleString('en-US')} 帧），超过 4 秒上限`,
      );
    }
  });

  if (errors.length) {
    return {
      ok: false,
      errors,
      sampleRate: null,
      dryFrames: 0,
      maxIrFrames: 0,
      dry: null,
      irs: null,
      details: {},
    };
  }

  const dryFrames = dry ? dry.parsed.frames : 0;
  const dryL = dry ? dry.parsed.data[0] : new Float64Array(0);
  const dryR = dry ? dry.parsed.data[1] : new Float64Array(0);
  const irs = irEntries.map((entry) => entry.parsed.data[0]);
  const maxIrFrames = irs.reduce((m, ir) => Math.max(m, ir.length), 0);

  const details = {
    dry: dry
      ? {
          present: true,
          name: dry.name,
          frames: dry.parsed.frames,
          sampleRate: dry.parsed.sampleRate,
          duration: dry.parsed.duration,
          bits: dry.parsed.bitsPerSample,
          channels: dry.parsed.channels,
          peak: dry.parsed.peak,
        }
      : { present: false, frames: 0, duration: 0, peak: 0 },
    irs: ROUTES.map((route, i) => ({
      route,
      name: irEntries[i].name,
      frames: irs[i].length,
      duration: irs[i].length / sampleRate,
      bits: irEntries[i].parsed.bitsPerSample,
      peak: irEntries[i].parsed.peak,
      energy: sumSquares(irs[i]),
    })),
  };

  return {
    ok: true,
    errors: [],
    sampleRate,
    dryFrames,
    maxIrFrames,
    dry: { left: dryL, right: dryR },
    irs,
    details,
  };
}

function sumSquares(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return sum;
}

/** 固定输出长度：干声 + 最长 IR - 1 + 预延迟（帧）。 */
export function fixedLength({ dryFrames, maxIrFrames, predelayFrames }) {
  return dryFrames + maxIrFrames - 1 + predelayFrames;
}

/** 尾长：输出中超出干声的部分（最长 IR - 1 + 预延迟）。 */
export function tailLength({ maxIrFrames, predelayFrames }) {
  return maxIrFrames - 1 + predelayFrames;
}

export function maxPredelayFrames(sampleRate) {
  return Math.floor((MAX_PREDELAY_MS / 1000) * sampleRate);
}

export function toMs(frames, sampleRate) {
  return sampleRate ? (frames / sampleRate) * 1000 : 0;
}

export function formatDb(value) {
  if (!(value > 0)) return '−∞ dB';
  return `${(20 * Math.log10(value)).toFixed(1)} dB`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  }
  return `${seconds.toFixed(3)} s`;
}
