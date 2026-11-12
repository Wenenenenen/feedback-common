/**
 * 时间显示与像素换算工具。
 */

/** 秒 → mm:ss 或 hh:mm:ss（显示到帧级） */
export function formatTimecode(seconds: number, fps = 24): string {
  const safe = Math.max(0, seconds);
  const totalFrames = Math.round(safe * fps);
  const frames = totalFrames % Math.round(fps);
  const totalSeconds = Math.floor(totalFrames / Math.round(fps));
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const frameText = String(frames).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${frameText}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${frameText}`;
}

/** 秒 → 简短时长文本（如 1:23） */
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, seconds);
  const totalSeconds = Math.round(safe);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** 字节数 → 人类可读体积 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
