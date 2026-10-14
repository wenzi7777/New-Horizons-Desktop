"""A Hub-relayed update as the device settings card sees it.

The card reads the last status's update_state first. An apply_update reply
must land there too, or the "ready" a previous Check left behind hides the
transfer (and the card never starts polling its progress).
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402

UID = "80456B76AAF4"


class RelayedUpdateStateTests(unittest.TestCase):
    def setUp(self):
        self.service = NewHorizonsService(mock_mode=False)
        # The status after a Check: beta.4 is available.
        self.service._record_result(UID, {"command": "status", "status": "ok", "ok": True, "data": {
            "firmware_version": "v1.15.0-beta.3", "mode": "normal",
            "update_state": {"phase": "ready", "operation": "check_update", "available": True,
                             "version": "v1.15.0-beta.4", "transport": "espnow_relay"}}})

    def card_state(self):
        return self.service.get_device(UID)["last_status"]["update_state"]

    def test_apply_replaces_the_ready_left_by_the_check(self):
        self.assertEqual(self.card_state()["phase"], "ready")
        # What a Direct-mode device answers to apply_update, relayed by a Hub.
        self.service._record_result(UID, {
            "command": "apply_update", "status": "ok", "ok": True, "message": "update_started",
            "data": {"update_state": {"phase": "checking", "operation": "apply_update", "available": False,
                                      "version": "", "transport": "espnow_relay"}}})
        self.assertEqual(self.card_state()["phase"], "checking")
        self.assertEqual(self.card_state()["operation"], "apply_update")

    def test_a_status_during_the_transfer_carries_its_progress(self):
        self.service._record_result(UID, {"command": "status", "status": "ok", "ok": True, "data": {
            "firmware_version": "v1.15.0-beta.3",
            "update_state": {"phase": "downloading", "operation": "apply_update", "version": "v1.15.0-beta.4",
                             "total_chunks": 425, "applied_chunks": 120, "transport": "espnow_relay"}}})
        state = self.card_state()
        self.assertEqual((state["phase"], state["applied_chunks"], state["total_chunks"]), ("downloading", 120, 425))


if __name__ == "__main__":
    unittest.main()
