#!/usr/bin/env python3
"""Embed samples/sparse-tiff-roi-cases.zip into js/samples-inline.js as base64.

Run with -I from the repo root (or any directory) after replacing the sample
archive. The page uses this so it also works over file:// where fetch() of a
local file is blocked.
"""
import base64
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    zip_path = os.path.join(ROOT, 'samples', 'sparse-tiff-roi-cases.zip')
    out_path = os.path.join(ROOT, 'js', 'samples-inline.js')
    data = open(zip_path, 'rb').read()
    b64 = base64.b64encode(data).decode('ascii')
    with open(out_path, 'w') as f:
        f.write('/* Generated from samples/sparse-tiff-roi-cases.zip by '
                'tools/embed_samples.py.\n')
        f.write(' * Embedded so the page also works when opened directly from '
                'disk (file://). */\n')
        f.write('(function (root) {\n')
        f.write("  root.SAMPLE_ZIP_BASE64 = '" + b64 + "';\n")
        f.write("})(typeof self !== 'undefined' ? self : this);\n")
    print('embedded %d bytes into %s' % (len(data), out_path))


if __name__ == '__main__':
    sys.exit(main())
