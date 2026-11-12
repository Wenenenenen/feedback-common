/**
 * SRT 解析测试：覆盖真实素材里的各种写法与异常输入。
 */
import { describe, expect, it } from 'vitest';
import { parseSrt, stringifySrt } from './srt';

describe('parseSrt', () => {
  it('解析标准 SRT 块', () => {
    const cues = parseSrt(`1
00:00:01,000 --> 00:00:04,200
这片雪原，我已经走了很多天

2
00:00:05,000 --> 00:00:08,600
他们说，往北走就能找到它
`);
    expect(cues).toHaveLength(2);
    expect(cues[0].start).toBeCloseTo(1, 6);
    expect(cues[0].end).toBeCloseTo(4.2, 6);
    expect(cues[0].text).toBe('这片雪原，我已经走了很多天');
  });

  it('兼容 CRLF、BOM 与毫秒位数不齐的时间戳', () => {
    const cues = parseSrt('﻿1\r\n00:00:01,5 --> 00:00:03,25\r\n多行字幕\r\n第二行\r\n');
    expect(cues).toHaveLength(1);
    expect(cues[0].start).toBeCloseTo(1.5, 6);
    expect(cues[0].end).toBeCloseTo(3.25, 6);
    expect(cues[0].text).toBe('多行字幕\n第二行');
  });

  it('支持小时位与点号毫秒分隔符', () => {
    const cues = parseSrt(`1
01:02:03.400 --> 01:02:05.500
支持时:分:秒.毫秒
`);
    expect(cues[0].start).toBeCloseTo(3723.4, 6);
  });

  it('跳过序号缺失但结构完整的块', () => {
    const cues = parseSrt(`00:00:02,000 --> 00:00:03,000
没有序号
`);
    expect(cues).toHaveLength(1);
  });

  it('忽略结束时间早于开始时间的坏块', () => {
    const cues = parseSrt(`1
00:00:05,000 --> 00:00:03,000
时间倒挂
`);
    expect(cues).toHaveLength(0);
  });

  it('忽略空文本块', () => {
    const cues = parseSrt(`1
00:00:01,000 --> 00:00:02,000


`);
    expect(cues).toHaveLength(0);
  });

  it('按时间排序输出', () => {
    const cues = parseSrt(`2
00:00:05,000 --> 00:00:06,000
后一条

1
00:00:01,000 --> 00:00:02,000
前一条
`);
    expect(cues[0].text).toBe('前一条');
  });
});

describe('stringifySrt', () => {
  it('往返解析结果一致', () => {
    const cues = parseSrt(`1
00:00:01,000 --> 00:00:04,200
这片雪原，我已经走了很多天
`);
    const text = stringifySrt(cues);
    const roundTrip = parseSrt(text);
    expect(roundTrip).toHaveLength(1);
    expect(roundTrip[0].start).toBeCloseTo(cues[0].start, 3);
    expect(roundTrip[0].text).toBe(cues[0].text);
  });
});
