import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "backend" / "newhorizons_backend"
PACKAGE_NAME = "newhorizons_backend"
if PACKAGE_NAME not in sys.modules:
    package = types.ModuleType(PACKAGE_NAME)
    package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
    sys.modules[PACKAGE_NAME] = package

SETTINGS_SPEC = importlib.util.spec_from_file_location(
    f"{PACKAGE_NAME}.pressure_cal_settings",
    PACKAGE_ROOT / "pressure_cal_settings.py",
)
assert SETTINGS_SPEC and SETTINGS_SPEC.loader
SETTINGS_MODULE = importlib.util.module_from_spec(SETTINGS_SPEC)
sys.modules[SETTINGS_SPEC.name] = SETTINGS_MODULE
SETTINGS_SPEC.loader.exec_module(SETTINGS_MODULE)

SPEC = importlib.util.spec_from_file_location(
    f"{PACKAGE_NAME}.pressure_cal_client",
    PACKAGE_ROOT / "pressure_cal_client.py",
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
PressureCalClient = MODULE.PressureCalClient
PressureCalError = MODULE.PressureCalError


class PressureCalClientCompatibilityTest(unittest.TestCase):
    def test_readings_all_alias_uses_legacy_endpoint(self):
        client = PressureCalClient(url="http://pressure-cal.local", token="secret")

        with patch.object(client, "_request", return_value={"ok": True}) as request:
            payload = client.readings_all()

        self.assertEqual(payload, {"ok": True})
        request.assert_called_once_with("GET", "/api/v1/readings/all")

    def test_set_control_enabled_falls_back_to_calibration_source_endpoint(self):
        client = PressureCalClient(url="http://pressure-cal.local", token="secret")

        with patch.object(
            client,
            "_request",
            side_effect=[
                PressureCalError("missing", status=404),
                {"ok": True},
            ],
        ) as request:
            payload = client.set_control_enabled(True)

        self.assertEqual(payload, {"ok": True})
        self.assertEqual(request.call_args_list[0].args, ("POST", "/api/v1/pressure/control", {"enabled": True}))
        self.assertEqual(request.call_args_list[1].args, ("POST", "/api/calibration/source/uno/control", {"enabled": True}))

    def test_enter_safe_mode_falls_back_to_calibration_source_endpoint(self):
        client = PressureCalClient(url="http://pressure-cal.local", token="secret")

        with patch.object(
            client,
            "_request",
            side_effect=[
                PressureCalError("missing", status=404),
                {"ok": True},
            ],
        ) as request:
            payload = client.enter_safe_mode()

        self.assertEqual(payload, {"ok": True})
        self.assertEqual(request.call_args_list[0].args, ("POST", "/api/v1/pressure/safe", {}))
        self.assertEqual(request.call_args_list[1].args, ("POST", "/api/calibration/source/uno/safe", {}))


if __name__ == "__main__":
    unittest.main()
