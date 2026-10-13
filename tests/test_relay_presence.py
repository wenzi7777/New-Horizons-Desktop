"""A device behind a relay is only "alive" when it answered itself."""

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402


class RelayPresenceTest(unittest.TestCase):
    def test_a_real_answer_counts(self):
        self.assertTrue(NewHorizonsService._payload_is_live({"status": "ok", "message": "status"}, "result"))
        self.assertTrue(NewHorizonsService._payload_is_live({}, "status"))

    def test_relay_generated_failures_do_not(self):
        # A Hub/Gateway answering for a powered-off device kept it "online"
        # while any page polled it.
        for code in ("command_delivery_timeout", "result_page_timeout", "device_not_connected_to_hub"):
            with self.subTest(code=code):
                self.assertFalse(NewHorizonsService._payload_is_live({"status": "error", "message": code}, "result"))
        self.assertFalse(NewHorizonsService._payload_is_live({"error": "command_delivery_timeout"}, "result"))

    def test_an_explicit_flag_wins(self):
        self.assertFalse(NewHorizonsService._payload_is_live({"live_seen": False, "message": "status"}, "result"))
        self.assertTrue(NewHorizonsService._payload_is_live({"live_seen": True}, "update_progress"))

    def test_a_device_error_is_still_an_answer(self):
        # The device itself refusing a command proves it is there.
        self.assertTrue(NewHorizonsService._payload_is_live({"status": "error", "error": "maintenance_required"}, "result"))

    def test_hubs_can_be_updated_from_the_desktop(self):
        self.assertTrue({"check_update", "apply_update"} <= NewHorizonsService.HUB_COMMANDS)


if __name__ == "__main__":
    unittest.main()
