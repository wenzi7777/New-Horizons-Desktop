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


if __name__ == "__main__":
    unittest.main()
