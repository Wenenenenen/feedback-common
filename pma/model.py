"""Domain types and payload validation.

The matching rules only ever see ``Ticket`` / ``Member`` instances, never raw
JSON.  Parsing and validation therefore live here, in one place, so the HTTP
layer cannot accidentally accept a half-validated ticket.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from .errors import ApiError

#: The only regions that exist.  A member without a ping entry for a region is
#: unavailable in that region.
REGIONS: tuple[str, ...] = ("r1", "r2", "r3")

#: Hard bounds from the rules.
MAX_QUEUE_TICKETS = 24
MIN_TICKET_MEMBERS = 1
MAX_TICKET_MEMBERS = 3

MAX_ID_LENGTH = 128


def _is_int(value: Any) -> bool:
    # ``bool`` is a subclass of ``int`` but ``true`` is not a valid skill.
    return isinstance(value, int) and not isinstance(value, bool)


def _clean_id(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ApiError(400, "invalid_request", f"{field} 必须是字符串")
    cleaned = value.strip()
    if not cleaned:
        raise ApiError(400, "invalid_request", f"{field} 不能为空")
    if len(cleaned) > MAX_ID_LENGTH:
        raise ApiError(
            400,
            "invalid_request",
            f"{field} 长度不能超过 {MAX_ID_LENGTH} 个字符",
        )
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in cleaned):
        raise ApiError(400, "invalid_request", f"{field} 不能包含控制字符")
    return cleaned


@dataclass(frozen=True)
class Member:
    """A single player inside a ticket."""

    id: str
    skill: int
    ping: Mapping[str, int]

    def ping_ms(self, region: str) -> int | None:
        return self.ping.get(region)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "skill": self.skill,
            "ping": {region: self.ping[region] for region in sorted(self.ping)},
        }


@dataclass(frozen=True)
class Ticket:
    """A party of one to three players that must stay together."""

    id: str
    created_at: int
    members: tuple[Member, ...]
    status: str = "queued"
    room_id: int | None = None

    @property
    def size(self) -> int:
        return len(self.members)

    def member_ids(self) -> tuple[str, ...]:
        return tuple(member.id for member in self.members)

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "createdAt": self.created_at,
            "status": self.status,
            "memberCount": self.size,
            "members": [member.to_dict() for member in self.members],
        }
        if self.room_id is not None:
            payload["roomId"] = self.room_id
        return payload


def parse_member(raw: Any, index: int, seen: set[str]) -> Member:
    if not isinstance(raw, Mapping):
        raise ApiError(400, "invalid_request", f"members[{index}] 必须是对象")

    member_id = _clean_id(raw.get("id"), f"members[{index}].id")
    if member_id in seen:
        raise ApiError(
            400,
            "invalid_request",
            f"members[{index}].id 在同一张票中重复: {member_id}",
        )
    seen.add(member_id)

    skill = raw.get("skill")
    if not _is_int(skill):
        raise ApiError(400, "invalid_request", f"members[{index}].skill 必须是整数")

    ping_raw = raw.get("ping", {})
    if ping_raw is None:
        ping_raw = {}
    if not isinstance(ping_raw, Mapping):
        raise ApiError(400, "invalid_request", f"members[{index}].ping 必须是对象")

    ping: dict[str, int] = {}
    for region, value in ping_raw.items():
        if region not in REGIONS:
            raise ApiError(
                400,
                "invalid_request",
                f"members[{index}].ping 含未知地区 {region!r}，仅支持 {', '.join(REGIONS)}",
            )
        if not _is_int(value) or value < 0:
            raise ApiError(
                400,
                "invalid_request",
                f"members[{index}].ping.{region} 必须是非负整数毫秒",
            )
        ping[region] = value

    return Member(id=member_id, skill=skill, ping=ping)


def parse_ticket_fields(raw: Mapping[str, Any]) -> tuple[str, tuple[Member, ...]]:
    """Validate the ``id`` / ``members`` part of a join payload."""

    ticket_id = _clean_id(raw.get("id"), "id")

    members_raw = raw.get("members")
    if not isinstance(members_raw, list):
        raise ApiError(400, "invalid_request", "members 必须是数组")
    if not (MIN_TICKET_MEMBERS <= len(members_raw) <= MAX_TICKET_MEMBERS):
        raise ApiError(
            400,
            "invalid_request",
            f"members 必须有 {MIN_TICKET_MEMBERS} 到 {MAX_TICKET_MEMBERS} 名成员，收到 {len(members_raw)} 名",
        )

    seen: set[str] = set()
    members = tuple(
        parse_member(raw_member, index, seen)
        for index, raw_member in enumerate(members_raw)
    )
    return ticket_id, members


def ticket_from_row(
    ticket_id: str,
    created_at: int,
    members: Iterable[Member],
    status: str = "queued",
    room_id: int | None = None,
) -> Ticket:
    return Ticket(
        id=ticket_id,
        created_at=created_at,
        members=tuple(members),
        status=status,
        room_id=room_id,
    )


def clean_ticket_id(value: Any) -> str:
    """Validate a bare ticket id (used by ``/cancel``)."""

    return _clean_id(value, "ticketId")
