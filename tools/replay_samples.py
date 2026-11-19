#!/usr/bin/env python3
"""Replay the bundled sample archive against the real service.

Usage::

    python3 tools/replay_samples.py samples/party-match-allocator-cases.zip

The archive is untrusted input: it is extracted into a fresh temporary
directory and only read as JSON.  Nothing from it is imported or executed.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from pma import matcher  # noqa: E402
from pma.model import Member, Ticket  # noqa: E402


def build_ticket(raw: dict) -> Ticket:
    return Ticket(
        id=raw["id"],
        created_at=raw.get("createdAt", 0),
        members=tuple(
            Member(id=m["id"], skill=m["skill"], ping=dict(m["ping"]))
            for m in raw["members"]
        ),
    )


def extract_archive(path: str) -> str:
    target = tempfile.mkdtemp(prefix="pma-samples-")
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            name = os.path.basename(info.filename)
            if not name or info.is_dir():
                continue
            # Flatten to the temp dir: never honour paths from the archive.
            with archive.open(info) as source, open(
                os.path.join(target, name), "wb"
            ) as sink:
                sink.write(source.read())
    return target


def run_cases(directory: str) -> tuple[int, int]:
    path = os.path.join(directory, "cases.json")
    if not os.path.exists(path):
        print("cases.json 不存在，跳过")
        return 0, 0
    with open(path, encoding="utf-8") as handle:
        cases = json.load(handle)

    passed = failed = 0
    for case in cases:
        tickets = [build_ticket(raw) for raw in case["tickets"]]
        rooms = matcher.run_matching(tickets, case["now"])
        expected = case.get("expected")
        problems: list[str] = []

        if expected is None:
            if rooms:
                problems.append(f"期望无房间，实际 {len(rooms)} 个")
        else:
            if len(rooms) != 1:
                problems.append(f"期望 1 个房间，实际 {len(rooms)} 个")
            else:
                room = rooms[0]
                if list(room.ticket_ids) != expected["ticketIds"]:
                    problems.append(
                        f"票 {list(room.ticket_ids)} != {expected['ticketIds']}"
                    )
                if room.region != expected["region"]:
                    problems.append(f"地区 {room.region} != {expected['region']}")
                if "teamA" in expected and list(room.team_a) != expected["teamA"]:
                    problems.append(f"A 队 {list(room.team_a)} != {expected['teamA']}")
                if (
                    "skillDifference" in expected
                    and room.skill_difference != expected["skillDifference"]
                ):
                    problems.append(
                        f"实力差 {room.skill_difference} != {expected['skillDifference']}"
                    )

        if problems:
            failed += 1
            print(f"FAIL  {case['name']}")
            for problem in problems:
                print(f"      - {problem}")
        else:
            passed += 1
            print(f"ok    {case['name']}")
    return passed, failed


def run_stress(directory: str) -> tuple[int, int]:
    path = os.path.join(directory, "stress.json")
    if not os.path.exists(path):
        print("stress.json 不存在，跳过")
        return 0, 0
    with open(path, encoding="utf-8") as handle:
        scenario = json.load(handle)
    tickets = [build_ticket(raw) for raw in scenario["tickets"]]
    rooms = matcher.run_matching(tickets, scenario["now"])
    placed = sum(len(room.ticket_ids) for room in rooms)
    used_members: list[str] = []
    for room in rooms:
        used_members.extend(room.team_a + room.team_b)
    problems = []
    if len(set(used_members)) != len(used_members):
        problems.append("同一玩家出现在多个房间")
    if any(len(room.team_a) != 3 or len(room.team_b) != 3 for room in rooms):
        problems.append("存在不是 3v3 的房间")
    print(
        f"stress: {len(tickets)} 张票 / {sum(t.size for t in tickets)} 名玩家 "
        f"-> {len(rooms)} 个房间（{placed} 张票）"
    )
    for room in rooms:
        print(
            f"      房间 {room.region}: {list(room.ticket_ids)} "
            f"分差 {room.skill_difference} 延迟 {room.max_ping}"
        )
    if problems:
        for problem in problems:
            print(f"FAIL  {problem}")
        return 0, 1
    return 1, 0


def main(argv: list[str]) -> int:
    archive = (
        argv[1]
        if len(argv) > 1
        else os.path.join(ROOT, "samples", "party-match-allocator-cases.zip")
    )
    if not os.path.exists(archive):
        print(f"找不到样例包 {archive}")
        return 2
    directory = extract_archive(archive)
    passed, failed = run_cases(directory)
    s_passed, s_failed = run_stress(directory)
    print(f"\n合计: {passed + s_passed} 通过, {failed + s_failed} 失败")
    return 0 if failed + s_failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
