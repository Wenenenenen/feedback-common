/**
 * 顺序取帧游标。
 *
 * 预览与导出都需要“给定源内时刻，拿到该时刻应显示的帧”。
 * 逐帧随机 seek 会反复重建解码器，代价极高；这里改为一次性打开某个片段的
 * 顺序解码流，按时间单调推进，只在回退或跨界时重建。
 */
import { CanvasSink, type InputVideoTrack, type WrappedCanvas } from 'mediabunny';

/** 播放方向回退超过该阈值（秒）时重建解码流 */
const RESET_THRESHOLD = 0.03;

/** 单个片段的顺序取帧游标 */
export class ClipCursor {
  private sink: CanvasSink;
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private current: WrappedCanvas | null = null;
  private lookahead: WrappedCanvas | null = null;
  private exhausted = false;
  private lastTarget = -Infinity;
  private readonly track: InputVideoTrack;
  private readonly start: number;
  private readonly end: number;
  private readonly width: number;
  private readonly height: number;
  private readonly poolSize: number;

  constructor(
    track: InputVideoTrack,
    start: number,
    end: number,
    width: number,
    height: number,
    poolSize: number,
  ) {
    this.track = track;
    this.start = start;
    this.end = end;
    this.width = width;
    this.height = height;
    this.poolSize = poolSize;
    this.sink = this.createSink();
  }

  private createSink(): CanvasSink {
    // 宽高同时给定时必须指定 fit；contain 可保留原始宽高比，多余区域填黑
    return new CanvasSink(this.track, {
      width: this.width,
      height: this.height,
      fit: 'contain',
      poolSize: this.poolSize,
    });
  }

  private reset(): void {
    this.current = null;
    this.lookahead = null;
    this.exhausted = false;
    this.iterator = null;
    this.sink = this.createSink();
  }

  private async pull(): Promise<WrappedCanvas | null> {
    if (!this.iterator) {
      this.iterator = this.sink.canvases(this.start, this.end);
    }
    if (this.exhausted) {
      return null;
    }
    const result = await this.iterator.next();
    if (result.done) {
      this.exhausted = true;
      return null;
    }
    return result.value;
  }

  /**
   * 取源内 time 时刻应显示的帧。
   * 若该时刻尚无帧可用（例如超出片段范围），返回 null。
   */
  async frameAt(time: number): Promise<WrappedCanvas | null> {
    if (time < this.lastTarget - RESET_THRESHOLD) {
      // 往回跳：重建解码流，从头开始解到目标时刻
      this.reset();
    }
    this.lastTarget = time;

    if (!this.current) {
      this.current = await this.pull();
    }
    if (!this.lookahead) {
      this.lookahead = await this.pull();
    }
    // 只要下一帧的时间戳不超过目标，就继续推进
    while (this.lookahead && this.lookahead.timestamp <= time + 1e-6) {
      this.current = this.lookahead;
      this.lookahead = await this.pull();
    }
    return this.current;
  }

  /** 释放迭代器（画布池由 sink 自行管理） */
  dispose(): void {
    void this.iterator?.return();
    this.iterator = null;
    this.current = null;
    this.lookahead = null;
  }
}

/** 一组按片段 id 管理的游标池 */
export interface CursorPoolOptions {
  width: number;
  height: number;
  /** 画布池大小，预览用 4 即可，导出可更小 */
  poolSize: number;
}

export class CursorPool {
  private cursors = new Map<string, ClipCursor>();
  private readonly getTrack: (assetId: string) => InputVideoTrack | null;
  private readonly options: CursorPoolOptions;

  constructor(getTrack: (assetId: string) => InputVideoTrack | null, options: CursorPoolOptions) {
    this.getTrack = getTrack;
    this.options = options;
  }

  /** 取某片段在时间轴某时刻的帧 */
  async frameAt(assetId: string, clipId: string, sourceIn: number, sourceOut: number, sourceTime: number) {
    let cursor = this.cursors.get(clipId);
    if (!cursor) {
      const track = this.getTrack(assetId);
      if (!track) {
        return null;
      }
      cursor = new ClipCursor(
        track,
        sourceIn,
        sourceOut,
        this.options.width,
        this.options.height,
        this.options.poolSize,
      );
      this.cursors.set(clipId, cursor);
    }
    return cursor.frameAt(sourceTime);
  }

  /** 丢弃不再活动的片段游标，限制内存占用 */
  prune(activeClipIds: Set<string>): void {
    for (const [clipId, cursor] of this.cursors) {
      if (!activeClipIds.has(clipId)) {
        cursor.dispose();
        this.cursors.delete(clipId);
      }
    }
  }

  dispose(): void {
    for (const cursor of this.cursors.values()) {
      cursor.dispose();
    }
    this.cursors.clear();
  }
}
