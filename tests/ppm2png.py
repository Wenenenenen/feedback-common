#!/usr/bin/env python3
# 测试辅助：PPM -> PNG（脚本与样例数据分目录，用 -I 隔离运行）
import sys
from PIL import Image

for src, dst in zip(sys.argv[1::2], sys.argv[2::2]):
    im = Image.open(src)
    im = im.resize((im.width * 3, im.height * 3), Image.NEAREST)
    im.save(dst)
    print(dst, im.size)
