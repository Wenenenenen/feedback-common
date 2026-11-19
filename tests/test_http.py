"""HTTP contract tests: joins, idempotency, cancel rules, ticks, persistence."""

from __future__ import annotations

import unittest

from tests.helpers import (
    RunningServer,
    member,
    party,
    temp_db,
    ticket,
)


class ServerCase(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path, self._dir = temp_db()
        self._server = RunningServer(self.db_path)
        self._server.__enter__()
        self.client = self._server.client
        self.addCleanup(self._server.__exit__, None, None, None)
        self.addCleanup(self._dir.cleanup)

    def join(self, key: str, ticket_id: str, members: list[dict]):
        return self.client.post(
            "/tickets", {"requestKey": key, "id": ticket_id, "members": members}
        )

    def cancel(self, key: str, ticket_id: str):
        return self.client.post("/cancel", {"requestKey": key, "ticketId": ticket_id})

    def tick(self, key: str, now: int):
        return self.client.post("/tick", {"requestKey": key, "now": now})


class JoinTests(ServerCase):
    def test_join_records_server_timestamp(self) -> None:
        self.tick("tick-0", 1500)
        response = self.join("join-1", "t1", party("p", 3, 100))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body["ticket"]["createdAt"], 1500)
        self.assertEqual(response.body["ticket"]["status"], "queued")
        self.assertEqual(response.body["clock"], 1500)

    def test_join_validation(self) -> None:
        cases = [
            ({"requestKey": "k", "id": "t1", "members": []}, "members"),
            ({"requestKey": "k", "id": "t1", "members": party("p", 4, 1)}, "members"),
            ({"requestKey": "k", "id": "", "members": party("p", 1, 1)}, "id"),
            (
                {"requestKey": "k", "id": "t1", "members": [{"id": "a", "skill": "x"}]},
                "skill",
            ),
            (
                {"requestKey": "k", "id": "t1", "members": [member("a", 1, {"r9": 10})]},
                "r9",
            ),
            ({"id": "t1", "members": party("p", 1, 1)}, "requestKey"),
        ]
        for payload, needle in cases:
            with self.subTest(payload=payload):
                response = self.client.post("/tickets", payload)
                self.assertEqual(response.status, 400)
                self.assertIn(needle, response.body["error"]["message"])

    def test_duplicate_ticket_id_is_permanent(self) -> None:
        self.join("join-1", "t1", party("p", 3, 100))
        self.assertEqual(self.cancel("cancel-1", "t1").status, 200)
        # ticketId stays unique even after cancellation.
        second = self.join("join-2", "t1", party("q", 3, 100))
        self.assertEqual(second.status, 409)
        self.assertEqual(second.body["error"]["code"], "ticket_exists")

    def test_member_cannot_be_in_two_active_tickets(self) -> None:
        self.join("join-1", "t1", party("p", 3, 100))
        response = self.join("join-2", "t2", [member("p_0", 100)])
        self.assertEqual(response.status, 409)
        self.assertEqual(response.body["error"]["code"], "member_already_active")

    def test_queue_capacity(self) -> None:
        for index in range(24):
            response = self.join(f"join-{index}", f"t{index}", party(f"p{index}", 1, 100))
            self.assertEqual(response.status, 200)
        overflow = self.join("join-over", "t-over", party("overflow", 1, 100))
        self.assertEqual(overflow.status, 409)
        self.assertEqual(overflow.body["error"]["code"], "queue_full")


