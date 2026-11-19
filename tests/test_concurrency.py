"""Concurrency tests: cancel racing a tick, and no player ever in two rooms.

The race we care about is: a ticket is queued, a ``/tick`` is about to place it
in a room, and a ``/cancel`` for the same ticket arrives at the same moment.
Exactly one outcome is legal:

* the cancel committed first -> the ticket is cancelled and gets no room;
* the tick committed first   -> the ticket is matched and the cancel is 409.

Under no interleaving may a ticket be *both* cancelled and matched, or appear in
two rooms.
"""

from __future__ import annotations

import json
import threading
import unittest

from tests.helpers import RunningServer, member, party, temp_db


class RaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path, self._dir = temp_db()
        self._server = RunningServer(self.db_path)
        self._server.__enter__()
        self.client = self._server.client
        self.addCleanup(self._server.__exit__, None, None, None)
        self.addCleanup(self._dir.cleanup)
        # Keep the test log readable; only interesting failures are printed.
        self._server.server.RequestHandlerClass.log_message = lambda *a, **k: None

    def join(self, key: str, ticket_id: str, members: list[dict]):
        return self.client.post(
            "/tickets", {"requestKey": key, "id": ticket_id, "members": members}
        )

    def test_cancel_and_tick_race_is_atomic(self) -> None:
        """Run many cancel/tick races and check the invariant every time."""

        for attempt in range(20):
            ticket_id = f"race-{attempt}"
            self.join(f"join-{attempt}", ticket_id, party(f"p{attempt}", 3, 100))
            self.join(f"join-peer-{attempt}", f"peer-{attempt}", party(f"q{attempt}", 3, 100))

            start = threading.Barrier(2)
            results: dict[str, object] = {}

            def do_cancel() -> None:
                start.wait()
                results["cancel"] = self.client.post(
                    "/cancel", {"requestKey": f"cancel-{attempt}", "ticketId": ticket_id}
                )

            def do_tick() -> None:
                start.wait()
                results["tick"] = self.client.post(
                    "/tick", {"requestKey": f"tick-{attempt}", "now": attempt}
                )

            threads = [threading.Thread(target=do_cancel), threading.Thread(target=do_tick)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            cancel_status = results["cancel"].status
            tick_status = results["tick"].status
            self.assertEqual(tick_status, 200)

            state = self.client.get("/state").body
            ticket = next(t for t in state["tickets"] if t["id"] == ticket_id)
            in_rooms = sorted(
                {
                    room["roomId"]
                    for room in state["rooms"]
                    for member_id in room["teamA"] + room["teamB"]
                    if member_id.startswith(f"p{attempt}_")
                }
            )

            if cancel_status == 200:
                # Cancel won the race: ticket must be cancelled and matchless.
                self.assertEqual(ticket["status"], "cancelled", state)
                self.assertEqual(in_rooms, [], state)
                self.assertNotIn("roomId", ticket)
            else:
                # Tick won the race: cancel must be rejected as 409.
                self.assertEqual(cancel_status, 409, (ticket, state))
                self.assertEqual(ticket["status"], "matched", state)
                self.assertEqual(len(in_rooms), 1, state)
                self.assertEqual(in_rooms[0], ticket.get("roomId"))

    def test_cancel_after_match_never_releases_room(self) -> None:
        self.join("join-1", "t1", party("p", 3, 100))
        self.join("join-2", "t2", party("q", 3, 100))
        self.client.post("/tick", {"requestKey": "tick-1", "now": 0})
        for index in range(3):
            response = self.client.post(
                "/cancel", {"requestKey": f"cancel-{index}", "ticketId": "t1"}
            )
            self.assertEqual(response.status, 409)
        state = self.client.get("/state").body
        self.assertEqual(len(state["rooms"]), 1)
        self.assertEqual(sum(1 for t in state["tickets"] if t["status"] == "matched"), 2)

    def test_concurrent_ticks_never_double_book(self) -> None:
        """Two ticks racing over the same queue must not place a ticket twice."""

        for index in range(8):
            self.join(f"join-{index}", f"t{index}", party(f"p{index}", 3, 100))

        results = []

        def run(now: int) -> None:
            results.append(
                self.client.post("/tick", {"requestKey": f"tick-{now}", "now": now})
            )

        threads = [threading.Thread(target=run, args=(now,)) for now in (0, 0, 1, 1)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        state = self.client.get("/state").body
        # Every player appears in at most one room.
        seen: dict[str, int] = {}
        for room in state["rooms"]:
            for member_id in room["teamA"] + room["teamB"]:
                self.assertNotIn(member_id, seen, f"{member_id} 出现在两个房间")
                seen[member_id] = room["roomId"]

        matched = [t for t in state["tickets"] if t["status"] == "matched"]
        self.assertEqual(len(state["rooms"]), 4)  # 8 tickets x 3 players = 4 rooms
        self.assertEqual(len(matched), 8)
        for ticket in matched:
            self.assertIn(ticket["roomId"], [r["roomId"] for r in state["rooms"]])

    def test_concurrent_joins_do_not_exceed_capacity(self) -> None:
        statuses = []
        lock = threading.Lock()
        barrier = threading.Barrier(30)

        def run(index: int) -> None:
            barrier.wait()
            response = self.client.post(
                "/tickets",
                {
                    "requestKey": f"join-{index}",
                    "id": f"t{index}",
                    "members": party(f"p{index}", 1, 100),
                },
            )
            with lock:
                statuses.append(response.status)

        threads = [threading.Thread(target=run, args=(i,)) for i in range(30)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        state = self.client.get("/state").body
        queued = [t for t in state["tickets"] if t["status"] == "queued"]
        self.assertEqual(len(queued), 24)
        self.assertEqual(statuses.count(200), 24)
        self.assertEqual(statuses.count(409), 6)

    def test_concurrent_same_key_join_runs_once(self) -> None:
        results = []
        lock = threading.Lock()
        barrier = threading.Barrier(10)

        def run(index: int) -> None:
            barrier.wait()
            response = self.client.post(
                "/tickets",
                {
                    "requestKey": "same-key",
                    "id": "t-same",
                    "members": party("p", 3, 100),
                },
            )
            with lock:
                results.append(response)

        threads = [threading.Thread(target=run, args=(i,)) for i in range(10)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertTrue(all(response.status == 200 for response in results), results)
        bodies = {json.dumps(response.body, sort_keys=True) for response in results}
        self.assertEqual(len(bodies), 1, "同一 requestKey 的并发重试返回了不同结果")
        state = self.client.get("/state").body
        self.assertEqual(len(state["tickets"]), 1)


if __name__ == "__main__":
    unittest.main()
