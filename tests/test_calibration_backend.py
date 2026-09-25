"""Calibration results reach the device snapshot, and the v1.5.1 rules hold.

The Settings page reads calibration from `last_status.calibration`. Only
`status` replies used to update it, so after `calibration_session_begin` the
snapshot still said `session_active: false` and the page reverted to that
until a reload.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

DEVICE = "NH-MOCK-001"


class CalibrationTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        os.environ["NEWHORIZONS_DATA_ROOT"] = self._tmp.name
        from newhorizons_backend.service import NewHorizonsService

        self.service_class = NewHorizonsService
        self.svc = NewHorizonsService(mock_mode=True)

    def run_command(self, payload):
        self.svc.publish_command(DEVICE, payload)
        return self.svc._latest_result.get(DEVICE, {})

    def snapshot_calibration(self):
        device = next(item for item in self.svc.list_devices() if item.get("device_uid") == DEVICE)
        return device["last_status"]["calibration"]


class CalibrationSnapshotTests(CalibrationTestCase):
    def test_session_begin_updates_the_device_snapshot(self):
        self.run_command({"command": "enter_maintenance"})
        self.assertFalse(self.snapshot_calibration()["session_active"])

        result = self.run_command({"command": "calibration_session_begin"})

        self.assertEqual(result["message"], "calibration_session_started")
        self.assertTrue(self.snapshot_calibration()["session_active"])

    def test_capture_replies_do_not_overwrite_the_snapshot(self):
        # calibration_capture_* answer with a dump, not the full status.
        self.run_command({"command": "enter_maintenance"})
        self.run_command({"command": "calibration_session_begin"})
        self.run_command({"command": "calibration_capture_tare", "duration_ms": 10})
        calibration = self.snapshot_calibration()
        self.assertIn("levels", calibration)
        self.assertTrue(calibration["session_active"])

    def test_status_is_read_from_both_reply_shapes(self):
        full = {"enabled": False, "session_active": True, "tare_complete": False, "levels": []}
        gateway = {"command": "calibration_session_begin", "status": "ok", "data": dict(full), "request_id": "r1"}
        tcp = {"command": "calibration_session_begin", "status": "ok", "request_id": "r1", **full}
        for payload in (gateway, tcp):
            status = self.service_class._calibration_status_from_result(payload)
            self.assertEqual(status["session_active"], True)
            self.assertNotIn("request_id", status)

    def test_errors_dumps_and_other_commands_are_ignored(self):
        full = {"enabled": False, "session_active": True, "tare_complete": False, "levels": []}
        read = self.service_class._calibration_status_from_result
        self.assertIsNone(read({"command": "calibration_session_begin", "status": "error", "data": full}))
        self.assertIsNone(read({"command": "status", "status": "ok", "data": full}))
        self.assertIsNone(read({"command": "calibration_capture_tare", "status": "ok",
                                "data": {"total_points": 16, "session_active": True}}))


class CalibrationRuleTests(CalibrationTestCase):
    def test_zero_works_in_normal_mode_and_applies_without_calibration(self):
        result = self.run_command({"command": "calibration_tare_capture", "duration_ms": 10})

        self.assertEqual(result["message"], "calibration_tare_captured")
        calibration = self.snapshot_calibration()
        self.assertEqual(calibration["output_mode"], "tared")
        self.assertFalse(calibration["enabled"])

        self.run_command({"command": "calibration_tare_clear"})
        self.assertEqual(self.snapshot_calibration()["output_mode"], "raw")

    def test_zero_is_refused_during_a_session(self):
        self.run_command({"command": "enter_maintenance"})
        self.run_command({"command": "calibration_session_begin"})
        result = self.run_command({"command": "calibration_tare_capture"})
        self.assertEqual(result["error"], "calibration_session_active")

    def test_session_begin_is_idempotent(self):
        self.run_command({"command": "enter_maintenance"})
        self.run_command({"command": "calibration_session_begin"})
        self.run_command({"command": "calibration_capture_tare"})
        result = self.run_command({"command": "calibration_session_begin"})
        self.assertEqual(result["message"], "calibration_session_already_active")
        self.assertTrue(self.snapshot_calibration()["draft_tare"]["complete"])

    def test_levels_need_the_baseline_first(self):
        self.run_command({"command": "enter_maintenance"})
        self.run_command({"command": "calibration_session_begin"})
        result = self.run_command({"command": "calibration_capture_all", "level": 10})
        self.assertEqual(result["error"], "calibration_tare_required")

    def test_full_flow_ends_calibrated(self):
        self.run_command({"command": "enter_maintenance"})
        self.run_command({"command": "calibration_session_begin"})
        self.run_command({"command": "calibration_capture_tare"})
        self.run_command({"command": "calibration_capture_all", "level": 10})
        result = self.run_command({"command": "calibration_session_commit", "auto_enable": True})

        self.assertEqual(result["message"], "calibration_committed")
        calibration = self.snapshot_calibration()
        self.assertEqual(calibration["output_mode"], "calibrated")
        self.assertFalse(calibration["session_active"])

    def test_session_commands_still_need_maintenance(self):
        with self.assertRaises(Exception):
            self.run_command({"command": "calibration_session_begin"})


class ArduinoTimeoutTests(unittest.TestCase):
    def test_capture_timeouts_cover_the_capture_duration(self):
        from newhorizons_backend.service import NewHorizonsService

        timeout = NewHorizonsService._arduino_command_timeout
        self.assertEqual(timeout({"command": "status"}), 2.0)
        self.assertEqual(timeout({"command": "calibration_capture_all"}), 6.0)
        self.assertEqual(timeout({"command": "calibration_capture_cell", "duration_ms": 5000}), 8.0)
        self.assertEqual(timeout({"command": "calibration_tare_capture"}), 4.0)


if __name__ == "__main__":
    unittest.main()
