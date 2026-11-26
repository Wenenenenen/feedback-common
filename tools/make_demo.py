#!/usr/bin/env python3
"""Regenerate web/sample-data.js from the extracted sample bytes.

Run: python3 -I tools/make_demo.py samples/extracted
"""
import base64
import json
import os
import sys


def main():
    data_dir = sys.argv[1]
    files = {}
    for name in sorted(os.listdir(data_dir)):
        with open(os.path.join(data_dir, name), "rb") as fh:
            files[name] = base64.b64encode(fh.read()).decode()
    out_path = os.path.join(os.path.dirname(__file__), "..", "web", "sample-data.js")
    with open(out_path, "w", encoding="utf-8") as out:
        out.write("// Built-in demo: exact bytes of samples/alpha-backdrops.zip.\n")
        out.write("// Regenerate with: python3 -I tools/make_demo.py samples/extracted\n")
        out.write("window.DEMO_FILES = ")
        out.write(json.dumps(files, ensure_ascii=False, indent=0))
        out.write(";\n")
    print("wrote", os.path.normpath(out_path), "files:", ", ".join(sorted(files)))


if __name__ == "__main__":
    main()
