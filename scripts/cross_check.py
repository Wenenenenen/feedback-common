#!/usr/bin/env python3
"""双向交叉验证：
1) Python 参考解码器解析 JS 产出的每个 .g53，逐像素比对原始 .u8
2) 逐记录解压 JS / Python 流的位平面负载，做字节级比较
   （zlib 压缩输出允许不同，解压后的原始负载必须一致）
"""
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from g53_reference import decode_full  # noqa: E402

ROOT = '/home/wendy/jianzhi/feedback-tasks/lifting-progressive-stream/work'


def split_records(stream):
    magic, w, h, levels, hb = struct.unpack('<4sIIBB', stream[:14])
    assert magic == b'G53A'
    recs = []
    pos = 14
    if hb != 255:
        while pos < len(stream):
            bit, raw_len, comp_len, crc = struct.unpack(
                '<BIII', stream[pos:pos + 13])
            pos += 13
            raw = zlib.decompress(stream[pos:pos + comp_len])
            pos += comp_len
            assert len(raw) == raw_len
            assert zlib.crc32(raw) & 0xffffffff == crc
            recs.append((bit, raw))
    return (w, h, levels, hb), recs


def main():
    fails = 0
    for fn in sorted(os.listdir(os.path.join(ROOT, 'js-out'))):
        if not fn.endswith('.g53'):
            continue
        base = fn[:-4]
        js = open(os.path.join(ROOT, 'js-out', fn), 'rb').read()
        py = open(os.path.join(ROOT, 'reference', fn), 'rb').read()
        raw = open(os.path.join(ROOT, 'reference', base + '.u8'), 'rb').read()

        # 1) Python 解码 JS 流
        back = decode_full(js)
        ok1 = back == list(raw)
        # 2) 头部一致
        ok2 = js[:14] == py[:14]
        # 3) 解压后位平面负载逐字节一致
        hdr_j, recs_j = split_records(js)
        hdr_p, recs_p = split_records(py)
        ok3 = ([b for b, _ in recs_j] == [b for b, _ in recs_p] and
               all(rj == rp for (_, rj), (_, rp) in zip(recs_j, recs_p)))
        status = 'OK' if (ok1 and ok2 and ok3) else 'FAIL'
        if status == 'FAIL':
            fails += 1
        print(f'{status} {fn}: py-decodes-js={ok1} header={ok2} '
              f'payloads-identical={ok3} (records js={len(recs_j)} py={len(recs_p)})')
    print('交叉验证完成，失败数 =', fails)
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
