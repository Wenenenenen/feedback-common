/**
 * 全局编辑状态。
 *
 * 运行时对象（Input、轨道句柄、解码器、缩略图服务）放在模块级引用里，
 * 不进入 React 状态树，避免组件重渲染时被结构化克隆或误比较。
 */
import { create } from 'zustand';
import type { AssetInfo, Clip, ExportSettings, SubtitleSet } from './types';
import type { AssetHandle } from './lib/media';
import { nextId } from './lib/edits';

/** 波形峰值缓存类型 */
export interface WaveformData {
  min: Float32Array;
  max: Float32Array;
}

/** 运行时素材注册表（非响应式） */
const assetHandles = new Map<string, AssetHandle>();
const waveformCache = new Map<string, WaveformData>();

export function getAssetHandle(assetId: string): AssetHandle | undefined {
  return assetHandles.get(assetId);
}

export function getWaveform(assetId: string): WaveformData | undefined {
  return waveformCache.get(assetId);
}

export function setWaveform(assetId: string, peaks: WaveformData): void {
  waveformCache.set(assetId, peaks);
}

/** 导出设置默认值 */
const defaultExportSettings: ExportSettings = {
  width: 1920,
  height: 1080,
  fps: 'source',
  videoBitrate: 8_000_000,
  audioBitrate: 160_000,
  range: 'all',
};

interface EditorState {
  /** 素材元信息列表 */
  assets: Record<string, AssetInfo>;
  /** 时间轴片段 */
  clips: Clip[];
  /** 字幕集合 */
  subtitles: SubtitleSet[];
  /** 当前播放/定位位置（秒） */
  playhead: number;
  /** 时间轴缩放：每秒多少像素 */
  zoom: number;
  /** 选中的片段 id */
  selectedClipId: string | null;
  /** 导出设置 */
  exportSettings: ExportSettings;
  /** 正在加载的素材数（用于界面 loading 提示） */
  loadingCount: number;
  /** 提示消息 */
  toast: string | null;
  /** 波形数据版本号：波形异步算好后递增，驱动时间轴重绘 */
  waveformVersion: number;

  registerAsset: (handle: AssetHandle, waveform?: WaveformData) => void;
  removeAsset: (assetId: string) => void;
  addClipFromAsset: (assetId: string) => void;
  setClips: (clips: Clip[]) => void;
  updateClip: (clipId: string, patch: Partial<Clip>) => void;
  selectClip: (clipId: string | null) => void;
  setPlayhead: (time: number) => void;
  setZoom: (zoom: number) => void;
  addSubtitleSet: (set: SubtitleSet) => void;
  removeSubtitleSet: (assetId: string) => void;
  toggleSubtitleSet: (assetId: string) => void;
  setExportSettings: (patch: Partial<ExportSettings>) => void;
  setLoading: (count: number | ((current: number) => number)) => void;
  showToast: (message: string | null) => void;
  bumpWaveformVersion: () => void;
  resetProject: () => void;
}

/** 字幕是否启用（用 name 前缀标记，避免再增字段） */
const DISABLED_PREFIX = '[off] ';

export const useEditorStore = create<EditorState>((set, get) => ({
  assets: {},
  clips: [],
  subtitles: [],
  playhead: 0,
  zoom: 80,
  selectedClipId: null,
  exportSettings: defaultExportSettings,
  loadingCount: 0,
  toast: null,
  waveformVersion: 0,

  registerAsset: (handle, waveform) => {
    assetHandles.set(handle.info.id, handle);
    if (waveform) {
      waveformCache.set(handle.info.id, waveform);
    }
    set((state) => ({
      assets: { ...state.assets, [handle.info.id]: handle.info },
    }));
  },

  removeAsset: (assetId) => {
    const handle = assetHandles.get(assetId);
    if (handle) {
      handle.input.dispose();
      assetHandles.delete(assetId);
    }
    waveformCache.delete(assetId);
    set((state) => {
      const assets = { ...state.assets };
      delete assets[assetId];
      return {
        assets,
        clips: state.clips.filter((clip) => clip.assetId !== assetId),
        subtitles: state.subtitles.filter((subtitle) => subtitle.assetId !== assetId),
      };
    });
  },

  addClipFromAsset: (assetId) => {
    const asset = get().assets[assetId];
    if (!asset) {
      return;
    }
    const clip: Clip = {
      id: nextId(),
      assetId,
      sourceIn: 0,
      sourceOut: asset.duration,
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
      transitionOut: { type: 'none', duration: 0 },
    };
    set((state) => ({
      clips: [...state.clips, clip],
      selectedClipId: clip.id,
    }));
  },

  setClips: (clips) => {
    set((state) => ({
      clips,
      selectedClipId: clips.some((clip) => clip.id === state.selectedClipId)
        ? state.selectedClipId
        : null,
    }));
  },

  updateClip: (clipId, patch) => {
    set((state) => ({
      clips: state.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
    }));
  },

  selectClip: (clipId) => set({ selectedClipId: clipId }),
  setPlayhead: (time) => set({ playhead: time }),
  setZoom: (zoom) => set({ zoom: Math.max(8, Math.min(400, zoom)) }),

  addSubtitleSet: (subtitleSet) => {
    set((state) => ({
      subtitles: [
        ...state.subtitles.filter((existing) => existing.assetId !== subtitleSet.assetId),
        subtitleSet,
      ],
    }));
  },

  removeSubtitleSet: (assetId) => {
    set((state) => ({ subtitles: state.subtitles.filter((subtitle) => subtitle.assetId !== assetId) }));
  },

  toggleSubtitleSet: (assetId) => {
    set((state) => ({
      subtitles: state.subtitles.map((subtitle) => {
        if (subtitle.assetId !== assetId) {
          return subtitle;
        }
        const enabled = !subtitle.name.startsWith(DISABLED_PREFIX);
        return {
          ...subtitle,
          name: enabled ? `${DISABLED_PREFIX}${subtitle.name}` : subtitle.name.slice(DISABLED_PREFIX.length),
        };
      }),
    }));
  },

  setExportSettings: (patch) => {
    set((state) => ({ exportSettings: { ...state.exportSettings, ...patch } }));
  },

  setLoading: (count) =>
    set((state) => ({
      loadingCount: typeof count === 'function' ? count(state.loadingCount) : count,
    })),
  showToast: (message) => set({ toast: message }),
  bumpWaveformVersion: () => set((state) => ({ waveformVersion: state.waveformVersion + 1 })),

  resetProject: () => {
    for (const handle of assetHandles.values()) {
      handle.input.dispose();
    }
    assetHandles.clear();
    waveformCache.clear();
    set({
      assets: {},
      clips: [],
      subtitles: [],
      playhead: 0,
      selectedClipId: null,
    });
  },
}));


/** 某个字幕集是否启用 */
export function isSubtitleEnabled(subtitle: SubtitleSet): boolean {
  return !subtitle.name.startsWith(DISABLED_PREFIX);
}

/** 显示用名称（去掉内部标记） */
export function subtitleDisplayName(subtitle: SubtitleSet): string {
  return subtitle.name.startsWith(DISABLED_PREFIX)
    ? subtitle.name.slice(DISABLED_PREFIX.length)
    : subtitle.name;
}
