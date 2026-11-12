/**
 * 开发环境测试钩子。
 *
 * 自动化脚本需要驱动「界面正在使用的那个模块实例」来改状态，
 * 但 Vite 的 HMR 会让静态导入与脚本里的动态导入落在不同实例上。
 * 因此在这里把真实实例挂到 window，脚本只通过它操作，避免模块双实例问题。
 *
 * 该文件只在开发构建中被引入，不影响生产产物。
 */
import { useEditorStore, getAssetHandle, getWaveform, setWaveform } from './store';
import { thumbnails, previewHolder, getVideoTrack, getAudioTrack } from './runtime';
import { buildLayout } from './lib/timeline';
import { projectCues } from './lib/subtitles';
import { buildWaveform } from './lib/waveformLoader';
import { loadAsset } from './lib/media';
import { parseSrt } from './lib/srt';
import { splitClip } from './lib/edits';
import { CursorPool } from './lib/frameCursor';
import { exportTimeline, exportTimelineToBuffer } from './lib/exporter';

export interface ClipCutTestApi {
  store: typeof useEditorStore;
  getAssetHandle: typeof getAssetHandle;
  getWaveform: typeof getWaveform;
  setWaveform: typeof setWaveform;
  thumbnails: typeof thumbnails;
  previewHolder: typeof previewHolder;
  getVideoTrack: typeof getVideoTrack;
  getAudioTrack: typeof getAudioTrack;
  buildLayout: typeof buildLayout;
  projectCues: typeof projectCues;
  buildWaveform: typeof buildWaveform;
  loadAsset: typeof loadAsset;
  parseSrt: typeof parseSrt;
  splitClip: typeof splitClip;
  CursorPool: typeof CursorPool;
  exportTimeline: typeof exportTimeline;
  exportTimelineToBuffer: typeof exportTimelineToBuffer;
}

declare global {
  interface Window {
    __clipcut?: ClipCutTestApi;
  }
}

window.__clipcut = {
  store: useEditorStore,
  getAssetHandle,
  getWaveform,
  setWaveform,
  thumbnails,
  previewHolder,
  getVideoTrack,
  getAudioTrack,
  buildLayout,
  projectCues,
  buildWaveform,
  loadAsset,
  parseSrt,
  splitClip,
  CursorPool,
  exportTimeline,
  exportTimelineToBuffer,
};
