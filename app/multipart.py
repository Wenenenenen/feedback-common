"""multipart/form-data 解析（标准库 email 实现，不依赖第三方）。"""
from __future__ import annotations

from email.parser import BytesParser
from email.policy import default


def parse_multipart(body: bytes, content_type: str) -> dict[str, dict]:
    """返回 {字段名: {"filename": str|None, "content_type": str, "data": bytes}}。"""
    header = f"Content-Type: {content_type}\r\n\r\n".encode()
    msg = BytesParser(policy=default).parsebytes(header + body)
    out: dict[str, dict] = {}
    if not msg.is_multipart():
        return out
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name is None:
            continue
        out[name] = {
            "filename": part.get_filename(),
            "content_type": part.get_content_type(),
            "data": part.get_payload(decode=True) or b"",
        }
    return out