class IdempotencyTests(ServerCase):
    def test_same_key_same_payload_replays(self) -> None:
        first = self.join("join-1", "t1", party("p", 3, 100))
        second = self.join("join-1", "t1", party("p", 3, 100))
        self.assertEqual(second.status, 200)
        self.assertEqual(first.body, second.body)
        state = self.client.get("/state").body
        self.assertEqual(len(state["tickets"]), 1)

    def test_key_comparison_ignores_key_order_and_whitespace(self) -> None:
        payload_a = {"requestKey": "join-1", "id": "t1", "members": party("p", 3, 100)}
        payload_b = {
            "id": "t1",
            "members": [
                {"ping": {"r2": 30, "r1": 20}, "skill": 100, "id": f"p_{i}"}
                for i in range(3)
            ],
            "requestKey": "join-1",
        }
        first = self.client.post("/tickets", payload_a)
        second = self.client.post("/tickets", payload_b)
        self.assertEqual(first.status, 200)
        self.assertEqual(second.status, 200)
        self.assertEqual(first.body, second.body)

    def test_same_key_different_payload_conflicts(self) -> None:
        self.join("join-1", "t1", party("p", 3, 100))
        conflict = self.join("join-1", "t2", party("q", 3, 100))
        self.assertEqual(conflict.status, 409)
        self.assertEqual(conflict.body["error"]["code"], "request_key_conflict")
        # ... and the original result is untouched.
        replayed = self.client.get("/requests/join-1")
        self.assertEqual(replayed.status, 200)
        self.assertEqual(replayed.body["payload"]["id"], "t1")

    def test_key_reuse_across_route_conflicts(self) -> None:
        self.join("shared", "t1", party("p", 3, 100))
        response = self.cancel("shared", "t1")
        self.assertEqual(response.status, 409)
        self.assertEqual(response.body["error"]["code"], "request_key_conflict")

    def test_failed_operation_leaves_no_request_record(self) -> None:
        response = self.join("join-1", "t1", [])
        self.assertEqual(response.status, 400)
        self.assertEqual(self.client.get("/requests/join-1").status, 404)

    def test_tick_and_cancel_replay(self) -> None:
        self.tick("tick-1", 0)
        first = self.tick("tick-1", 0)
        self.assertEqual(first.status, 200)
        self.assertEqual(first.body["roomIds"], [])

        self.join("join-1", "t1", party("p", 3, 100))
        cancel_first = self.cancel("cancel-1", "t1")
        cancel_again = self.cancel("cancel-1", "t1")
        self.assertEqual(cancel_first.body, cancel_again.body)
        self.assertEqual(cancel_again.body["alreadyCancelled"], False)

    def test_requests_listing(self) -> None:
        self.join("join-1", "t1", party("p", 3, 100))
        self.tick("tick-1", 0)
        listing = self.client.get("/requests?limit=10").body["requests"]
        self.assertEqual([row["requestKey"] for row in listing], ["tick-1", "join-1"])


class CancelTests(ServerCase):
    def test_cancel_queued_ticket(self) -> None:
        self.join("join-1", "t1", party("p", 3, 100))
        response = self.cancel("cancel-1", "t1")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body["ticket"]["status"], "cancelled")

    def test_cancel_cancelled_ticket_is_terminal_noop(self) -> None:
        self.join("join-1", "t1", party("p", 3, 100))
        self.cancel("cancel-1", "t1")
        again = self.cancel("cancel-2", "t1")
        self.assertEqual(again.status, 200)
        self.assertTrue(again.body["alreadyCancelled"])
        self.assertEqual(again.body["cancelledBy"], "cancel-1")
        # A distinct key produced a distinct request record.
        self.assertEqual(self.client.get("/requests/cancel-2").status, 200)

    def test_cancel_matched_ticket_is_409(self) -> None:
        self.join("join-1", "t1", party("p", 3, 100))
        self.join("join-2", "t2", party("q", 3, 100))
        tick = self.tick("tick-1", 0)
        self.assertEqual(len(tick.body["roomIds"]), 1)
        response = self.cancel("cancel-1", "t1")
        self.assertEqual(response.status, 409)
        self.assertEqual(response.body["error"]["code"], "ticket_already_matched")

    def test_cancel_unknown_ticket_is_404(self) -> None:
        response = self.cancel("cancel-1", "nope")
        self.assertEqual(response.status, 404)


