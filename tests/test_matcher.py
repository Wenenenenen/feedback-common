"""Matching-engine tests: rules, ordering and diagnostics."""

from __future__ import annotations

import json
import os
import unittest

from tests.helpers import member, party, ticket

from pma import matcher
from pma.model import Member, Ticket


def make_ticket(ticket_id: str, members: list[dict], created_at: int = 0) -> Ticket:
    return Ticket(
        id=ticket_id,
        created_at=created_at,
        members=tuple(
            Member(id=m["id"], skill=m["skill"], ping=dict(m["ping"])) for m in members
        ),
    )


def load_samples() -> list[dict]:
    archive_dir = os.environ.get("PMA_SAMPLES_DIR")
    if not archive_dir:
        return []
    path = os.path.join(archive_dir, "cases.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


class ThresholdTests(unittest.TestCase):
    def test_threshold_ramp_and_cap(self) -> None:
        self.assertEqual(matcher.threshold_for(0, 0), 100)
        self.assertEqual(matcher.threshold_for(0, 999), 100)
        self.assertEqual(matcher.threshold_for(0, 1000), 110)
        self.assertEqual(matcher.threshold_for(0, 5000), 150)
        self.assertEqual(matcher.threshold_for(0, 30_000), 400)
        self.assertEqual(matcher.threshold_for(0, 10_000_000), 400)

    def test_threshold_is_per_ticket(self) -> None:
        # A ticket created at t=10000 is stricter than one created at t=0.
        self.assertEqual(matcher.threshold_for(10_000, 10_000), 100)


class SampleCaseTests(unittest.TestCase):
    def test_bundled_samples(self) -> None:
        cases = load_samples()
        if not cases:
            self.skipTest("set PMA_SAMPLES_DIR to the extracted samples directory")
        for case in cases:
            with self.subTest(case=case["name"]):
                tickets = [
                    make_ticket(t["id"], t["members"], t.get("createdAt", 0))
                    for t in case["tickets"]
                ]
                rooms = matcher.run_matching(tickets, case["now"])
                expected = case.get("expected")
                if expected is None:
                    self.assertEqual(rooms, [], case["name"])
                    continue
                self.assertEqual(len(rooms), 1, case["name"])
                room = rooms[0]
                self.assertEqual(list(room.ticket_ids), expected["ticketIds"])
                self.assertEqual(room.region, expected["region"])
                if "teamA" in expected:
                    self.assertEqual(list(room.team_a), expected["teamA"])
                if "skillDifference" in expected:
                    self.assertEqual(room.skill_difference, expected["skillDifference"])


class RuleTests(unittest.TestCase):
    def test_parties_never_split(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 100)),
            make_ticket("b", party("b", 3, 100)),
        ]
        rooms = matcher.run_matching(tickets, 0)
        self.assertEqual(len(rooms), 1)
        self.assertEqual(rooms[0].ticket_ids, ("a", "b"))

    def test_three_doubles_cannot_form_room(self) -> None:
        tickets = [
            make_ticket("a", party("a", 2, 100)),
            make_ticket("b", party("b", 2, 100)),
            make_ticket("c", party("c", 2, 100)),
        ]
        self.assertEqual(matcher.run_matching(tickets, 0), [])
        report = matcher.diagnose(tickets, 0)
        self.assertEqual(report["blockingReasons"], {matcher.REASON_UNSPLITTABLE: 1})

    def test_single_and_double_can_mix(self) -> None:
        tickets = [
            make_ticket("a", party("a", 1, 100)),
            make_ticket("b", party("b", 2, 100)),
            make_ticket("c", party("c", 3, 100)),
        ]
        rooms = matcher.run_matching(tickets, 0)
        self.assertEqual(len(rooms), 1)
        self.assertEqual(rooms[0].ticket_ids, ("a", "b", "c"))

    def test_three_doubles_with_two_singles(self) -> None:
        # 2+2+2 cannot split, but 2+2+1+1 can (2+1 vs 2+1).
        tickets = [
            make_ticket("a", party("a", 2, 100)),
            make_ticket("b", party("b", 2, 100)),
            make_ticket("c", party("c", 2, 100)),
            make_ticket("d", party("d", 1, 100)),
            make_ticket("e", party("e", 1, 100)),
        ]
        rooms = matcher.run_matching(tickets, 0)
        self.assertEqual(len(rooms), 1)
        self.assertEqual(rooms[0].ticket_ids, ("a", "b", "d", "e"))

    def test_ping_limit_is_strict(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 100, {"r1": 80} )),
            make_ticket("b", party("b", 3, 100, {"r1": 81})),
        ]
        self.assertEqual(matcher.run_matching(tickets, 0), [])

    def test_missing_region_is_unavailable(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 100, {"r2": 20})),
            make_ticket("b", party("b", 3, 100, {"r2": 20})),
        ]
        rooms = matcher.run_matching(tickets, 0)
        self.assertEqual(rooms[0].region, "r2")

    def test_region_prefers_lower_ping(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 100, {"r1": 40, "r2": 20})),
            make_ticket("b", party("b", 3, 100, {"r1": 40, "r2": 20})),
        ]
        rooms = matcher.run_matching(tickets, 0)
        self.assertEqual(rooms[0].region, "r2")

    def test_region_name_tiebreak(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 100, {"r1": 20, "r2": 20, "r3": 20})),
            make_ticket("b", party("b", 3, 100, {"r1": 20, "r2": 20, "r3": 20})),
        ]
        rooms = matcher.run_matching(tickets, 0)
        self.assertEqual(rooms[0].region, "r1")

    def test_spread_uses_most_strict_threshold(self) -> None:
        # t1 created at 0 (threshold 400 at now=30000); t2 created at 30000
        # (threshold 100).  Spread 150 > 100, so no room.
        tickets = [
            make_ticket("a", party("a", 3, 100), created_at=0),
            make_ticket("b", party("b", 3, 250), created_at=30_000),
        ]
        self.assertEqual(matcher.run_matching(tickets, 30_000), [])
        # Once t2 has waited, the room appears at its relaxed threshold.
        self.assertEqual(
            len(matcher.run_matching(tickets, 35_000)),
            1,
        )


