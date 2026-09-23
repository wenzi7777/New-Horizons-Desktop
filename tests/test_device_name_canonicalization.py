import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402


UID = "3CDC7545CCD0"


class DeviceNameCanonicalizationTest(unittest.TestCase):
    """The default device name was abbreviated to "NHOS-<UID>" in firmware
    v1.0.0. Devices flashed before that keep reporting "New Horizons OS-<UID>"
    for as long as they stay in the field, so both spellings have to be
    recognized as "this is still the factory name"."""

    def _canonical(self, device_name, device_uid=UID):
        return NewHorizonsService._canonical_device_name(device_name, device_uid)

    def test_short_new_style_default_name_expands_to_full_uid(self):
        self.assertEqual(self._canonical("NHOS-45CCD0"), "NHOS-{}".format(UID))

    def test_short_legacy_default_name_is_recognized_and_migrated(self):
        # The regression this file exists for: a pre-v1.0.0 device must not be
        # mistaken for a user-chosen nickname.
        self.assertEqual(
            self._canonical("New Horizons OS-45CCD0"), "NHOS-{}".format(UID)
        )

    def test_already_full_names_are_left_alone(self):
        for name in ("NHOS-{}".format(UID), "New Horizons OS-{}".format(UID)):
            self.assertEqual(self._canonical(name), name)

    def test_user_nicknames_are_never_rewritten(self):
        for name in ("Nick's glove", "NHOS lab unit", ""):
            self.assertEqual(self._canonical(name), name)

    def test_non_uid_devices_are_left_alone(self):
        self.assertEqual(
            self._canonical("New Horizons OS-45CCD0", "short"),
            "New Horizons OS-45CCD0",
        )



class DeviceNameStabilityTest(unittest.TestCase):
    """A payload that carries no name must not rename the device.

    Seen in the SDK's readout preview: it polls a device once a second, and
    each command result (memory_status, app_list...) has no device_name, so
    the device fell back to its bare UID; the next heartbeat named it
    "NHOS-<UID>" again. Every device list flipped between the two.
    """

    def setUp(self):
        self.service = NewHorizonsService(autostart=False, mock_mode=False)
        self.names = []
        original = self.service._emit_event

        def capture(event):
            if event.get("type") == "device_update":
                self.names.append(event["item"].get("display_name"))
            return original(event)

        self.service._emit_event = capture
        self.service._record_status(UID, {"device_uid": UID, "device_name": "NHOS-{}".format(UID), "mode": "normal"})

    def _assert_name_kept(self):
        self.assertEqual(self.service._devices[UID]["device_name"], "NHOS-{}".format(UID))
        self.assertEqual(set(self.names), {"NHOS-{}".format(UID)}, self.names)

    def test_a_command_result_without_a_name_keeps_the_name(self):
        for command in ("memory_status", "app_list", "scan_health"):
            self.service._record_result(UID, {
                "device_uid": UID, "command": command, "status": "ok", "request_id": command,
                "data": {"heap_free": 1},
            })
        self._assert_name_kept()

    def test_a_status_without_a_name_keeps_the_name(self):
        self.service._record_status(UID, {"device_uid": UID, "mode": "normal"})
        self._assert_name_kept()

    def test_a_device_seen_first_without_a_name_is_shown_by_its_uid(self):
        other = "3CDC7545CCD1"
        self.service._record_result(other, {"device_uid": other, "command": "memory_status", "status": "ok"})
        self.assertEqual(self.service._decorate_device_entry(self.service._devices[other])["display_name"], other)

    def test_a_real_rename_still_applies(self):
        self.service._record_status(UID, {"device_uid": UID, "device_name": "Left insole", "mode": "normal"})
        self.assertEqual(self.service._devices[UID]["device_name"], "Left insole")


if __name__ == "__main__":
    unittest.main()
