/**
 * 工程核心数据类型。
 *
 * 时间轴采用“采样域”作为唯一权威单位（48kHz），避免浮点秒数在多次剪辑后累积漂移。
 */

/** 转场类型 */
export type TransitionType = 'none' | 'crossfade' | 'dipToBlack';

/** 一段素材到下一段的转场 */
export interface Transition {
  type: TransitionType;
  /** 转场时长（秒），与前后两段素材重叠 */
  duration: number;
}

/** 时间轴上的一个片段（引用素材的入点/出点） */
export interface Clip {
  id: string;
  /** 引用的素材 id */
  assetId: string;
  /** 源内入点（秒） */
  sourceIn: number;
  /** 源内出点（秒） */
  sourceOut: number;
  /** 是否静音 */
  muted: boolean;
  /** 段首淡入时长（秒，仅音频） */
  fadeIn: number;
  /** 段尾淡出时长（秒，仅音频） */
  fadeOut: number;
  /** 到下一段的转场 */
  transitionOut: Transition;
}

/** 素材元信息（可序列化，不含解码对象） */
export interface AssetInfo {
  id: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  hasVideo: boolean;
  hasAudio: boolean;
  sampleRate: number;
  channels: number;
}

/** 单条字幕（时间为素材原始时间，秒） */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** 一份导入的字幕，绑定到某个素材 */
export interface SubtitleSet {
  assetId: string;
  name: string;
  cues: Cue[];
}

/** 导出设置 */
export interface ExportSettings {
  /** 目标宽度 */
  width: number;
  /** 目标高度 */
  height: number;
  /** 目标帧率；'source' 表示跟随素材 */
  fps: number | 'source';
  /** 视频码率（bps） */
  videoBitrate: number;
  /** 音频码率（bps） */
  audioBitrate: number;
  /** 导出范围：整条时间轴，或仅时间轴选区 */
  range: 'all' | 'selection';
}
