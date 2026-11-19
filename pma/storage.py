"""SQLite persistence for the match service.

Everything that must survive a restart lives here: the logical clock, tickets,
rooms, and the request log that makes writes idempotent.

Concurrency model
-----------------
Each thread gets its own connection (WAL mode, ``busy_timeout`` set).  Every
write runs inside ``BEGIN IMMEDIATE``, so SQLite itself serialises writers: a
cancel and a tick that race are executed one after the other, and whichever
runs second sees the first one's committed state.  That is what prevents the
"one player in two rooms" bug — a ticket can only be marked matched by the
transaction that also inserts the room, and the cancel either happens before
(ticket leaves the queue) or after (ticket is already matched, so cancel is
rejected).

Idempotency
-----------
A write request is identified by ``requestKey``.  Inside the *same* write
transaction we look the key up, compare the canonicalised payload, and either
replay the stored response or perform the operation and store the response.
A failed operation rolls back, so it leaves no request record behind.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
from typing import Any, Mapping

from . import matcher
from .errors import ApiError
from .model import (
    MAX_QUEUE_TICKETS,
    Member,
    Ticket,
    clean_ticket_id,
    parse_ticket_fields,
    ticket_from_row,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
    request_key   TEXT PRIMARY KEY,
    method        TEXT NOT NULL,
    path          TEXT NOT NULL,
    payload_hash  TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    status        INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    seq           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
    id                 TEXT PRIMARY KEY,
    created_at         INTEGER NOT NULL,
    members_json       TEXT NOT NULL,
    status             TEXT NOT NULL,
    room_id            INTEGER,
    join_request_key   TEXT NOT NULL,
    cancel_request_key TEXT,
    seq                INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_members (
    ticket_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    PRIMARY KEY (ticket_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_members_member ON ticket_members(member_id);

CREATE TABLE IF NOT EXISTS rooms (
    room_id         INTEGER PRIMARY KEY,
    clock           INTEGER NOT NULL,
    region          TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    tick_request_key TEXT NOT NULL,
    seq             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
    room_id   INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    PRIMARY KEY (room_id, member_id)
);
-- Hard guarantee behind the application check: a player can never be in two
-- rooms, not even if a future code path forgets to look.
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_once ON room_members(member_id);
CREATE INDEX IF NOT EXISTS idx_room_members_member ON room_members(member_id);
"""

ACTIVE = "queued"
MATCHED = "matched"
CANCELLED = "cancelled"

DEBUG_CANDIDATE_BUDGET = 200_000
MATCH_BUDGET = 1_000_000


def canonical_json(payload: Any) -> str:
    """A stable rendering used for payload comparison and hashing."""

    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def payload_digest(payload: Any) -> str:
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


