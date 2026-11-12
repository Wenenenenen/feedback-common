/**
 * 运行时单例：跨组件共享的缩略图服务、预览引擎与轨道查找。
 *
 * 这些对象生命周期长、体积大，放在模块级而不是 React 状态里，
 * 避免重渲染时被比较或复制。
 */
import type { InputAudioTrack, InputVideoTrack } from 'mediabunny';
import { ThumbnailService } from './lib/thumbnails';
import type { PreviewEngine } from './lib/previewEngine';
import { getAssetHandle } from './store';

/** 缩略图生成完成后的重绘订阅 */
const thumbSubscribers = new Set<() => void>();
/** 缩略图服务版本号，供 useSyncExternalStore 使用 */
let thumbVersion = 0;

/** 取素材视频轨（素材加载后即可用） */
export function getVideoTrack(assetId: string): InputVideoTrack | null {
  return getAssetHandle(assetId)?.videoTrack ?? null;
}

/** 取素材音频轨 */
export function getAudioTrack(assetId: string): InputAudioTrack | null {
  return getAssetHandle(assetId)?.audioTrack ?? null;
}

export const thumbnails = new ThumbnailService(() => {
  thumbVersion += 1;
  for (const notify of thumbSubscribers) {
    notify();
  }
}, getVideoTrack);

export function subscribeThumbnails(listener: () => void): () => void {
  thumbSubscribers.add(listener);
  return () => {
    thumbSubscribers.delete(listener);
  };
}

export function getThumbVersion(): number {
  return thumbVersion;
}

/** 预览引擎持有者（由 PreviewPanel 注册） */
export const previewHolder: { engine: PreviewEngine | null } = { engine: null };