class OrderingTests(unittest.TestCase):
    def test_ticket_sequence_beats_skill_difference(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 0)),
            make_ticket("b", party("b", 3, 100)),
            make_ticket("c", party("c", 3, 100)),
        ]
        rooms = matcher.run_matching(tickets, 1000)
        self.assertEqual(rooms[0].ticket_ids, ("a", "b"))
        self.assertEqual(rooms[0].skill_difference, 300)

    def test_ticket_sequence_beats_skill_difference_in_multi_ticket_rooms(self) -> None:
        # Ticket order dominates: a+b+c (earliest) wins even though a+d/e would
        # be possible later in the sequence.
        tickets = [
            make_ticket("a", party("a", 1, 100)),
            make_ticket("b", party("b", 2, 100)),
            make_ticket("c", party("c", 3, 100)),
            make_ticket("d", party("d", 1, 100)),
            make_ticket("e", party("e", 2, 100)),
            make_ticket("f", party("f", 3, 100)),
        ]
        rooms = matcher.run_matching(tickets, 0)
        self.assertEqual(len(rooms), 2)
        self.assertEqual(rooms[0].ticket_ids, ("a", "b", "c"))
        self.assertEqual(rooms[1].ticket_ids, ("d", "e", "f"))

    def test_earliest_ticket_always_participates(self) -> None:
        tickets = [
            make_ticket("z", party("z", 3, 100), created_at=5),
            make_ticket("y", party("y", 3, 100), created_at=1),
            make_ticket("x", party("x", 3, 100), created_at=3),
        ]
        rooms = matcher.run_matching(tickets, 1000)
        self.assertEqual(rooms[0].ticket_ids, ("y", "x"))

    def test_team_composition_affects_key(self) -> None:
        # Two doubles + two singles can split multiple ways; the key compares
        # team A's sorted member ids, so the lexicographically smaller team is A.
        tickets = [
            make_ticket("a", party("a", 2, 100)),
            make_ticket("b", party("b", 1, 100)),
            make_ticket("c", party("c", 2, 100)),
            make_ticket("d", party("d", 1, 100)),
        ]
        rooms = matcher.run_matching(tickets, 0)
        room = rooms[0]
        self.assertLessEqual(room.team_a, room.team_b)
        self.assertEqual(sorted(room.team_a + room.team_b), sorted(
            m.id for t in tickets for m in t.members
        ))

    def test_multiple_rooms_from_one_tick(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 100)),
            make_ticket("b", party("b", 3, 100)),
            make_ticket("c", party("c", 3, 100)),
            make_ticket("d", party("d", 3, 100)),
            make_ticket("e", party("e", 3, 100)),
        ]
        rooms = matcher.run_matching(tickets, 0)
        self.assertEqual([room.ticket_ids for room in rooms], [("a", "b"), ("c", "d")])

    def test_candidate_stream_is_sorted(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 100, {"r1": 20, "r2": 40})),
            make_ticket("b", party("b", 3, 100, {"r1": 20, "r2": 40})),
            make_ticket("c", party("c", 3, 120, {"r1": 30, "r2": 20})),
            make_ticket("d", party("d", 3, 120, {"r1": 30, "r2": 20})),
        ]
        candidates = list(matcher.iter_candidates(tickets, 0))
        keys = [candidate.sort_key for candidate in candidates]
        self.assertEqual(keys, sorted(keys))
        first = matcher.best_candidate(tickets, 0)
        self.assertEqual(first.sort_key, keys[0])

    def test_split_choice_ordered_by_skill_then_team_ids(self) -> None:
        # Same ticket combination, two possible splits.  The six skills are
        # 100,100 / 100,100 / 100,100 in players, so hand-craft an asymmetric
        # shape: 2+2+1+1 where the singles differ.
        tickets = [
            make_ticket("a", [member("a0", 100, {"r1": 20}), member("a1", 100, {"r1": 20})]),
            make_ticket("b", [member("b0", 100, {"r1": 20}), member("b1", 100, {"r1": 20})]),
            make_ticket("c", [member("c0", 100, {"r1": 20})]),
            make_ticket("d", [member("d0", 100, {"r1": 20})]),
        ]
        candidates = list(matcher.iter_candidates(tickets, 0))
        # Expect exactly two legal splits: {a,c} vs {b,d} and {a,d} vs {b,c}.
        splits = {frozenset(candidate.ticket_ids) for candidate in candidates}
        self.assertEqual(splits, {frozenset({"a", "b", "c", "d"})})
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates, sorted(candidates, key=lambda c: c.sort_key))
        # team A is the lexicographically smaller sorted id tuple, so the
        # first candidate is deterministic.
        self.assertEqual(candidates[0].team_a, ("a0", "a1", "c0"))

    def test_paging_matches_full_list(self) -> None:
        tickets = [
            make_ticket(chr(ord("a") + i), party(chr(ord("a") + i), 3, 100 + i * 10))
            for i in range(6)
        ]
        full = list(matcher.iter_candidates(tickets, 0))
        page_one, truncated_one = matcher.list_candidates(tickets, 0, offset=0, limit=3)
        page_two, truncated_two = matcher.list_candidates(tickets, 0, offset=3, limit=3)
        self.assertFalse(truncated_one or truncated_two)
        self.assertEqual(page_one, full[:3])
        self.assertEqual(page_two, full[3:6])


