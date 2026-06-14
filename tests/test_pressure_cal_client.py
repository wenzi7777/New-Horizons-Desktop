import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.pressure_cal_client import PressureCalClient  # noqa: E402


class PressureCalClientCompatibilityTest(unittest.TestCase):
    def test_readings_all_alias_uses_legacy_endpoint(self):
        client = PressureCalClient(url="http://pressure-cal.local", token="secret")

        with patch.object(client, "_request", return_value={"ok": True}) as request:
            payload = client.readings_all()

        self.assertEqual(payload, {"ok": True})
        request.assert_called_once_with("GET", "/api/v1/readings/all")


if __name__ == "__main__":
    unittest.main()
