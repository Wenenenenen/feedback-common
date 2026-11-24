#!/usr/bin/env python3
"""把 samples/stabilized-aperture-cases.zip 内嵌为 js/sample-data.js（base64）。
页面因此不需要任何网络请求即可「载入示例」。运行：python3 tools/embed_sample.py
"""
import base64
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'samples', 'stabilized-aperture-cases.zip')
DST = os.path.join(ROOT, 'js', 'sample-data.js')

with open(SRC, 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('ascii')

with open(DST, 'w') as f:
    f.write('/* 自动生成：python3 tools/embed_sample.py（勿手改） */\n')
    f.write('window.SAP_SAMPLE_ZIP = \'')
    f.write(b64)
    f.write('\';\n')

print(f'wrote {DST} ({len(b64)} base64 chars)')
