/** 共享类型与数值常量。 */

/** 解码后的单声道 WAV 片段。浮点样本 = 有符号 PCM 整数 / 2^(位深-1)。 */
export interface AudioClip {
  readonly name: string;
  readonly sampleRate: number;
  readonly bitDepth: 16 | 24;
  readonly numFrames: number;
  readonly samples: Float64Array;
  /** 原始有符号 PCM 整数（用于逐位一致的校验与展示）。 */
  readonly pcm: Int32Array;
  readonly bytes: Uint8Array;
  /** 原始文件字节摘要，检查点据此确认“同一份输入”。 */
  readonly digest: string;
}

/** 检查点与报告中使用的输入元数据。 */
export interface ClipMeta {
  name: string;
  sampleRate: number;
  bitDepth: 16 | 24;
  numFrames: number;
  digest: string;
}

/** 滤波器参数。 */
export interface NlmsParams {
  /** 参考信号延迟帧数，0..2048。 */
  delay: number;
  /** 抽头数：普通模式 32..256，tiny 核对模式允许 2。 */
  taps: number;
  /** 步长 μ，0..1。 */
  mu: number;
  /** 泄漏系数，0..0.01。 */
  leak: number;
}

/** 冻结学习区间，整数帧，[start, end)，重叠取并集。 */
export interface FreezeRange {
  start: number;
  end: number;
}

export interface NlmsConfig extends NlmsParams {
  freeze: FreezeRange[];
  /** tiny 核对模式：允许 2 抽头的短滤波器。 */
  tiny: boolean;
}

/** 包内约定的固定数值。 */
export const NLMS_CONSTANTS = {
  epsilon: 1e-8,
  gate: 1e-7,
  maxDelay: 2048,
  minTaps: 32,
  maxTaps: 256,
  tinyMinTaps: 2,
  maxLeak: 0.01,
  maxSeconds: 15,
  /** 24 位 WAV 输出允许的最大正值 1 - 2^-23。 */
  clipMax: 1 - Math.pow(2, -23),
  /** 24 位整数满量程。 */
  pcm24Scale: 8388608,
} as const;

/** 一个区间的能量统计；区间内已处理帧数为 0 时各统计为 null。 */
export interface IntervalEnergy {
  start: number;
  end: number;
  /** 区间内已处理的帧数。 */
  frames: number;
  /** 区间总长（帧）。 */
  totalFrames: number;
  /** 区间是否全部处理完毕。 */
  complete: boolean;
  /** 估计回声 y 的均方值。 */
  echo: number | null;
  /** 麦克风 d 的均方值。 */
  microphone: number | null;
  /** 残差 e 的均方值。 */
  residual: number | null;
  /** 10·log10(ms(d)/ms(e))；不可算时为 null，e 为 0 而 d 非 0 时为 Infinity。 */
  erleDb: number | null;
}

/** tiny-expected.json 的结构。 */
export interface TinyExpected {
  echo: number[];
  residual: number[];
  h: number[];
}

/** 与 tiny 样例逐位核对的结果。 */
export interface TinyCheck {
  passed: boolean;
  /** 所有数值是否逐位相等。 */
  exact: boolean;
  maxEchoError: number;
  maxResidualError: number;
  maxTapError: number;
  frames: number;
  taps: number;
}

/** main.json 中的真实回声路径，每个阶段是一组 [抽头下标, 增益]。 */
export interface TruthIr {
  stages: Array<Array<{ index: number; gain: number }>>;
}

/** 从样例 JSON 解析出的配置。 */
export interface SampleConfig extends NlmsParams {
  freeze: FreezeRange[];
  tiny: boolean;
  truthIr: TruthIr | null;
  expected: TinyExpected | null;
}

export function clipMeta(clip: AudioClip): ClipMeta {
  return {
    name: clip.name,
    sampleRate: clip.sampleRate,
    bitDepth: clip.bitDepth,
    numFrames: clip.numFrames,
    digest: clip.digest,
  };
}
