"""本地观测源，使用 Python 3.12 标准库；运行时必须传 --port。
协议：
POST /v1/snapshots：创建固定水位快照，返回 snapshot、watermark、cursor。
GET /v1/snapshots/<snapshot>?cursor=<原样回传>：返回 records、next；
next 为下一页游标，null 表示结束。相邻页故意重叠一条。
GET /v1/head：返回 watermark。GET /v1/changes?after=C&until=H：
返回 events、next、done；next 是下一次的 after，直到 done 为 true。
事件为 {seq, op, record}，op 为 upsert 或 delete；record 含 id、revision，
删除只含这两项。增量页内故意乱序并重复一条，以最高 revision 决定状态。
快照只含存活记录。游标失效或 after 低于保留水位时返回 410。
每轮快照固定创建时水位；每轮增量固定读取 head 得到的 H。
以下接口仅供验收，采集程序禁止访问：
POST /__test：JSON 的 op 为 mutate、expire、compact、grow、fault 或 delay。
mutate 注入更新、删除、迟到旧版本、新增及合法复活。
expire 使全部快照失效；compact 将增量保留水位推进到当前水位。
grow 使用 count 指定新增量，每条 payload 为 1024 个 ASCII 字符。
fault 使用 status=429或503、count、retry_after 指定后续数据请求故障。
delay 使用 ms 设置数据请求延迟，可用于强杀和并发读取测试。
GET /__test/status：返回水位及最近请求时间、路径、状态。
GET /__test/oracle：返回当前存活记录数和规范化 NDJSON 的 SHA-256；
规范化为按 id 排序，逐条以 ensure_ascii=False、sort_keys=True、
separators=(',', ':') 序列化并追加一个换行，再按 UTF-8 计算摘要。
"""
import argparse
import hashlib
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PAGE = 200
LOCK = threading.RLock()