class DiagnosisTests(unittest.TestCase):
    def test_insufficient_players(self) -> None:
        tickets = [make_ticket("a", party("a", 3, 100)), make_ticket("b", party("b", 2, 100))]
        report = matcher.diagnose(tickets, 0)
        self.assertIn(matcher.REASON_INSUFFICIENT, report["blockingReasons"])

    def test_unavailable_region(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 100, {"r1": 90, "r2": 90})),
            make_ticket("b", party("b", 3, 100, {"r1": 20, "r2": 90})),
        ]
        report = matcher.diagnose(tickets, 0)
        self.assertEqual(report["blockingReasons"], {matcher.REASON_REGION: 1})
        self.assertIn("r1", report["reasons"][matcher.REASON_REGION]["examples"][0]["detail"])

    def test_spread_report(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 0)),
            make_ticket("b", party("b", 3, 500)),
        ]
        report = matcher.diagnose(tickets, 0)
        self.assertIn(matcher.REASON_SPREAD, report["blockingReasons"])

    def test_report_never_classifies_legal_rooms(self) -> None:
        tickets = [
            make_ticket("a", party("a", 3, 100)),
            make_ticket("b", party("b", 3, 100)),
        ]
        report = matcher.diagnose(tickets, 0)
        self.assertEqual(report["validCombinations"], 1)
        self.assertEqual(report["blockingReasons"], {})


if __name__ == "__main__":
    unittest.main()
