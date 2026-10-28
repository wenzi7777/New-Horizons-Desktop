"""Device/Hub clock service: the backend's side of it.

The firmware disciplines its own clock (SNTP in WiFi mode, the Hub over
ESP-NOW in Direct mode); the backend only has to carry the commands, give
Hubs a timestamp to fall back on, and say in the CSV which clock a
timestamp came from.
"""

import csv
import sys
import tempfile
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402
from newhorizons_backend.terminal import (  # noqa: E402
    compile_terminal_command,
    validate_device_command_payload,
)


class SetTimeTests(unittest.TestCase):
    def test_epoch_is_sent_as_a_string(self):
        # The firmware reads epoch_ms with its string extractor (a millisecond
        # epoch overflows its 32-bit ints); a JSON number came back as
        # epoch_ms_required.
        payload = compile_terminal_command("set-time --epoch-ms 1780000000123")["payload"]
        self.assertEqual(payload["epoch_ms"], "1780000000123")
        self.assertNotIn("force", payload)

    def test_force_is_a_boolean(self):
        payload = compile_terminal_command("set-time --epoch-ms 1780000000123 --force true")["payload"]
        self.assertIs(payload["force"], True)
        payload = compile_terminal_command("set-time --epoch-ms 1780000000123 --force false")["payload"]
        self.assertIs(payload["force"], False)


class ClockCommandTests(unittest.TestCase):
    def test_clock_commands_compile(self):
        self.assertEqual(compile_terminal_command("clock-sync")["payload"], {"command": "clock_sync"})
        self.assertEqual(compile_terminal_command("clock-status")["payload"], {"command": "clock_status"})

    def test_clock_commands_are_allowed(self):
        for payload in (
            {"command": "clock_sync", "request_id": "r1"},
            {"command": "clock_status", "request_id": "r2"},
            {"command": "set_clock_config", "request_id": "r3", "sync_interval_s": 30},
        ):
            with self.subTest(command=payload["command"]):
                validate_device_command_payload(payload)

    def test_hub_accepts_clock_sync(self):
        self.assertIn("clock_sync", NewHorizonsService.HUB_COMMANDS)


class HubTimeSourceTests(unittest.TestCase):
    def test_pong_and_hello_ack_carry_integer_server_time(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "gateway_ws.py").read_text(encoding="utf-8")
        pong = source[source.index('if msg_type == "ping":') :]
        pong = pong[: pong.index("return")]
        self.assertIn('"server_time_ms": int(now * 1000)', pong)
        hello = source[source.index('"type": "gateway_hello_ack"') :]
        self.assertIn('"server_time_ms"', hello[:600])


class CsvTimeRefTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        # Only the CSV writer's own state, not a whole running service: the
        # recording's files, and what its meta file reads about the device.
        self.service = object.__new__(NewHorizonsService)
        self.service._lock = threading.RLock()
        self.service._csv_paths = {}
        self.service._csv_frame_clocks = {}
        self.service._recording_sessions = {}
        self.service._recording_enabled = {"dev1"}
        self.service._devices = {}
        self.service._latest_status = {}
        self.service._gateways = {}
        self.service._nicknames = {}
        self.service._device_groups = {}
        self.service._data_root = Path(self._tmp.name)
        self.addCleanup(lambda: [session.writer.close() for session in self.service._recording_sessions.values()])

    def rows(self):
        # Rows are buffered in the open file until flushed (recording_session.py).
        self.service._recording_sessions["dev1"].writer.flush()
        path = self.service._csv_paths["dev1"]
        with path.open(encoding="utf-8") as handle:
            return list(csv.reader(handle))

    def test_rows_say_which_clock_stamped_them(self):
        self.service._write_csv_sample("dev1", {"p": [1, 2], "frame_id": 7})
        self.service._write_csv_sample(
            "dev1", {"p": [3, 4], "frame_id": 8, "device_epoch_ms": 1780000000123}
        )
        header, before_sync, after_sync = self.rows()
        self.assertEqual(header[-1], "time_ref")
        # Appended after frame_seq, so positional readers of older exports
        # keep working.
        self.assertEqual(header[-2], "frame_seq")
        self.assertEqual(before_sync[-1], "received")
        self.assertEqual(after_sync[-1], "device")
        self.assertEqual(after_sync[0], "1780000000123")


if __name__ == "__main__":
    unittest.main()