class Source:
    def __init__(self):
        self.events, self.rows, self.snapshots, self.trace = [], {}, {}, []
        self.floor = self.round = self.bulk = self.delay_ms = 0
        self.fault = None
        for i in range(1, 13):
            self.put(self.row(f"sensor-{i:04d}", 1, i))

    def row(self, key, revision, value):
        return {"id": key, "revision": revision, "value": value,
                "observed_at": "2025-01-01T00:00:00Z", "payload": "观测样本"}

    def put(self, row, op="upsert"):
        self.events.append({"seq": len(self.events) + 1, "op": op, "record": row})
        old = self.rows.get(row["id"])
        if old is None or row["revision"] > old[1]["revision"]:
            self.rows[row["id"]] = (op, row)

    def live(self):
        return [item[1] for key, item in sorted(self.rows.items()) if item[0] == "upsert"]

    def control(self, data):
        op = data["op"]
        if op == "mutate":
            self.round += 1
            revision = 10 * self.round + 10
            row = self.row("sensor-0001", revision, self.round)
            row["observed_at"] = "2020-01-01T00:00:00Z"
            row["calibration"] = {"批次": self.round}
            self.put(row)
            self.put({"id": "sensor-0002", "revision": revision}, "delete")
            self.put(self.row("sensor-0002", revision - 1, -1))
            self.put(self.row("sensor-0001", revision - 1, -1))
            self.put(self.row(f"extra-{self.round:04d}", 1, 99))
            self.put({"id": "sensor-0003", "revision": revision}, "delete")
            self.put(self.row("sensor-0003", revision + 1, 77))
        elif op == "expire":
            self.snapshots.clear()
        elif op == "compact":
            self.floor = len(self.events)
        elif op == "grow":
            count = int(data.get("count", 100000))
            if not 0 <= count <= 200000:
                raise ValueError("新增量超出范围")
            for _ in range(count):
                self.bulk += 1
                row = self.row(f"bulk-{self.bulk:08d}", 1, self.bulk)
                row["payload"] = "x" * 1024
                self.put(row)
        elif op == "fault":
            status, count = int(data["status"]), int(data["count"])
            wait = int(data.get("retry_after", 1))
            if status not in (429, 503) or count < 0 or wait < 0:
                raise ValueError("故障参数无效")
            self.fault = {"status": status, "count": count, "wait": wait}
        elif op == "delay":
            delay = int(data.get("ms", 0))
            if not 0 <= delay <= 2000:
                raise ValueError("延迟超出范围")
            self.delay_ms = delay
        else:
            raise ValueError("未知控制操作")
        return {"watermark": len(self.events), "floor": self.floor}

    def route(self, method, path, query, data):
        if path == "/__test" and method == "POST":
            return 200, self.control(data)
        if path == "/__test/status" and method == "GET":
            return 200, {"watermark": len(self.events), "floor": self.floor,
                         "requests": list(self.trace)}
        if path == "/__test/oracle" and method == "GET":
            rows, digest = self.live(), hashlib.sha256()
            for row in rows:
                line = json.dumps(row, ensure_ascii=False, sort_keys=True,
                                  separators=(",", ":")) + "\n"
                digest.update(line.encode("utf-8"))
            return 200, {"count": len(rows), "watermark": len(self.events),
                         "sha256": digest.hexdigest()}
        if path == "/v1/head" and method == "GET":
            return 200, {"watermark": len(self.events)}
        if path == "/v1/snapshots" and method == "POST":
            sid, rows = uuid.uuid4().hex, self.live()
            tokens = [uuid.uuid4().hex for _ in range(max(1, (len(rows) + PAGE - 1) // PAGE))]
            self.snapshots[sid] = (len(self.events), rows, tokens,
                                   {token: i for i, token in enumerate(tokens)})
            return 200, {"snapshot": sid, "watermark": len(self.events), "cursor": tokens[0]}
        if path.startswith("/v1/snapshots/") and method == "GET":
            snapshot = self.snapshots.get(path.rsplit("/", 1)[1])
            token = query.get("cursor", [""])[0]
            if snapshot is None or token not in snapshot[3]:
                return 410, {"error": "快照或游标已过期"}
            watermark, rows, tokens, indices = snapshot
            index = indices[token]
            start = index * PAGE
            page = rows[max(0, start - 1):start + PAGE]
            next_token = tokens[index + 1] if index + 1 < len(tokens) else None
            return 200, {"watermark": watermark, "records": page, "next": next_token}
        if path == "/v1/changes" and method == "GET":
            after, until = int(query["after"][0]), int(query["until"][0])
            if not 0 <= after <= until <= len(self.events):
                raise ValueError("水位区间无效")
            if after < self.floor:
                return 410, {"error": "增量已清理"}
            batch = self.events[after:min(after + PAGE, until)]
            next_after = batch[-1]["seq"] if batch else after
            delivered = list(reversed(batch))
            if delivered:
                delivered.append(delivered[0])
            return 200, {"events": delivered, "next": next_after, "done": next_after == until}
        return 404, {"error": "接口不存在"}

SOURCE = Source()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.handle_api()

    def do_POST(self):
        self.handle_api()

    def handle_api(self):
        url = urlsplit(self.path)
        is_data = url.path.startswith("/v1/")
        with LOCK:
            delay = SOURCE.delay_ms if is_data else 0
        time.sleep(delay / 1000)
        retry_after = None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length)) if length else {}
            with LOCK:
                fault = SOURCE.fault
                if is_data and fault and fault["count"] > 0:
                    fault["count"] -= 1
                    status, result = fault["status"], {"error": "注入故障"}
                    if status == 429:
                        retry_after = fault["wait"]
                else:
                    status, result = SOURCE.route(self.command, url.path, parse_qs(url.query), data)
        except (ValueError, KeyError, TypeError) as exc:
            status, result = 400, {"error": str(exc)}
        if is_data:
            with LOCK:
                SOURCE.trace.append({"path": self.path, "status": status,
                                     "at": round(time.monotonic(), 3)})
                SOURCE.trace[:] = SOURCE.trace[-2000:]
        body = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="本地观测采集验收源")
    parser.add_argument("--port", type=int, required=True, help="使用验收分配的端口")
    args = parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
