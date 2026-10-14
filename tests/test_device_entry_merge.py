"""Fields written by two sources must not flicker between them."""

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402


class FindMeMergeTest(unittest.TestCase):
    def test_relay_and_device_blocks_are_merged_not_swapped(self):
        # Device status knows the port and heartbeat interval; the Gateway's
        # snapshot knows its claim. Alternating whole-block replacement made
        # half of the FindMe card appear and vanish every few seconds.
        device = {"findme": {"state": "attached", "gateway_id": "gw1", "udp_port": 13250, "heartbeat_interval_ms": 5000}}
        relay = {"findme": {"state": "attached", "gateway_id": "gw1", "claim_id": "c1"}}
        merged = NewHorizonsService._merge_device_entry(device, relay)
        self.assertEqual(merged["findme"]["udp_port"], 13250)
        self.assertEqual(merged["findme"]["heartbeat_interval_ms"], 5000)
        self.assertEqual(merged["findme"]["claim_id"], "c1")
        again = NewHorizonsService._merge_device_entry(merged, device)
        self.assertEqual(again["findme"]["claim_id"], "c1")

    def test_the_device_can_still_clear_a_field(self):
        before = {"findme": {"state": "attached", "gateway_id": "gw1"}}
        after = NewHorizonsService._merge_device_entry(before, {"findme": {"state": "idle", "gateway_id": ""}})
        self.assertEqual(after["findme"], {"state": "idle", "gateway_id": ""})

    def test_a_hub_snapshot_does_not_write_findme(self):
        # NewHorizonsService's relay handling lives in its gateway_registry mixin.
        source = (BACKEND_ROOT / "newhorizons_backend" / "gateway_registry.py").read_text(encoding="utf-8")
        presence = source[source.index("def _record_gateway_device_presence_locked"):]
        presence = presence[: presence.index("\n    def ", 10)]
        self.assertIn('get("client_type") == "hub"', presence)


class RelayedUpdateTest(unittest.TestCase):
    def test_a_direct_mode_check_reply_reads_as_checking(self):
        # The ESP-NOW reply only starts the check; its idle, version-less
        # state used to blank out the update card.
        payload = {
            "command": "check_update",
            "message": "update_check_started",
            "data": {"update_state": {"phase": "idle", "version": "", "operation": "check_update"}},
        }
        NewHorizonsService._mark_relayed_update_started(payload)
        state = payload["data"]["update_state"]
        self.assertEqual(state["phase"], "checking")
        self.assertNotIn("version", state)

    def test_apply_reads_as_starting_and_other_replies_are_untouched(self):
        payload = {"message": "update_started", "update_state": {"phase": "idle"}}
        NewHorizonsService._mark_relayed_update_started(payload)
        self.assertEqual(payload["update_state"]["phase"], "starting")
        wifi = {"message": "update_checked", "data": {"update_state": {"phase": "ready", "version": "v1.13.0"}}}
        NewHorizonsService._mark_relayed_update_started(wifi)
        self.assertEqual(wifi["data"]["update_state"], {"phase": "ready", "version": "v1.13.0"})


if __name__ == "__main__":
    unittest.main()
