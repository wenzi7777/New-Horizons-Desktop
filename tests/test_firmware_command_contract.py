"""The device commands the backend knows vs the ones the firmware handles.

A command the firmware gains but the backend does not list is unusable from
the Desktop (unknown_command at the allowlist); one the backend lists but the
firmware dropped fails only on a real device. This reads the firmware's own
dispatch (ControlServer::processCommand) so either drift fails here.
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402
from newhorizons_backend.terminal import DEVICE_COMMAND_ALLOWLIST  # noqa: E402

CONTROL_SERVER = ROOT.parent / "NewHorizonsOS-OTA" / "firmware" / "newhorizons_os" / "ControlServer.cpp"


@unittest.skipUnless(CONTROL_SERVER.exists(), "NewHorizonsOS-OTA not checked out alongside")
class FirmwareCommandContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = CONTROL_SERVER.read_text(encoding="utf-8")
        cls.firmware = set(re.findall(r'cmd == "([a-z_0-9]+)"', source))

    def test_parsed_the_dispatch(self):
        self.assertGreater(len(self.firmware), 50)

    def test_every_firmware_command_is_known_to_the_backend(self):
        missing = sorted(self.firmware - NewHorizonsService.KNOWN_DEVICE_COMMANDS)
        self.assertEqual(missing, [], "add these to DEVICE_COMMAND_ALLOWLIST (or INTERNAL_DEVICE_COMMANDS)")

    def test_every_backend_command_exists_in_the_firmware(self):
        stale = sorted(NewHorizonsService.KNOWN_DEVICE_COMMANDS - self.firmware)
        self.assertEqual(stale, [], "the firmware no longer handles these")

    def test_internal_commands_stay_off_the_public_allowlist(self):
        self.assertEqual(NewHorizonsService.INTERNAL_DEVICE_COMMANDS & set(DEVICE_COMMAND_ALLOWLIST), set())


if __name__ == "__main__":
    unittest.main()
