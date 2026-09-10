import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.gateway_ws import _clock_is_synced  # noqa: E402


class ClockIsSyncedTest(unittest.TestCase):
    """The wall-clock push must fire only for a device that actively reports
    an unsynced clock. Firmware before v1.0.0 has no `set_time` command and
    reports no `clock` block, so it reads as None -- and must not be pushed
    to, or every such device collects a doomed command every interval (and a
    Hub pauses its sensor-data relay while each one is pending)."""

    def test_missing_clock_block_is_unknown_not_unsynced(self):
        self.assertIsNone(_clock_is_synced({}))
        self.assertIsNone(_clock_is_synced({"status": {}, "data": {}}))
        # A pre-v1.0.0 status payload: plenty of fields, no clock block.
        legacy = {"device_uid": "3CDC7545CCD0", "fps": 60, "status": {"uptime_ms": 1234}}
        self.assertIsNone(_clock_is_synced(legacy))

    def test_explicit_states_are_reported(self):
        self.assertIs(_clock_is_synced({"clock": {"synced": True}}), True)
        self.assertIs(_clock_is_synced({"clock": {"synced": False}}), False)

    def test_nested_containers_are_searched(self):
        self.assertIs(_clock_is_synced({"status": {"clock": {"synced": False}}}), False)
        self.assertIs(_clock_is_synced({"data": {"clock": {"synced": True}}}), True)

    def test_only_an_explicit_false_should_trigger_a_push(self):
        # Mirrors the guard in _maybe_push_time: `is not False` -> return.
        def would_push(payload):
            return _clock_is_synced(payload) is False

        self.assertTrue(would_push({"clock": {"synced": False}}))
        self.assertFalse(would_push({"clock": {"synced": True}}))
        self.assertFalse(would_push({}))          # pre-v1.0.0 firmware
        self.assertFalse(would_push({"clock": {}}))


if __name__ == "__main__":
    unittest.main()
