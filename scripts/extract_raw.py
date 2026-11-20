#!/usr/bin/env python3
"""把样例目录中的 8 位灰度 PNG 转成原始 .u8（纯头less灰度字节）。
用 -I 运行时通过 sys.path 显式加入 user site，避免从样例目录加载任何模块。"""
import os
import sys

sys.path.append('/home/wendy/.local/lib/python3.12/site-packages')
from PIL import Image  # noqa: E402

SRC = '/home/wendy/jianzhi/feedback-tasks/lifting-progressive-stream/work/samples-extract'
DST = '/home/wendy/jianzhi/feedback-tasks/lifting-progressive-stream/work/sample-raw'


def main():
    os.makedirs(DST, exist_ok=True)
    for fn in sorted(os.listdir(SRC)):
        if not fn.endswith('.png'):
            continue
        im = Image.open(os.path.join(SRC, fn)).convert('L')
        w, h = im.size
        data = im.tobytes()
        out = os.path.join(DST, fn.replace('.png', f'_{w}x{h}.u8'))
        with open(out, 'wb') as f:
            f.write(data)
        print(fn, w, h, 'min', min(data), 'max', max(data),
              'unique', len(set(data)))


if __name__ == '__main__':
    main()
