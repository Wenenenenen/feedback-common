"""Exact room selection.

Rules (see README for the full derivation):

* A ticket holds 1-3 players and joins a team as a whole.
* A room is exactly six players split into two three-player teams.
* A ticket's skill tolerance is ``min(400, 100 + 10 * floor((now - createdAt) / 1000))``.
* The six players' skill spread may not exceed *any* selected ticket's tolerance.
* Every player must have a ping entry for the room's region and it must be <= 80.
* Candidates are ordered by, in order:
    1. the selected tickets' ``(createdAt, id)`` sequence,
    2. ``abs(skill team A - skill team B)``,
    3. the six players' maximum ping in the chosen region,
    4. the region name,
    5. team A's sorted member-id sequence,
    6. team B's sorted member-id sequence
  (teams are unlabeled: each team's ids are sorted and the lexicographically
  smaller team becomes A).

Rooms are chosen one at a time: take the global minimum candidate, remove its
tickets, recompute, repeat.  Because the first key is the ticket sequence, the
global minimum can be found by walking ticket combinations in that order, which
also lets the debug endpoint page through candidates without sorting millions of
rows.
"""

from __future__ import annotations

import heapq
import itertools
from dataclasses import dataclass
from typing import Iterator, Sequence

from .model import REGIONS, Ticket

PING_LIMIT = 80
BASE_THRESHOLD = 100
THRESHOLD_STEP = 10
THRESHOLD_CAP = 400
ROOM_MEMBERS = 6
TEAM_SIZE = 3

REASON_INSUFFICIENT = "insufficient_players"
REASON_UNSPLITTABLE = "party_unsplittable"
REASON_SPREAD = "skill_spread_exceeded"
REASON_REGION = "no_common_region"

REASON_LABELS = {
    REASON_INSUFFICIENT: "人数不足",
    REASON_UNSPLITTABLE: "整队无法分边",
    REASON_SPREAD: "分差超限",
    REASON_REGION: "无共同地区",
}

REASON_ORDER = (
    REASON_INSUFFICIENT,
    REASON_UNSPLITTABLE,
    REASON_SPREAD,
    REASON_REGION,
)


