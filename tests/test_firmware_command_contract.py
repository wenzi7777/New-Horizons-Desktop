"""The device commands the backend knows vs the firmware's command table.

Since firmware v1.15.0 the device reports its own table (`commands`), and the
backend accepts whatever it lists (device_commands.py). The static sets in
terminal.py / service.py remain the fallback for older firmware and for the
first seconds before a catalog arrives, so they must still agree with the
table on what they do list: a command the backend lists but the firmware
dropped fails only on a real device, and a maintenance flag the backend
disagrees with gates the command wrongly on old firmware.

A firmware command the static sets do not list is fine now: the catalog
makes it usable without a backend change.
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

COMMAND_TABLE = ROOT.parent / "NewHorizonsOS-OTA" / "firmware" / "newhorizons_os" / "ControlCommandTable.cpp"
# Same row shape as NewHorizonsOS-OTA/tests/_control_source.py.
ROW = re.compile(r'\{"(?P<name>[a-z_0-9]+)", &ControlServer::cmd\w+, (?P<flags>[^,]+),\s*"(?:[^"\\]|\\.)*"\}')


@unittest.skipUnless(COMMAND_TABLE.exists(), "NewHorizonsOS-OTA not checked out alongside")
class FirmwareCommandContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = COMMAND_TABLE.read_text(encoding="utf-8")
        cls.flags = {
            m.group("name"): {f.strip() for f in m.group("flags").split("|")} - {"0"}
            for m in ROW.finditer(source)
        }
        cls.firmware = set(cls.flags)

    def test_parsed_the_table(self):
        self.assertGreater(len(self.firmware), 80)

    def test_every_backend_command_exists_in_the_firmware(self):
        stale = sorted(NewHorizonsService.KNOWN_DEVICE_COMMANDS - self.firmware)
        self.assertEqual(stale, [], "the firmware no longer handles these")

    def test_maintenance_flags_match_the_static_mode_sets(self):
        maintenance_only = NewHorizonsService.MAINTENANCE_COMMANDS - NewHorizonsService.NORMAL_COMMANDS
        known = self.firmware & NewHorizonsService.KNOWN_DEVICE_COMMANDS
        flagged = {name for name in known if "kCmdNeedsMaintenance" in self.flags[name]}
        self.assertEqual(sorted(flagged), sorted(maintenance_only & known))

    def test_internal_flags_match_the_backend(self):
        flagged = {name for name, flags in self.flags.items() if "kCmdInternal" in flags}
        self.assertEqual(flagged, NewHorizonsService.INTERNAL_DEVICE_COMMANDS)

    def test_status_snapshot_flags_match_status_commands(self):
        flagged = {name for name, flags in self.flags.items() if "kCmdStatusSnapshot" in flags}
        self.assertEqual(flagged, NewHorizonsService.STATUS_COMMANDS)

    def test_internal_commands_stay_off_the_public_allowlist(self):
        self.assertEqual(NewHorizonsService.INTERNAL_DEVICE_COMMANDS & set(DEVICE_COMMAND_ALLOWLIST), set())


if __name__ == "__main__":
    unittest.main()