class TickTests(ServerCase):
    def test_tick_creates_room_and_marks_tickets(self) -> None:
        self.join("join-1", "t1", party("p", 3, 100))
        self.join("join-2", "t2", party("q", 3, 100))
        response = self.tick("tick-1", 0)
        self.assertEqual(response.status, 200)
        self.assertEqual(len(response.body["roomsCreated"]), 1)
        room = response.body["roomsCreated"][0]
        self.assertEqual(room["roomId"], 1)
        self.assertEqual(room["region"], "r1")
        self.assertEqual(room["ticketIds"], ["t1", "t2"])
        state = self.client.get("/state").body
        statuses = {item["id"]: item for item in state["tickets"]}
        self.assertEqual(statuses["t1"]["status"], "matched")
        self.assertEqual(statuses["t1"]["roomId"], 1)

    def test_room_ids_increment_across_ticks(self) -> None:
        for round_index in range(2):
            base = round_index * 2
            self.join(f"join-{base}", f"t{base}", party(f"p{base}", 3, 100))
            self.join(f"join-{base + 1}", f"t{base + 1}", party(f"p{base + 1}", 3, 100))
            tick = self.tick(f"tick-{round_index}", round_index * 1000)
            self.assertEqual(tick.body["roomIds"], [round_index + 1])

    def test_clock_never_moves_backwards(self) -> None:
        self.tick("tick-1", 5000)
        response = self.tick("tick-2", 4999)
        self.assertEqual(response.status, 409)
        self.assertEqual(response.body["error"]["code"], "clock_regression")
        self.assertEqual(self.client.get("/state").body["clock"], 5000)

    def test_tick_ignores_cancelled_tickets(self) -> None:
        self.join("join-1", "t1", party("p", 3, 100))
        self.join("join-2", "t2", party("q", 3, 100))
        self.cancel("cancel-1", "t1")
        tick = self.tick("tick-1", 0)
        self.assertEqual(tick.body["roomIds"], [])

    def test_multiple_rooms_in_one_tick(self) -> None:
        for index in range(4):
            self.join(f"join-{index}", f"t{index}", party(f"p{index}", 3, 100))
        tick = self.tick("tick-1", 0)
        self.assertEqual(tick.body["roomIds"], [1, 2])

    def test_debug_candidates_show_order_and_diagnosis(self) -> None:
        for index in range(3):
            self.join(f"join-{index}", f"t{index}", party(f"p{index}", 3, 100))
        # 3 ticket pairs x 2 usable regions (r1 and r2 both <= 80).
        debug = self.client.get("/debug/candidates?limit=10").body
        self.assertEqual(len(debug["candidates"]), 6)
        keys = [row["sortKey"] for row in debug["candidates"]]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(debug["candidates"][0]["ticketIds"], ["t0", "t1"])
        self.assertEqual(debug["diagnosis"]["validCombinations"], 3)

    def test_debug_candidates_paging(self) -> None:
        for index in range(3):
            self.join(f"join-{index}", f"t{index}", party(f"p{index}", 3, 100))
        page1 = self.client.get("/debug/candidates?offset=0&limit=2").body
        page2 = self.client.get("/debug/candidates?offset=2&limit=2").body
        page3 = self.client.get("/debug/candidates?offset=4&limit=2").body
        self.assertEqual(len(page1["candidates"]), 2)
        self.assertEqual(len(page2["candidates"]), 2)
        self.assertEqual(len(page3["candidates"]), 2)
        self.assertEqual(page1["candidates"][0]["index"], 0)
        self.assertEqual(page2["candidates"][0]["index"], 2)

    def test_debug_reports_blocking_reason(self) -> None:
        for index in range(3):
            self.join(f"join-{index}", f"t{index}", party(f"p{index}", 2, 100))
        debug = self.client.get("/debug/candidates").body
        self.assertEqual(debug["candidates"], [])
        self.assertIn("party_unsplittable", debug["diagnosis"]["blockingReasons"])


class PersistenceTests(unittest.TestCase):
    def test_state_and_requests_survive_restart(self) -> None:
        db_path, directory = temp_db()
        self.addCleanup(directory.cleanup)

        with RunningServer(db_path) as first:
            first.client.post(
                "/tickets", {"requestKey": "join-1", "id": "t1", "members": party("p", 3, 100)}
            )
            first.client.post(
                "/tickets", {"requestKey": "join-2", "id": "t2", "members": party("q", 3, 100)}
            )
            first.client.post("/tick", {"requestKey": "tick-1", "now": 0})
            room_result = first.client.get("/requests/tick-1").body
            state_result = first.client.get("/state").body

        with RunningServer(db_path) as second:
            self.assertEqual(second.client.get("/requests/tick-1").body, room_result)
            self.assertEqual(second.client.get("/state").body, state_result)
            # Idempotent replay still works after restart.
            replay = second.client.post(
                "/tickets", {"requestKey": "join-1", "id": "t1", "members": party("p", 3, 100)}
            )
            self.assertEqual(replay.status, 200)
            # Room ids continue to increase.
            second.client.post(
                "/tickets", {"requestKey": "join-3", "id": "t3", "members": party("r", 3, 100)}
            )
            second.client.post(
                "/tickets", {"requestKey": "join-4", "id": "t4", "members": party("s", 3, 100)}
            )
            tick = second.client.post("/tick", {"requestKey": "tick-2", "now": 10})
            self.assertEqual(tick.body["roomIds"], [2])


if __name__ == "__main__":
    unittest.main()
