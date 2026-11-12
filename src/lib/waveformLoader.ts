/**
 * 波形加载封装。
 *
 * 把“从素材句柄算波形”这件事和界面解耦：界面只需调用 buildWaveform，
 * 拿到峰值后写缓存即可。算波形可能耗时数秒，因此放在后台执行，不阻塞导入。
 */
import { computeWaveform } from './waveform';
import type { AssetHandle } from './media';

/** 计算某素材的波形峰值；无音轨返回 null */
export async function buildWaveform(handle: AssetHandle): Promise<{ min: Float32Array; max: Float32Array } | null> {
  if (!handle.audioTrack) {
    return null;
  }
  return computeWaveform(handle.audioTrack, handle.info.duration);
}

export { setWaveform, getWaveform, getAssetHandle } from '../store';
