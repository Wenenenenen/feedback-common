#!/usr/bin/env python3
"""测试夹具：解压样例到临时目录（每个压缩包独立目录）。"""
import os
import sys
import zipfile
import tempfile
import shutil


def extract_samples(zip_path):
    """解压到一个新的临时目录并返回路径。调用方负责在退出时清理。"""
    d = tempfile.mkdtemp(prefix='occl-samples-')
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(d)
    return d


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('usage: samples.py <zip>', file=sys.stderr)
        sys.exit(2)
    out = extract_samples(sys.argv[1])
    print(out)
