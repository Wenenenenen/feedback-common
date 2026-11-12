/**
 * SRT 字幕解析。
 * 支持 BOM、CRLF、多行文本、可缺省序号，以及逗号/点号毫秒分隔符。
 */
import type { Cue } from '../types';

const TIME_PATTERN = /(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

/** 解析时间戳行为秒 */
function parseTimestamp(text: string): number | null {
  const match = TIME_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  // 补齐毫秒位数，兼容 “1” “12” “123” 三种写法
  const millis = Number(match[4].padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/**
 * 解析 SRT 文本为字幕数组。
 * 遇到结构不完整的块会跳过，不影响其余字幕。
 */
export function parseSrt(input: string): Cue[] {
  // 去 BOM，统一换行
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 2) {
      continue;
    }

    // 找到时间戳行（可能是第 1 行，也可能前面有纯数字序号）
    let timeLineIndex = -1;
    for (let i = 0; i < Math.min(lines.length, 2); i++) {
      if (lines[i].includes('-->')) {
        timeLineIndex = i;
        break;
      }
    }
    if (timeLineIndex === -1) {
      continue;
    }

    const [startText, endText] = lines[timeLineIndex].split('-->');
    if (startText === undefined || endText === undefined) {
      continue;
    }
    const start = parseTimestamp(startText);
    const end = parseTimestamp(endText);
    if (start === null || end === null || end <= start) {
      continue;
    }

    const cueText = lines
      .slice(timeLineIndex + 1)
      .join('\n')
      .trim();
    if (!cueText) {
      continue;
    }

    cues.push({ start, end, text: cueText });
  }

  // 按时间排序，保证投影到时间轴时顺序稳定
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** 生成 SRT 文本（导出用，暂存于字幕编辑场景） */
export function stringifySrt(cues: Cue[]): string {
  const format = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const secs = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
  };
  return cues.map((cue, index) => `${index + 1}\n${format(cue.start)} --> ${format(cue.end)}\n${cue.text}\n`).join('\n');
}
