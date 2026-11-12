/**
 * 缩略图服务：按需生成，带 LRU 缓存与批量解码。
 *
 * 为避免一次性解码整段十分钟视频，缩略图按时间桶（默认 1.5 秒一格）惰性生成：
 * 界面需要时登记请求，服务把同一素材的请求合并成一批，用 canvasesAtTimestamps 顺序解码，
 * 每次只解码真正要显示的那几帧。
 *
 * 字幕投影依赖素材使用关系；但缩略图与字幕无关，只与素材的视频轨有关。
 */
import { CanvasSink, type InputVideoTrack } from 'mediabunny';

/** 缩略图尺寸 */
const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 90;
/** 时间桶宽度（秒） */
const BUCKET_SECONDS = 1.5;
/** LRU 上限，防止长时间浏览撑大内存 */
const MAX_CACHE_ENTRIES = 600;

/** 把 OffscreenCanvas / HTMLCanvasElement 转成对象 URL */
async function canvasToObjectUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string | null> {
  try {
    if ('convertToBlob' in canvas) {
      const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.72 });
      return URL.createObjectURL(blob);
    }
    const htmlCanvas = canvas as HTMLCanvasElement;
    const blob = await new Promise<Blob | null>((resolve) =>
      htmlCanvas.toBlob((result) => resolve(result), 'image/jpeg', 0.72),
    );
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

export class ThumbnailService {
  private sinks = new Map<string, CanvasSink>();
  private cache = new Map<string, string>();
  /** 正在生成中的键，避免重复排队 */
  private pending = new Set<string>();
  private queue = new Map<string, Set<number>>();
  private flushTimer: number | null = null;
  private disposed = false;
  private readonly onUpdate: (assetId: string, bucket: number, url: string) => void;
  private readonly getTrack: (assetId: string) => InputVideoTrack | null;

  constructor(
    onUpdate: (assetId: string, bucket: number, url: string) => void,
    getTrack: (assetId: string) => InputVideoTrack | null,
  ) {
    this.onUpdate = onUpdate;
    this.getTrack = getTrack;
  }

  /** 时间点所属的桶号 */
  bucketOf(time: number): number {
    return Math.max(0, Math.floor(time / BUCKET_SECONDS));
  }

  private keyOf(assetId: string, bucket: number): string {
    return `${assetId}:${bucket}`;
  }

  /** 已缓存的缩略图地址；未就绪返回 null 并登记生成 */
  get(assetId: string, time: number): string | null {
    const bucket = this.bucketOf(time);
    const key = this.keyOf(assetId, bucket);
    const cached = this.cache.get(key);
    if (cached) {
      // 触碰一次，维持 LRU 顺序
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    if (!this.pending.has(key)) {
      this.enqueue(assetId, bucket);
    }
    return null;
  }

  private enqueue(assetId: string, bucket: number): void {
    let set = this.queue.get(assetId);
    if (!set) {
      set = new Set();
      this.queue.set(assetId, set);
    }
    set.add(bucket);
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => void this.flush(), 100);
    }
  }

  private sinkFor(assetId: string, track: InputVideoTrack): CanvasSink {
    let sink = this.sinks.get(assetId);
    if (!sink) {
      sink = new CanvasSink(track, {
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT,
        fit: 'contain',
        poolSize: 1,
      });
      this.sinks.set(assetId, sink);
    }
    return sink;
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.disposed) {
      return;
    }
    const batches = [...this.queue.entries()];
    this.queue.clear();
    let retry = false;

    for (const [assetId, buckets] of batches) {
      const track = this.getTrack(assetId);
      if (!track) {
        // 素材还没解析完：保留请求，稍后再试
        for (const bucket of buckets) {
          this.enqueue(assetId, bucket);
        }
        retry = true;
        continue;
      }
      const targets = [...buckets].sort((a, b) => a - b).filter((bucket) => {
        const key = this.keyOf(assetId, bucket);
        return !this.cache.has(key) && !this.pending.has(key);
      });
      if (targets.length === 0) {
        continue;
      }
      for (const bucket of targets) {
        this.pending.add(this.keyOf(assetId, bucket));
      }
      void this.renderBatch(assetId, track, targets);
    }

    if (retry && this.flushTimer === null && !this.disposed) {
      this.flushTimer = window.setTimeout(() => void this.flush(), 250);
    }
  }

  private async renderBatch(assetId: string, track: InputVideoTrack, buckets: number[]): Promise<void> {
    const sink = this.sinkFor(assetId, track);
    // 取每一桶的中间时刻，避开片段边界
    const timestamps = buckets.map((bucket) => bucket * BUCKET_SECONDS + BUCKET_SECONDS / 2);
    try {
      const iterator = sink.canvasesAtTimestamps(timestamps);
      let index = 0;
      for await (const wrapped of iterator) {
        if (this.disposed) {
          return;
        }
        const bucket = buckets[index];
        index += 1;
        if (!wrapped) {
          continue;
        }
        const url = await canvasToObjectUrl(wrapped.canvas);
        if (!url) {
          continue;
        }
        this.cache.set(this.keyOf(assetId, bucket), url);
        this.evictIfNeeded();
        this.onUpdate(assetId, bucket, url);
      }
    } catch {
      // 单批失败不影响其它缩略图
    } finally {
      for (const bucket of buckets) {
        this.pending.delete(this.keyOf(assetId, bucket));
      }
    }
  }

  private evictIfNeeded(): void {
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) {
        break;
      }
      const url = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const url of this.cache.values()) {
      URL.revokeObjectURL(url);
    }
    this.cache.clear();
    this.sinks.clear();
    this.queue.clear();
    this.pending.clear();
  }
}

/** 每秒钟包含的波形桶数 */
export const WAVEFORM_BUCKETS_PER_SECOND = 50;