class Store:
    """All business operations.  One instance per database file."""

    def __init__(self, path: str) -> None:
        self.path = path
        if path != ":memory:":
            directory = os.path.dirname(os.path.abspath(path))
            os.makedirs(directory, exist_ok=True)
        self._local = threading.local()
        self._init_lock = threading.Lock()
        with self._init_lock:
            conn = self._connect(set_wal=True)
            conn.executescript(SCHEMA)
            conn.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES ('clock', '0')"
            )
            conn.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES ('request_seq', '0')"
            )
            conn.commit()

    # -- connection management ------------------------------------------------

    def _connect(self, set_wal: bool = False) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        if set_wal:
            # Journal mode is a property of the database file, so it only needs
            # to be set once.  Setting it on every new connection makes them
            # contend for an exclusive lock while opening, which under a burst
            # of requests surfaces as "database is locked".
            conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._connect()
            self._local.conn = conn
        return conn

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # -- small helpers --------------------------------------------------------

    def _meta_int(self, key: str) -> int:
        row = self.conn.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)
        ).fetchone()
        return int(row["value"]) if row else 0

    def _bump_meta(self, key: str) -> int:
        value = self._meta_int(key) + 1
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
        return value

    @staticmethod
    def _row_to_ticket(row: sqlite3.Row) -> Ticket:
        members_raw = json.loads(row["members_json"])
        members = tuple(
            Member(
                id=item["id"],
                skill=item["skill"],
                ping={key: int(value) for key, value in item["ping"].items()},
            )
            for item in members_raw
        )
        return ticket_from_row(
            row["id"],
            row["created_at"],
            members,
            status=row["status"],
            room_id=row["room_id"],
        )

    def _load_tickets(self, statuses: tuple[str, ...] | None = None) -> list[Ticket]:
        query = "SELECT * FROM tickets"
        params: tuple = ()
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            query += f" WHERE status IN ({placeholders})"
            params = statuses
        query += " ORDER BY seq"
        return [self._row_to_ticket(row) for row in self.conn.execute(query, params)]

    def _room_payload(self, room_id: int) -> dict:
        row = self.conn.execute(
            "SELECT payload_json FROM rooms WHERE room_id = ?", (room_id,)
        ).fetchone()
        return json.loads(row["payload_json"]) if row else {}

    # -- request record -------------------------------------------------------

    def _lookup_request(
        self, request_key: str, method: str, path: str, digest: str
    ) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM requests WHERE request_key = ?", (request_key,)
        ).fetchone()
        if row is None:
            return None
        if row["method"] != method or row["path"] != path:
            raise ApiError(
                409,
                "request_key_conflict",
                f"requestKey {request_key!r} 已用于 {row['method']} {row['path']}，不能改用到 {method} {path}",
                {
                    "requestKey": request_key,
                    "existing": {"method": row["method"], "path": row["path"]},
                    "incoming": {"method": method, "path": path},
                },
            )
        if row["payload_hash"] != digest:
            raise ApiError(
                409,
                "request_key_conflict",
                f"requestKey {request_key!r} 已使用不同的载荷",
                {
                    "requestKey": request_key,
                    "existingPayload": json.loads(row["payload_json"]),
                    "incomingPayloadDigest": digest,
                },
            )
        return json.loads(row["response_json"])

    def _store_request(
        self,
        request_key: str,
        method: str,
        path: str,
        payload: Mapping[str, Any],
        digest: str,
        status: int,
        response: dict,
    ) -> None:
        seq = self._bump_meta("request_seq")
        self.conn.execute(
            """
            INSERT INTO requests
                (request_key, method, path, payload_hash, payload_json,
                 status, response_json, seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                request_key,
                method,
                path,
                digest,
                canonical_json(payload),
                status,
                canonical_json(response),
                seq,
            ),
        )

    # -- public read API ------------------------------------------------------

    def clock(self) -> int:
        return self._meta_int("clock")

    def get_request(self, request_key: str) -> dict:
        key = request_key.strip() if isinstance(request_key, str) else ""
        if not key:
            raise ApiError(400, "invalid_request", "requestKey 不能为空")
        row = self.conn.execute(
            "SELECT * FROM requests WHERE request_key = ?", (key,)
        ).fetchone()
        if row is None:
            raise ApiError(404, "request_not_found", f"未找到请求记录 {key!r}")
        return {
            "requestKey": row["request_key"],
            "method": row["method"],
            "path": row["path"],
            "status": row["status"],
            "receivedSeq": row["seq"],
            "payload": json.loads(row["payload_json"]),
            "result": json.loads(row["response_json"]),
        }

    def list_requests(self, limit: int = 50) -> list[dict]:
        limit = max(1, min(int(limit), 500))
        rows = self.conn.execute(
            "SELECT request_key, method, path, status, payload_json, seq "
            "FROM requests ORDER BY seq DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {
                "requestKey": row["request_key"],
                "method": row["method"],
                "path": row["path"],
                "status": row["status"],
                "receivedSeq": row["seq"],
                "payload": json.loads(row["payload_json"]),
            }
            for row in rows
        ]

    def get_state(self) -> dict:
        # One read transaction so the ticket list, rooms and clock all come
        # from the same committed snapshot (a concurrent tick must not make
        # the response self-inconsistent).
        with self._read():
            clock = self.clock()
            tickets = self._load_tickets()
            rooms = [
                json.loads(row["payload_json"])
                for row in self.conn.execute(
                    "SELECT payload_json FROM rooms ORDER BY room_id"
                )
            ]
            next_room_row = self.conn.execute(
                "SELECT COALESCE(MAX(room_id), 0) AS m FROM rooms"
            ).fetchone()
        counts = {"queued": 0, "matched": 0, "cancelled": 0}
        for ticket in tickets:
            counts[ticket.status] = counts.get(ticket.status, 0) + 1
        queued = [ticket for ticket in tickets if ticket.status == ACTIVE]
        return {
            "clock": clock,
            "counts": {
                **counts,
                "tickets": len(tickets),
                "rooms": len(rooms),
                "queuedMembers": sum(ticket.size for ticket in queued),
                "queueCapacity": MAX_QUEUE_TICKETS,
            },
            "nextRoomId": int(next_room_row["m"]) + 1,
            "tickets": [ticket.to_dict() for ticket in tickets],
            "rooms": rooms,
        }

    def debug_candidates(
        self, offset: int = 0, limit: int = 50, now: int | None = None
    ) -> dict:
        with self._read():
            clock = self.clock() if now is None else int(now)
            queued = self._load_tickets((ACTIVE,))
        rows, truncated = matcher.list_candidates(
            queued,
            clock,
            offset=offset,
            limit=limit,
            budget=DEBUG_CANDIDATE_BUDGET,
        )
        diagnosis = matcher.diagnose(queued, clock, budget=DEBUG_CANDIDATE_BUDGET)
        return {
            "clock": clock,
            "offset": offset,
            "limit": limit,
            "truncated": truncated,
            "candidates": [
                {
                    "index": offset + position,
                    **candidate.to_dict(),
                }
                for position, candidate in enumerate(rows)
            ],
            "diagnosis": diagnosis,
        }

    # -- write operations -----------------------------------------------------

    def join(self, payload: Mapping[str, Any]) -> tuple[int, dict, bool]:
        request_key = _require_request_key(payload)
        ticket_id, members = parse_ticket_fields(payload)
        digest = payload_digest(payload)

        with self._write() as conn:
            replayed = self._lookup_request(
                request_key, "POST", "/tickets", digest
            )
            if replayed is not None:
                return 200, replayed, True

            if conn.execute(
                "SELECT 1 FROM tickets WHERE id = ?", (ticket_id,)
            ).fetchone():
                raise ApiError(
                    409,
                    "ticket_exists",
                    f"ticketId {ticket_id!r} 已存在（ticketId 永久唯一）",
                    {"ticketId": ticket_id},
                )

            queued_count = conn.execute(
                "SELECT COUNT(*) AS c FROM tickets WHERE status = ?", (ACTIVE,)
            ).fetchone()["c"]
            if queued_count >= MAX_QUEUE_TICKETS:
                raise ApiError(
                    409,
                    "queue_full",
                    f"队列已满（上限 {MAX_QUEUE_TICKETS} 张票）",
                    {"capacity": MAX_QUEUE_TICKETS, "queued": queued_count},
                )

            member_ids = [member.id for member in members]
            self._assert_members_free(conn, member_ids)

            created_at = self._meta_int("clock")
            members_json = canonical_json([member.to_dict() for member in members])
            seq = self._bump_meta("ticket_seq")
            conn.execute(
                """
                INSERT INTO tickets
                    (id, created_at, members_json, status, room_id,
                     join_request_key, cancel_request_key, seq)
                VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)
                """,
                (ticket_id, created_at, members_json, ACTIVE, request_key, seq),
            )
            conn.executemany(
                "INSERT INTO ticket_members (ticket_id, member_id) VALUES (?, ?)",
                [(ticket_id, member_id) for member_id in member_ids],
            )

            response = {
                "requestKey": request_key,
                "ticket": ticket_from_row(ticket_id, created_at, members).to_dict(),
                "clock": created_at,
                "queueSize": queued_count + 1,
            }
            self._store_request(
                request_key, "POST", "/tickets", payload, digest, 200, response
            )
            return 200, response, False

    def cancel(self, payload: Mapping[str, Any]) -> tuple[int, dict, bool]:
        request_key = _require_request_key(payload)
        ticket_id = clean_ticket_id(payload.get("ticketId"))
        digest = payload_digest(payload)

        with self._write() as conn:
            replayed = self._lookup_request(
                request_key, "POST", "/cancel", digest
            )
            if replayed is not None:
                return 200, replayed, True

            row = conn.execute(
                "SELECT * FROM tickets WHERE id = ?", (ticket_id,)
            ).fetchone()
            if row is None:
                raise ApiError(
                    404, "ticket_not_found", f"ticketId {ticket_id!r} 不存在"
                )

            if row["status"] == MATCHED:
                raise ApiError(
                    409,
                    "ticket_already_matched",
                    f"票 {ticket_id!r} 已进入房间 {row['room_id']}，不能取消",
                    {"ticketId": ticket_id, "roomId": row["room_id"]},
                )

            if row["status"] == CANCELLED:
                # Cancelling an already-cancelled ticket is a successful
                # no-op returning the recorded terminal state.
                ticket = self._row_to_ticket(row)
                response = {
                    "requestKey": request_key,
                    "ticket": ticket.to_dict(),
                    "alreadyCancelled": True,
                    "cancelledBy": row["cancel_request_key"],
                    "clock": self._meta_int("clock"),
                }
                self._store_request(
                    request_key, "POST", "/cancel", payload, digest, 200, response
                )
                return 200, response, False

            conn.execute(
                "UPDATE tickets SET status = ?, cancel_request_key = ? WHERE id = ?",
                (CANCELLED, request_key, ticket_id),
            )
            ticket = ticket_from_row(
                row["id"],
                row["created_at"],
                self._row_to_ticket(row).members,
                status=CANCELLED,
            )
            response = {
                "requestKey": request_key,
                "ticket": ticket.to_dict(),
                "alreadyCancelled": False,
                "clock": self._meta_int("clock"),
            }
            self._store_request(
                request_key, "POST", "/cancel", payload, digest, 200, response
            )
            return 200, response, False

    def tick(self, payload: Mapping[str, Any]) -> tuple[int, dict, bool]:
        request_key = _require_request_key(payload)
        now_raw = payload.get("now")
        if (
            not isinstance(now_raw, int)
            or isinstance(now_raw, bool)
            or now_raw < 0
        ):
            raise ApiError(400, "invalid_request", "now 必须是非负整数毫秒")
        now = now_raw
        digest = payload_digest(payload)

        with self._write() as conn:
            replayed = self._lookup_request(
                request_key, "POST", "/tick", digest
            )
            if replayed is not None:
                return 200, replayed, True

            current = self._meta_int("clock")
            if now < current:
                raise ApiError(
                    409,
                    "clock_regression",
                    f"逻辑时钟不能倒退：当前 {current}，收到 {now}",
                    {"clock": current, "now": now},
                )

            queued = self._load_tickets((ACTIVE,))
            matches = matcher.run_matching(queued, now, budget=MATCH_BUDGET)

            next_room = conn.execute(
                "SELECT COALESCE(MAX(room_id), 0) AS m FROM rooms"
            ).fetchone()["m"]
            next_room = int(next_room)
            created: list[dict] = []
            for candidate in matches:
                next_room += 1
                room_payload = candidate.to_room_payload(next_room, now)
                room_payload["tickRequestKey"] = request_key
                seq = self._bump_meta("room_seq")
                conn.execute(
                    """
                    INSERT INTO rooms
                        (room_id, clock, region, payload_json, tick_request_key, seq)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        next_room,
                        now,
                        candidate.region,
                        canonical_json(room_payload),
                        request_key,
                        seq,
                    ),
                )
                conn.executemany(
                    "INSERT INTO room_members (room_id, member_id) VALUES (?, ?)",
                    [
                        (next_room, member_id)
                        for member_id in candidate.team_a + candidate.team_b
                    ],
                )
                placeholders = ",".join("?" for _ in candidate.ticket_ids)
                conn.execute(
                    f"UPDATE tickets SET status = ?, room_id = ? "
                    f"WHERE id IN ({placeholders})",
                    (MATCHED, next_room, *candidate.ticket_ids),
                )
                created.append(room_payload)

            conn.execute(
                "UPDATE meta SET value = ? WHERE key = 'clock'", (str(now),)
            )

            remaining = conn.execute(
                "SELECT COUNT(*) AS c FROM tickets WHERE status = ?", (ACTIVE,)
            ).fetchone()["c"]
            response = {
                "requestKey": request_key,
                "now": now,
                "roomsCreated": created,
                "roomIds": [room["roomId"] for room in created],
                "queuedTickets": remaining,
            }
            self._store_request(
                request_key, "POST", "/tick", payload, digest, 200, response
            )
            return 200, response, False

    # -- transaction plumbing -------------------------------------------------

    def _assert_members_free(
        self, conn: sqlite3.Connection, member_ids: list[str]
    ) -> None:
        if not member_ids:
            return
        placeholders = ",".join("?" for _ in member_ids)

        active_rows = conn.execute(
            f"""
            SELECT tm.member_id, t.id AS ticket_id
            FROM ticket_members tm
            JOIN tickets t ON t.id = tm.ticket_id
            WHERE t.status = ? AND tm.member_id IN ({placeholders})
            """,
            (ACTIVE, *member_ids),
        ).fetchall()
        if active_rows:
            conflicts = [
                {"memberId": row["member_id"], "ticketId": row["ticket_id"]}
                for row in active_rows
            ]
            raise ApiError(
                409,
                "member_already_active",
                f"成员已在排队中的票里：{conflicts[0]['memberId']}",
                {"conflicts": conflicts},
            )

        room_rows = conn.execute(
            f"""
            SELECT rm.member_id, rm.room_id
            FROM room_members rm
            WHERE rm.member_id IN ({placeholders})
            """,
            tuple(member_ids),
        ).fetchall()
        if room_rows:
            conflicts = [
                {"memberId": row["member_id"], "roomId": row["room_id"]}
                for row in room_rows
            ]
            raise ApiError(
                409,
                "member_already_in_room",
                f"成员已进入房间：{conflicts[0]['memberId']}",
                {"conflicts": conflicts},
            )

    class _WriteTransaction:
        def __init__(self, store: "Store") -> None:
            self.store = store
            self.conn: sqlite3.Connection | None = None

        def __enter__(self) -> sqlite3.Connection:
            conn = self.store.conn
            conn.execute("BEGIN IMMEDIATE")
            self.conn = conn
            return conn

        def __exit__(self, exc_type, exc, tb) -> bool:
            assert self.conn is not None
            if exc_type is None:
                self.conn.execute("COMMIT")
            else:
                self.conn.execute("ROLLBACK")
            return False

    def _write(self) -> "Store._WriteTransaction":
        return Store._WriteTransaction(self)

    class _ReadTransaction:
        def __init__(self, store: "Store") -> None:
            self.store = store

        def __enter__(self) -> sqlite3.Connection:
            conn = self.store.conn
            conn.execute("BEGIN")
            return conn

        def __exit__(self, exc_type, exc, tb) -> bool:
            if exc_type is None:
                self.store.conn.execute("COMMIT")
            else:
                self.store.conn.execute("ROLLBACK")
            return False

    def _read(self) -> "Store._ReadTransaction":
        return Store._ReadTransaction(self)


def _require_request_key(payload: Mapping[str, Any]) -> str:
    value = payload.get("requestKey")
    if not isinstance(value, str) or not value.strip():
        raise ApiError(400, "invalid_request", "requestKey 必须是非空字符串")
    key = value.strip()
    if len(key) > 200:
        raise ApiError(400, "invalid_request", "requestKey 长度不能超过 200 个字符")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in key):
        raise ApiError(400, "invalid_request", "requestKey 不能包含控制字符")
    return key