def threshold_for(created_at: int, now: int) -> int:
    """Skill tolerance for a ticket created at ``created_at`` at clock ``now``."""

    elapsed = now - created_at
    if elapsed < 0:
        # The service never lets the clock move backwards; clamping keeps the
        # preview endpoint well behaved if somebody asks for a past instant.
        elapsed = 0
    return min(THRESHOLD_CAP, BASE_THRESHOLD + THRESHOLD_STEP * (elapsed // 1000))


@dataclass(frozen=True)
class _TicketView:
    index: int
    ticket: Ticket
    size: int
    min_skill: int
    max_skill: int
    threshold: int
    #: Per region: maximum ping, or ``None`` when at least one member is
    #: missing the region or exceeds the ping limit.
    region_max_ping: tuple[int | None, ...]

    @property
    def order_key(self) -> tuple[int, str]:
        return (self.ticket.created_at, self.ticket.id)


@dataclass(frozen=True)
class Candidate:
    """One legal room, fully ordered by its documented sort key."""

    tickets: tuple[Ticket, ...]
    region: str
    team_a: tuple[str, ...]
    team_b: tuple[str, ...]
    team_a_ticket_ids: tuple[str, ...]
    team_b_ticket_ids: tuple[str, ...]
    skill_a: int
    skill_b: int
    max_ping: int
    sort_key: tuple

    @property
    def skill_difference(self) -> int:
        return abs(self.skill_a - self.skill_b)

    @property
    def ticket_ids(self) -> tuple[str, ...]:
        return tuple(ticket.id for ticket in self.tickets)

    def to_dict(self) -> dict:
        return {
            "ticketIds": list(self.ticket_ids),
            "region": self.region,
            "teamA": list(self.team_a),
            "teamB": list(self.team_b),
            "teamATicketIds": list(self.team_a_ticket_ids),
            "teamBTicketIds": list(self.team_b_ticket_ids),
            "skillA": self.skill_a,
            "skillB": self.skill_b,
            "skillDifference": self.skill_difference,
            "maxPing": self.max_ping,
            "members": _member_dicts(self.tickets),
            "sortKey": _jsonable_key(self.sort_key),
        }

    def to_room_payload(self, room_id: int, clock: int) -> dict:
        payload = self.to_dict()
        payload.update(
            {
                "roomId": room_id,
                "clock": clock,
                "teams": {
                    "A": {
                        "ticketIds": list(self.team_a_ticket_ids),
                        "memberIds": list(self.team_a),
                        "skill": self.skill_a,
                    },
                    "B": {
                        "ticketIds": list(self.team_b_ticket_ids),
                        "memberIds": list(self.team_b),
                        "skill": self.skill_b,
                    },
                },
            }
        )
        return payload


def _jsonable_key(key: tuple) -> list:
    """Turn the in-memory sort key into a JSON friendly list."""

    tickets, diff, max_ping, region, team_a, team_b = key
    return [
        [[created_at, ticket_id] for created_at, ticket_id in tickets],
        diff,
        max_ping,
        region,
        list(team_a),
        list(team_b),
    ]


def _member_dicts(tickets: Sequence[Ticket]) -> list[dict]:
    """Flat member list so a room/candidate payload is self-contained."""

    return [
        {**member.to_dict(), "ticketId": ticket.id}
        for ticket in tickets
        for member in ticket.members
    ]


def _view(ticket: Ticket, index: int, now: int) -> _TicketView:
    skills = [member.skill for member in ticket.members]
    region_max: list[int | None] = []
    for region in REGIONS:
        ping: int | None = 0
        for member in ticket.members:
            value = member.ping.get(region)
            if value is None or value > PING_LIMIT:
                ping = None
                break
            if value > ping:
                ping = value
        region_max.append(ping)
    return _TicketView(
        index=index,
        ticket=ticket,
        size=len(ticket.members),
        min_skill=min(skills),
        max_skill=max(skills),
        threshold=threshold_for(ticket.created_at, now),
        region_max_ping=tuple(region_max),
    )


def _combination_stream(count: int, max_tickets: int = ROOM_MEMBERS) -> Iterator[tuple[int, ...]]:
    """All ticket combinations that can hold six players, in sort-key order.

    Every combination has between two and six tickets.  ``itertools.combinations``
    emits each size in lexicographic order, and ``heapq.merge`` merges those
    streams into one lexicographic stream — exactly the order of the first
    documented sort key.  A shorter tuple sorts before a longer one sharing its
    prefix, matching ordinary sequence comparison.
    """

    if count < 2:
        return iter(())
    streams = [
        itertools.combinations(range(count), size)
        for size in range(2, min(max_tickets, count) + 1)
    ]
    return heapq.merge(*streams)


def _split_masks(sizes: Sequence[int]) -> tuple[tuple[int, int], ...]:
    """Partitions of the selected tickets into two three-player teams.

    Returns ``(mask, complement)`` pairs, each pair once.
    """

    capacity = 1 << len(sizes)
    full = capacity - 1
    pairs: list[tuple[int, int]] = []
    for mask in range(capacity):
        if mask >= (full ^ mask):
            continue
        total = 0
        for bit, size in enumerate(sizes):
            if mask & (1 << bit):
                total += size
        if total == TEAM_SIZE:
            pairs.append((mask, full ^ mask))
    return tuple(pairs)


def _has_split(sizes: Sequence[int]) -> bool:
    capacity = 1 << len(sizes)
    full = capacity - 1
    for mask in range(capacity):
        if mask >= (full ^ mask):
            continue
        total = 0
        for bit, size in enumerate(sizes):
            if mask & (1 << bit):
                total += size
        if total == TEAM_SIZE:
            return True
    return False


def _team_members(tickets: Sequence[Ticket], mask: int) -> list[str]:
    members: list[str] = []
    for bit, ticket in enumerate(tickets):
        if mask & (1 << bit):
            members.extend(member.id for member in ticket.members)
    return members


def _choose_sides(
    first: Sequence[str], second: Sequence[str]
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    a = tuple(sorted(first))
    b = tuple(sorted(second))
    if a <= b:
        return a, b
    return b, a


def _iter_combination_candidates(
    views: Sequence[_TicketView], combo: tuple[int, ...]
) -> Iterator[Candidate]:
    """Every legal room that uses exactly this ticket combination."""

    selected = [views[index] for index in combo]
    tickets = tuple(view.ticket for view in selected)
    min_threshold = min(view.threshold for view in selected)
    min_skill = min(view.min_skill for view in selected)
    max_skill = max(view.max_skill for view in selected)
    if max_skill - min_skill > min_threshold:
        return

    sizes = [view.size for view in selected]
    pairs = _split_masks(sizes)
    if not pairs:
        return

    ticket_sequence = tuple(view.order_key for view in selected)

    # Every split shares the same six skills, so the skill sums depend only on
    # the ticket set; compute them per partition.
    options: list[tuple[tuple, Candidate]] = []
    for mask, _ in pairs:
        team_a_ids, team_b_ids = _choose_sides(
            _team_members(tickets, mask), _team_members(tickets, (1 << len(tickets)) - 1 ^ mask)
        )
        team_a_set = set(team_a_ids)
        team_b_set = set(team_b_ids)
        skill_a = sum(
            member.skill for ticket in tickets for member in ticket.members if member.id in team_a_set
        )
        skill_b = sum(
            member.skill for ticket in tickets for member in ticket.members if member.id in team_b_set
        )
        diff = abs(skill_a - skill_b)
        tickets_a = tuple(
            sorted(
                (ticket.id for ticket in tickets if set(ticket.member_ids()) <= team_a_set),
            )
        )
        tickets_b = tuple(
            sorted(
                (ticket.id for ticket in tickets if set(ticket.member_ids()) <= team_b_set),
            )
        )

        per_region = []
        for region_index, region in enumerate(REGIONS):
            maxima = [view.region_max_ping[region_index] for view in selected]
            if any(value is None for value in maxima):
                continue
            per_region.append((max(maxima), region))

        for max_ping, region in per_region:
            key = (
                ticket_sequence,
                diff,
                max_ping,
                region,
                team_a_ids,
                team_b_ids,
            )
            options.append(
                (
                    key,
                    Candidate(
                        tickets=tickets,
                        region=region,
                        team_a=team_a_ids,
                        team_b=team_b_ids,
                        team_a_ticket_ids=tickets_a,
                        team_b_ticket_ids=tickets_b,
                        skill_a=skill_a,
                        skill_b=skill_b,
                        max_ping=max_ping,
                        sort_key=key,
                    ),
                )
            )

    options.sort(key=lambda item: item[0])
    for _, candidate in options:
        yield candidate


def iter_candidates(
    tickets: Sequence[Ticket],
    now: int,
    *,
    limit: int | None = None,
    budget: int | None = None,
) -> Iterator[Candidate]:
    """Yield legal rooms in global sort-key order.

    ``limit`` caps how many candidates are produced.  ``budget`` caps how many
    six-player ticket combinations are inspected; when the budget runs out the
    stream simply ends early (callers can detect that with ``diagnose``).
    """

    views = [_view(ticket, index, now) for index, ticket in enumerate(
        sorted(tickets, key=lambda item: (item.created_at, item.id))
    )]
    produced = 0
    scanned = 0
    for combo in _combination_stream(len(views)):
        if budget is not None and scanned >= budget:
            return
        scanned += 1
        if sum(views[index].size for index in combo) != ROOM_MEMBERS:
            continue
        for candidate in _iter_combination_candidates(views, combo):
            yield candidate
            produced += 1
            if limit is not None and produced >= limit:
                return


def list_candidates(
    tickets: Sequence[Ticket],
    now: int,
    *,
    offset: int = 0,
    limit: int = 50,
    budget: int = 200_000,
) -> tuple[list[Candidate], bool]:
    """Page through candidates.  Returns ``(rows, truncated)``."""

    if offset < 0:
        offset = 0
    rows: list[Candidate] = []
    skipped = 0
    scanned = 0
    views = [_view(ticket, index, now) for index, ticket in enumerate(
        sorted(tickets, key=lambda item: (item.created_at, item.id))
    )]
    for combo in _combination_stream(len(views)):
        if scanned >= budget:
            return rows, True
        scanned += 1
        if sum(views[index].size for index in combo) != ROOM_MEMBERS:
            continue
        for candidate in _iter_combination_candidates(views, combo):
            if skipped < offset:
                skipped += 1
                continue
            rows.append(candidate)
            if len(rows) >= limit:
                return rows, False
    return rows, False


def best_candidate(
    tickets: Sequence[Ticket], now: int, *, budget: int = 1_000_000
) -> Candidate | None:
    """The global minimum candidate, or ``None`` when no room is legal."""

    for candidate in iter_candidates(tickets, now, limit=1, budget=budget):
        return candidate
    return None


def run_matching(
    tickets: Sequence[Ticket], now: int, *, budget: int = 1_000_000
) -> list[Candidate]:
    """Repeatedly take the global minimum candidate until no room remains."""

    remaining = list(tickets)
    rooms: list[Candidate] = []
    while True:
        candidate = best_candidate(remaining, now, budget=budget)
        if candidate is None:
            break
        rooms.append(candidate)
        used = set(candidate.ticket_ids)
        remaining = [ticket for ticket in remaining if ticket.id not in used]
    return rooms


# ---------------------------------------------------------------------------
# Diagnostics: why is nothing matching?
# ---------------------------------------------------------------------------


def _summarize_skills(tickets: Sequence[_TicketView]) -> tuple[int, int]:
    return (
        min(view.min_skill for view in tickets),
        max(view.max_skill for view in tickets),
    )


def diagnose(
    tickets: Sequence[Ticket],
    now: int,
    *,
    budget: int = 200_000,
    example_limit: int = 6,
) -> dict:
    """Classify six-player ticket combinations by their first failing rule.

    The counts are exact while the scan stays under ``budget``; ``truncated``
    tells the caller that the queue is too large to classify exhaustively.
    """

    views = [_view(ticket, index, now) for index, ticket in enumerate(
        sorted(tickets, key=lambda item: (item.created_at, item.id))
    )]
    reasons = {
        reason: {"count": 0, "label": REASON_LABELS[reason], "examples": []}
        for reason in REASON_ORDER
    }
    queue_members = sum(view.size for view in views)
    queue_tickets = len(views)

    scanned = 0
    valid_combinations = 0
    truncated = False

    for combo in _combination_stream(len(views)):
        if scanned >= budget:
            truncated = True
            break
        scanned += 1
        selected = [views[index] for index in combo]
        if sum(view.size for view in selected) != ROOM_MEMBERS:
            continue

        reason = None
        detail = ""
        sizes = [view.size for view in selected]
        split_exists = _has_split(sizes)
        min_skill, max_skill = _summarize_skills(selected)
        spread = max_skill - min_skill
        min_threshold = min(view.threshold for view in selected)

        if not split_exists:
            reason = REASON_UNSPLITTABLE
            detail = "队伍人数组合 " + " + ".join(str(size) for size in sizes) + " 无法拆成两个三人队"
        elif spread > min_threshold:
            reason = REASON_SPREAD
            limits = ", ".join(
                f"{view.ticket.id}={view.threshold}" for view in selected
            )
            detail = f"六人分差 {spread} 超过最严格的阈值 {min_threshold}（{limits}）"
        else:
            region_details = []
            any_region = False
            for region_index, region in enumerate(REGIONS):
                maxima = [view.region_max_ping[region_index] for view in selected]
                bad = [
                    view.ticket.id
                    for view, value in zip(selected, maxima)
                    if value is None
                ]
                if bad:
                    region_details.append(f"{region}: {', '.join(bad)} 无可用延迟")
                else:
                    any_region = True
                    break
            if not any_region:
                reason = REASON_REGION
                detail = "六人在任何地区都无法同时满足延迟 <= 80：" + "；".join(region_details)

        if reason is None:
            valid_combinations += 1
            continue

        bucket = reasons[reason]
        bucket["count"] += 1
        if len(bucket["examples"]) < example_limit:
            bucket["examples"].append(
                {
                    "ticketIds": [view.ticket.id for view in selected],
                    "detail": detail,
                }
            )

    if queue_members < ROOM_MEMBERS:
        reasons[REASON_INSUFFICIENT]["count"] = 1
        reasons[REASON_INSUFFICIENT]["examples"] = [
            {
                "ticketIds": [view.ticket.id for view in views],
                "detail": f"队列共 {queue_members} 名玩家，至少需要 {ROOM_MEMBERS} 名",
            }
        ]
    elif valid_combinations == 0 and scanned > 0:
        # If no ticket combination holds six players at all, that is an
        # "insufficient players" problem even though the queue may be long.
        has_six = False
        for combo in _combination_stream(len(views)):
            if sum(views[index].size for index in combo) == ROOM_MEMBERS:
                has_six = True
                break
        if not has_six:
            reasons[REASON_INSUFFICIENT]["count"] = 1
            reasons[REASON_INSUFFICIENT]["examples"] = [
                {
                    "ticketIds": [view.ticket.id for view in views],
                    "detail": f"队列有 {queue_members} 名玩家，但票面组合无法凑出恰好 {ROOM_MEMBERS} 人",
                }
            ]

    all_reasons = {reason: bucket["count"] for reason, bucket in reasons.items() if bucket["count"]}
    return {
        "now": now,
        "queueTickets": queue_tickets,
        "queueMembers": queue_members,
        "scannedCombinations": scanned,
        "truncated": truncated,
        "validCombinations": valid_combinations,
        "reasons": reasons,
        "blockingReasons": all_reasons,
    }
