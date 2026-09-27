"""Which commands carry "quiet": true, the flag that skips the device's LED ack.

Firmware v1.7.2+ skips its received/success flashes for a quiet command. Every
poll and automatic refresh must set it -- otherwise a poll keeps the status LED
flashing and hides an app's colour -- and nothing an operator triggers may,
since that flash is the only confirmation the device gives.
"""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
BACKEND = ROOT / "backend" / "newhorizons_backend"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class QuietFlagTests(unittest.TestCase):
    def test_the_flag_is_set_in_one_helper(self):
        lib = read(SRC / "lib" / "deviceCommand.ts")
        self.assertIn("return { ...payload, quiet: true };", lib)
        poll = lib[lib.index("export async function pollDeviceCommand"):]
        poll = poll[:poll.index("\n}\n")]
        self.assertIn("quietCommand(payload)", poll)
        # Nowhere else spells the field out.
        for path in SRC.rglob("*.ts*"):
            if path.name == "deviceCommand.ts" or "/sdk/" in str(path):
                continue
            self.assertNotRegex(read(path), r"\bquiet:\s*true", str(path))

    def test_the_operator_command_path_is_never_quiet(self):
        lib = read(SRC / "lib" / "deviceCommand.ts")
        queue = lib[lib.index("export function useDeviceCommand"):]
        self.assertNotIn("quietCommand", queue)
        for name in ("pages/TerminalPage.tsx", "components/DeviceAppsPanel.tsx"):
            self.assertNotIn("quietCommand", read(SRC / name), name)

    def test_settings_page_marks_its_automatic_refreshes(self):
        page = read(SRC / "pages" / "DeviceSettingsPage.tsx")
        # RAM monitor, battery-sync status, and the three one-shot status reads
        # a section fires by itself when it opens.
        self.assertIn('quietCommand({ command: "memory_status" })', page)
        self.assertEqual(page.count('quietCommand({ command: "status" })'), 4)

    def test_readouts_poll_quietly(self):
        view = read(SRC / "components" / "ReadoutView.tsx")
        self.assertIn("runnerRef.current(quietCommand({ command: source.command }))", view)

    def test_backend_background_commands_are_quiet(self):
        service = read(BACKEND / "service.py")
        poller = service[service.index('{"command": "app_events", "since_seq": since'):]
        self.assertIn('"quiet": True', poller[:120])
        gateway = read(BACKEND / "gateway_ws.py")
        push = gateway[gateway.index('"command": "set_time"'):]
        self.assertIn('"quiet": True', push[:300])


if __name__ == "__main__":
    unittest.main()
