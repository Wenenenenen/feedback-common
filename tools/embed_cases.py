#!/usr/bin/env python3
"""把解压后的样例目录（含 tiles.json / mini.json / pages/*.png）打包成 cases.js。

用法: python3 -I tools/embed_cases.py <样例目录> <输出 cases.js>
PNG 以 data URI 内联，页面无需联网或本地服务器即可运行。
"""
import base64
import json
import sys
from pathlib import Path


def load_case(case_dir: Path, name: str) -> dict:
    cfg = json.loads((case_dir / f"{name}.json").read_text(encoding="utf-8"))
    pages = []
    for p in cfg["pages"]:
        png = case_dir / p["path"]
        b64 = base64.b64encode(png.read_bytes()).decode("ascii")
        pages.append({
            "id": p["id"],
            "level": p["level"],
            "x": p["x"],
            "y": p["y"],
            "latencyFrames": p["latencyFrames"],
            "firstFailure": p["firstFailure"],
            "data": f"data:image/png;base64,{b64}",
        })
    return {
        "tileSize": cfg["tileSize"],
        "maxLevel": cfg["maxLevel"],
        "width": cfg["width"],
        "height": cfg["height"],
        "capacity": cfg["capacity"],
        "maxInflight": cfg["maxInflight"],
        "pages": pages,
        "frames": cfg["frames"],
    }


def main() -> None:
    case_dir = Path(sys.argv[1])
    out = Path(sys.argv[2])
    cases = {name: load_case(case_dir, name) for name in ("tiles", "mini")}
    payload = json.dumps(cases, ensure_ascii=False, separators=(",", ":"))
    out.write_text(
        "// 由 tools/embed_cases.py 生成，请勿手改。\n"
        f"const CASES = {payload};\n",
        encoding="utf-8",
    )
    print(f"写入 {out}（{out.stat().st_size} 字节）")


if __name__ == "__main__":
    main()
