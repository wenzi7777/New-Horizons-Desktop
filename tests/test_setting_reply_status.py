"""A relayed setting command's reply updates the device's status.

Through a relay (Studio, Pocket, headless, Hub) only `status` and a few other
replies used to reach last_status. A set_range reply was shown while it was
the last result; the next command's reply made the page fall back to the
status from the last poll, so a switch seemed to flip back by itself.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402

UID = "90DA725F16D4"


class SettingReplyStatusTests(unittest.TestCase):
    def setUp(self):
        self.service = NewHorizonsService(mock_mode=False)
        self.service.publish_command = mock.Mock()
        self.service._record_result(UID, {
            "command": "status", "status": "ok",
            "data": {"firmware_version": "v2.1.0", "mode": "normal",
                     "range": {"mode": "auto", "leak_compensation": True},
                     "vref": {"vref_mv": 108, "supported": True}},
        })

    def status(self):
        return self.service._devices[UID]["last_status"]

    def test_reply_survives_the_next_command(self):
        self.service._record_result(UID, {
            "command": "set_range", "status": "ok",
            "data": {"range": {"mode": "raw", "leak_compensation": False},
                     "vref": {"vref_mv": 330, "supported": True}},
        })
        self.service._record_result(UID, {"command": "battery_status", "status": "ok", "data": {"percent": 100}})
        self.assertEqual(self.status()["range"], {"mode": "raw", "leak_compensation": False})
        self.assertEqual(self.status()["vref"]["vref_mv"], 330)
        self.assertEqual(self.status()["firmware_version"], "v2.1.0")

    def test_a_refused_command_changes_nothing(self):
        self.service._record_result(UID, {
            "command": "set_range", "status": "error", "ok": False, "message": "range_rfb_required",
            "data": {"range": {"mode": "raw"}},
        })
        self.assertEqual(self.status()["range"]["mode"], "auto")


if __name__ == "__main__":
    unittest.main()
