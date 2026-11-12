/**
 * 画面合成：把时间轴某一时刻的画面画到 canvas 上。
 * 预览和导出共用同一套合成逻辑，保证“看到什么就导出什么”。
 */
import { activeClipsAt, overlapAt, sourceTimeAt, type ClipLayout, type TimelineLayout } from './timeline';
import { dipIn, dipOut } from './envelope';

/** 绘制依赖：给定片段与时间轴采样点，返回该处应显示的画面 */
export type FrameProvider = (item: ClipLayout, sample: number) => Promise<CanvasImageSource | null>;

/** 字幕绘制参数 */
export interface SubtitleStyle {
  /** 字号相对画面高度的比例 */
  fontSizeRatio: number;
  /** 底部留白相对高度的比例 */
  bottomMarginRatio: number;
  /** 最多占画面宽度的比例 */
  maxWidthRatio: number;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSizeRatio: 0.045,
  bottomMarginRatio: 0.06,
  maxWidthRatio: 0.86,
};

/** 把一段文本按像素宽度折行（中文按字符切分，英文按空格优先） */
export function wrapText(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let current = '';
    for (const char of Array.from(line)) {
      const candidate = current + char;
      if (context.measureText(candidate).width > maxWidth && current.length > 0) {
        lines.push(current.trim());
        current = char;
      } else {
        current = candidate;
      }
    }
    if (current.trim().length > 0) {
      lines.push(current.trim());
    }
  }
  return lines;
}

/** 绘制字幕（带半透明底框，确保任何画面上都可读） */
export function drawSubtitle(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  style: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
): void {
  const fontSize = Math.max(12, Math.round(height * style.fontSizeRatio));
  const lineHeight = fontSize * 1.35;
  const maxWidth = width * style.maxWidthRatio;
  const bottomMargin = height * style.bottomMarginRatio;

  context.save();
  context.font = `600 ${fontSize}px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';

  const lines = wrapText(context, text, maxWidth);
  if (lines.length === 0) {
    context.restore();
    return;
  }

  const padX = fontSize * 0.5;
  const padY = fontSize * 0.3;
  let widest = 0;
  for (const line of lines) {
    widest = Math.max(widest, context.measureText(line).width);
  }

  const boxWidth = widest + padX * 2;
  const boxHeight = lines.length * lineHeight + padY * 2;
  const boxLeft = (width - boxWidth) / 2;
  const boxTop = height - bottomMargin - boxHeight;

  // 圆角底框
  const radius = Math.min(boxHeight / 2, fontSize * 0.5);
  context.fillStyle = 'rgba(0, 0, 0, 0.62)';
  context.beginPath();
  context.moveTo(boxLeft + radius, boxTop);
  context.lineTo(boxLeft + boxWidth - radius, boxTop);
  context.quadraticCurveTo(boxLeft + boxWidth, boxTop, boxLeft + boxWidth, boxTop + radius);
  context.lineTo(boxLeft + boxWidth, boxTop + boxHeight - radius);
  context.quadraticCurveTo(boxLeft + boxWidth, boxTop + boxHeight, boxLeft + boxWidth - radius, boxTop + boxHeight);
  context.lineTo(boxLeft + radius, boxTop + boxHeight);
  context.quadraticCurveTo(boxLeft, boxTop + boxHeight, boxLeft, boxTop + boxHeight - radius);
  context.lineTo(boxLeft, boxTop + radius);
  context.quadraticCurveTo(boxLeft, boxTop, boxLeft + radius, boxTop);
  context.closePath();
  context.fill();

  // 文字
  context.fillStyle = '#ffffff';
  context.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  context.lineWidth = Math.max(1, fontSize * 0.045);
  for (let i = 0; i < lines.length; i++) {
    const baseline = boxTop + padY + fontSize + i * lineHeight;
    context.strokeText(lines[i], width / 2, baseline);
    context.fillText(lines[i], width / 2, baseline);
  }

  context.restore();
}

/** 合成参数 */
export interface CompositeOptions {
  width: number;
  height: number;
  layout: TimelineLayout;
  /** 当前时间轴采样点 */
  sample: number;
  provider: FrameProvider;
  /** 该时刻应显示的字幕文本 */
  subtitle: string | null;
}

/**
 * 把时间轴某采样点的画面合成到 context 上。
 * 单段直接绘制；转场重叠区内按转场类型混合两段。
 */
export async function compositeFrame(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  options: CompositeOptions,
): Promise<void> {
  const { width, height, layout, sample, provider, subtitle } = options;

  context.save();
  // 先铺黑底，既是视频背景，也是转场中间露出的一层
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);

  const active = activeClipsAt(layout, sample);
  const overlap = overlapAt(layout, sample);

  if (active.length > 0 && !overlap) {
    // 普通单段
    const frame = await provider(active[0], sample);
    if (frame) {
      context.globalAlpha = 1;
      context.drawImage(frame as CanvasImageSource, 0, 0, width, height);
    }
  } else if (overlap) {
    const { outgoing, incoming, progress } = overlap;
    const type = outgoing.clip.transitionOut.type;
    const outgoingTime = Math.min(
      sourceTimeAt(outgoing, sample),
      outgoing.clip.sourceOut - 1e-4,
    );
    const incomingTime = sourceTimeAt(incoming, sample);

    if (type === 'dipToBlack') {
      // 先画出场（透明度递减），再压一层黑色，最后画入场（透明度递增）
      const outAlpha = dipOut(progress);
      const frameOut = await provider(outgoing, outgoingTime);
      if (frameOut && outAlpha > 0.001) {
        context.globalAlpha = outAlpha;
        context.drawImage(frameOut as CanvasImageSource, 0, 0, width, height);
      }
      // 中间的黑场强度：进度 0.5 处最黑
      const blackAlpha = Math.min(1, Math.max(0, 1 - Math.abs(progress - 0.5) * 2));
      if (blackAlpha > 0) {
        context.globalAlpha = blackAlpha;
        context.fillStyle = '#000000';
        context.fillRect(0, 0, width, height);
      }
      const inAlpha = dipIn(progress);
      const frameIn = await provider(incoming, incomingTime);
      if (frameIn && inAlpha > 0.001) {
        context.globalAlpha = Math.min(1, inAlpha);
        context.drawImage(frameIn as CanvasImageSource, 0, 0, width, height);
      }
    } else {
      // 叠化：等价于等功率交叉淡化
      const frameOut = await provider(outgoing, outgoingTime);
      const frameIn = await provider(incoming, incomingTime);
      if (frameOut) {
        context.globalAlpha = Math.cos(progress * Math.PI / 2);
        context.drawImage(frameOut as CanvasImageSource, 0, 0, width, height);
      }
      if (frameIn) {
        context.globalAlpha = Math.sin(progress * Math.PI / 2);
        context.drawImage(frameIn as CanvasImageSource, 0, 0, width, height);
      }
    }
  } else if (active.length > 0) {
    // 极端情况下多于两段重叠：按顺序叠画，后画的在上
    context.globalAlpha = 1;
    for (const item of active) {
      const frame = await provider(item, sample);
      if (frame) {
        context.drawImage(frame as CanvasImageSource, 0, 0, width, height);
      }
    }
  }

  context.globalAlpha = 1;
  if (subtitle) {
    drawSubtitle(context, width, height, subtitle);
  }
  context.restore();
}
