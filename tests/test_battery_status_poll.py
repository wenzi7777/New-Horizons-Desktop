"""battery_status: the battery card's slice of status, polled during a gauge
resync instead of the full ~18 KB status (which costs the device ~14 ms of
main-loop time to build)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402
from newhorizons_backend.terminal import compile_terminal_command, validate_device_command_payload  # noqa: E402


class BatteryStatusCommandTest(unittest.TestCase):
    def test_allowed_in_every_mode(self):
        self.assertIn("battery_status", NewHorizonsService.SHARED_COMMANDS)
        payload = compile_terminal_command("battery-status")["payload"]
        self.assertEqual(payload, {"command": "battery_status"})
        validate_device_command_payload(payload)

    def test_result_updates_battery_gauge_and_power(self):
        service = NewHorizonsService(mock_mode=False)
        device_uid = "3CDC7545CCD0"
        service._record_arduino_response(
            device_uid,
            {"command": "battery_status", "request_id": "req-battery-status"},
            {
                "status": "ok",
                "message": "battery_status",
                "data": {
                    "battery": {"gauge_sync_state": "ready", "soc_centi_percent": 8150, "charge_state": "charging"},
                    "battery_gauge": {"gauge": "max17048", "gauge_sync_state": "ready"},
                    "power": {"state": "normal", "charge_state": "charging"},
                },
            },
        )
        device = {item["device_uid"]: item for item in service.list_devices()}[device_uid]
        status = device["last_status"]
        self.assertEqual(status["battery"]["gauge_sync_state"], "ready")
        self.assertEqual(status["battery_gauge"]["gauge"], "max17048")
        self.assertEqual(status["power"]["charge_state"], "charging")


class BatteryStatusPageTest(unittest.TestCase):
    def test_resync_poll_uses_battery_status_with_a_fallback(self):
        page = (ROOT / "frontend" / "src" / "pages" / "DeviceSettingsPage.tsx").read_text(encoding="utf-8")
        start = page.index("const batteryStatusUnsupportedRef")
        effect = page[start:page.index("}, [batteryGaugeSyncing", start)]
        self.assertIn('quietCommand({ command: "battery_status" })', effect)
        self.assertIn('=== "unknown_command"', effect)
        self.assertIn('quietCommand({ command: "status" })', effect)  # older firmware


if __name__ == "__main__":
    unittest.main()
