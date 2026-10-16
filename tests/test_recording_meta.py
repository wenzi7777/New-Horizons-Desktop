import csv
import json
import struct
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.app_event_log import sidecar_path_for  # noqa: E402
from newhorizons_backend.recording_meta import (  # noqa: E402
    RecordingMeta,
    build_device_meta,
    is_recording_dir,
    new_recording_paths,
    read_meta,
    recording_base,
    sibling_paths,
    status_is_full,
)
from newhorizons_backend.service import NewHorizonsService  # noqa: E402

FULL_STATUS = {
    "device_name": "NHOS-80456B76AAF4",
    "protocol": "NHO/Arduino/1",
    "firmware_version": "v1.16.0",
    "firmware_prerelease": False,
    "hardware_model": "TIA-CTL v1.5.F 2026.7",
    "matrix_shape": {"rows": 8, "cols": 14},
    "runtime": {"scan_timing": {"target_fps": 60, "send_every_n_frames": 1}},
    "calibration": {"enabled": True, "output_mode": "raw", "tare_complete": False, "levels": [1, 2, 3]},
    "imu": {"chip": "LSM6DSO", "sample_rate_hz": 104},
    "clock": {"source": "hub", "synced": True},
    "battery": {"soc_percent": 80, "vbat_mv": 3990},
    "received_at": "2026-10-16T06:27:10+00:00",
}
# What a heartbeat leaves as the device's status before any real reply.
HEARTBEAT_STATUS = {"device_name": "NHOS-80456B76AAF4", "protocol": "NHO/Arduino/1", "transport_path": "udp"}


class PathTests(unittest.TestCase):
    def test_every_file_of_a_recording_shares_its_base_in_either_layout(self):
        for name in ("062756.data.csv", "062756.events.csv", "062756.meta.json", "062756.csv"):
            self.assertEqual(recording_base(Path(name)), "062756")
        self.assertEqual(recording_base(Path("062756-2.data.csv")), "062756-2")

    def test_events_sit_beside_the_samples_in_either_layout(self):
        self.assertEqual(sidecar_path_for(Path("/d/062756/062756.data.csv")), Path("/d/062756/062756.events.csv"))
        # Recordings from before v0.27.0 keep their old sidecar name.
        self.assertEqual(sidecar_path_for(Path("/d/062756.csv")), Path("/d/062756.events.csv"))

    def test_siblings_point_at_the_legacy_samples_when_that_is_what_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            day = Path(tmp)
            (day / "062756.csv").write_text("timestamp_ms\n", encoding="utf-8")
            self.assertEqual(sibling_paths(day / "062756.events.csv").data, day / "062756.csv")
            self.assertEqual(sibling_paths(day / "070000.events.csv").data, day / "070000.data.csv")

    def test_a_recording_gets_its_own_folder_even_within_the_same_second(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            now = datetime(2026, 10, 16, 6, 27, 56, tzinfo=timezone.utc)
            first = new_recording_paths(root, "DEV", now)
            self.assertEqual(first.directory, root / "DEV" / "20261016" / "062756")
            self.assertEqual(
                [first.data.name, first.events.name, first.meta.name],
                ["062756.data.csv", "062756.events.csv", "062756.meta.json"],
            )
            first.data.write_text("x\n", encoding="utf-8")
            self.assertTrue(is_recording_dir(first.directory))
            second = new_recording_paths(root, "DEV", now)
            self.assertEqual(second.directory.name, "062756-2")
            self.assertEqual(second.data.name, "062756-2.data.csv")
            # An old flat recording of the same second is not appended to.
            legacy_day = root / "DEV" / "20261017"
            legacy_day.mkdir(parents=True)
            (legacy_day / "062756.csv").write_text("x\n", encoding="utf-8")
            later = new_recording_paths(root, "DEV", now.replace(day=17))
            self.assertEqual(later.directory.name, "062756-2")


class DeviceMetaTests(unittest.TestCase):
    def test_before_a_full_status_the_unknowns_are_null(self):
        self.assertFalse(status_is_full(HEARTBEAT_STATUS))
        meta = build_device_meta("80456B76AAF4", {"device_name": "NHOS-80456B76AAF4"}, HEARTBEAT_STATUS, sensor_count=112)
        self.assertIsNone(meta["device"]["hardware_model"])
        self.assertIsNone(meta["sensors"]["matrix_shape"])
        self.assertIsNone(meta["calibration"]["output_mode"])
        self.assertIsNone(meta["status_received_at"])
        self.assertEqual(meta["sensors"]["count"], 112)
        self.assertEqual(meta["transport"], {"path": "udp", "relay": "direct", "relay_id": None})
        # Never the backend's own "unknown" placeholder.
        summary = {"hardware_model": "unknown", "firmware_version": "unknown"}
        meta = build_device_meta("X", {"system_summary": summary}, {})
        self.assertIsNone(meta["device"]["hardware_model"])
        self.assertIsNone(meta["device"]["firmware_version"])

    def test_a_full_status_fills_the_device_blocks(self):
        device = {"gateway_id": "HUB-1", "gateway_connected": True, "transport_path": "espnow"}
        meta = build_device_meta("80456B76AAF4", device, FULL_STATUS, relay_client_type="hub", target_fps=60, nickname="left foot")
        self.assertEqual(meta["device"]["hardware_model"], "TIA-CTL v1.5.F 2026.7")
        self.assertEqual(meta["device"]["firmware_version"], "v1.16.0")
        self.assertEqual(meta["device"]["display_name"], "left foot")
        self.assertIs(meta["device"]["firmware_prerelease"], False)
        self.assertEqual(meta["sensors"]["matrix_shape"], {"rows": 8, "cols": 14})
        self.assertEqual(meta["calibration"]["output_mode"], "raw")
        self.assertNotIn("levels", meta["calibration"])
        self.assertEqual(meta["stream"]["target_fps"], 60)
        self.assertEqual(meta["stream"]["imu"], {"chip": "LSM6DSO", "sample_rate_hz": 104})
        self.assertEqual(meta["transport"], {"path": "espnow", "relay": "hub", "relay_id": "HUB-1"})
        self.assertEqual(meta["battery_at_start"], {"soc_percent": 80, "vbat_mv": 3990})
        self.assertEqual(meta["status_received_at"], "2026-10-16T06:27:10+00:00")

    def test_a_disconnected_gateway_is_not_the_relay(self):
        meta = build_device_meta("X", {"gateway_id": "gw", "gateway_connected": False}, {})
        self.assertEqual(meta["transport"]["relay"], "direct")
        meta = build_device_meta("X", {"gateway_id": "gw", "gateway_connected": True}, {})
        self.assertEqual(meta["transport"], {"path": None, "relay": "gateway", "relay_id": "gw"})


class FakeTime:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class RecordingMetaTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.started = datetime(2026, 10, 16, 6, 27, 56, 770000, tzinfo=timezone.utc)
        self.paths = new_recording_paths(Path(self._tmp.name), "DEV", self.started)
        self.clock = FakeTime()

    def meta(self, device_meta=None):
        device_meta = device_meta or build_device_meta("DEV", {}, HEARTBEAT_STATUS, sensor_count=4)
        return RecordingMeta(
            self.paths, device_meta, started_at=self.started, first_frame_seq=2596,
            first_timestamp_ms=1792132076770, monotonic=self.clock,
            wall=lambda: datetime(2026, 10, 16, 6, 30, 0, tzinfo=timezone.utc),
        )

    def on_disk(self):
        return json.loads(self.paths.meta.read_text(encoding="utf-8"))

    def test_start_writes_the_recording_block(self):
        meta = self.meta()
        self.assertTrue(meta.write())
        document = self.on_disk()
        self.assertEqual(document["format"], 1)
        self.assertEqual(document["files"], {"data": "062756.data.csv", "events": "062756.events.csv"})
        recording = document["recording"]
        self.assertEqual(recording["started_at"], "2026-10-16T06:27:56.770Z")
        self.assertEqual(recording["name_time_zone"], "UTC")
        self.assertEqual(recording["first_frame_seq"], 2596)
        self.assertIsNone(recording["stopped_at"])
        self.assertFalse(self.paths.meta.with_name(self.paths.meta.name + ".tmp").exists())
        self.assertEqual(read_meta(self.paths.data)["format"], 1)

    def test_frames_are_counted_and_flushed_every_ten_seconds(self):
        meta = self.meta()
        meta.write()
        for index in range(3):
            meta.on_frame(2596 + index, 1792132076770 + index * 17)
        self.assertEqual(self.on_disk()["recording"]["rows"], 0)  # not due yet
        self.clock.now += RecordingMeta.WRITE_EVERY_SEC
        meta.on_frame(2599, 1792132076821)
        recording = self.on_disk()["recording"]
        self.assertEqual(recording["rows"], 4)
        self.assertEqual(recording["last_frame_seq"], 2599)
        self.assertEqual(recording["last_timestamp_ms"], 1792132076821)

    def test_a_later_status_fills_in_and_tracked_changes_are_logged(self):
        meta = self.meta()
        meta.on_frame(2596, 1)
        meta.refresh_device(build_device_meta("DEV", {}, FULL_STATUS, target_fps=60))
        document = self.on_disk()
        self.assertEqual(document["device"]["hardware_model"], "TIA-CTL v1.5.F 2026.7")
        self.assertEqual(document["calibration"]["output_mode"], "raw")
        self.assertEqual(document["status_received_at"], "2026-10-16T06:27:10+00:00")
        self.assertEqual(document["changes"], [])
        # Sensor count comes from the frames; a status without it changes nothing.
        self.assertEqual(document["sensors"]["count"], 4)

        tared = dict(FULL_STATUS, calibration=dict(FULL_STATUS["calibration"], output_mode="tared"),
                     hardware_model="something else")
        meta.refresh_device(build_device_meta("DEV", {}, tared, target_fps=60))
        document = self.on_disk()
        self.assertEqual(document["calibration"]["output_mode"], "tared")
        self.assertEqual(document["changes"], [{
            "at": "2026-10-16T06:30:00.000Z", "frame_seq": 2596,
            "field": "calibration.output_mode", "from": "raw", "to": "tared",
        }])
        # Not tracked: stays what it was when first known.
        self.assertEqual(document["device"]["hardware_model"], "TIA-CTL v1.5.F 2026.7")

    def test_stop_says_how_the_recording_ended_once(self):
        meta = self.meta()
        meta.stop("user")
        meta.stop("write_error: disk full")
        recording = self.on_disk()["recording"]
        self.assertEqual(recording["stopped_at"], "2026-10-16T06:30:00.000Z")
        self.assertEqual(recording["stop_reason"], "user")

    def test_a_failed_write_is_reported_not_raised(self):
        meta = self.meta()
        self.paths.directory.rmdir()
        self.assertFalse(meta.write())
        meta.on_frame(1, 1)
        meta.stop("user")


class ServiceRecordingTests(unittest.TestCase):
    def test_a_recording_is_a_folder_with_samples_and_meta(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {"NEWHORIZONS_DATA_ROOT": tmp}):
            service = NewHorizonsService(mock_mode=False)
            device_uid = "3CDC7545CCD0"
            service.set_recording_enabled(device_uid, True)
            for frame_id in range(5):
                packet = bytearray(20 + 4)
                struct.pack_into("<HBB", packet, 0, 0xA55A, 3, 0)
                packet[4:10] = bytes.fromhex(device_uid)
                struct.pack_into("<IIH", packet, 10, frame_id + 1, 123456 + frame_id, 4)
                struct.pack_into("<f", packet, 20, 315.0 + frame_id)
                service.record_gateway_packet(bytes(packet))
                if frame_id == 1:
                    service._record_status(device_uid, dict(FULL_STATUS))
                if frame_id == 3:
                    status = dict(FULL_STATUS, calibration=dict(FULL_STATUS["calibration"], output_mode="tared"))
                    service._record_status(device_uid, status)
            service.set_recording_enabled(device_uid, False)

            folders = [path for path in Path(tmp, device_uid).glob("*/*") if path.is_dir()]
            self.assertEqual(len(folders), 1)
            folder = folders[0]
            base = folder.name
            self.assertEqual(sorted(path.name for path in folder.iterdir()), [f"{base}.data.csv", f"{base}.meta.json"])
            with (folder / f"{base}.data.csv").open(newline="", encoding="utf-8") as handle:
                rows = list(csv.reader(handle))
            self.assertEqual(len(rows), 6)

            meta = json.loads((folder / f"{base}.meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["device"]["uid"], device_uid)
            self.assertEqual(meta["device"]["hardware_model"], "TIA-CTL v1.5.F 2026.7")
            self.assertEqual(meta["sensors"]["count"], 1)
            self.assertEqual(meta["sensors"]["matrix_shape"], {"rows": 8, "cols": 14})
            self.assertEqual(meta["recording"]["rows"], 5)
            self.assertEqual(meta["recording"]["first_frame_seq"], 1)
            self.assertEqual(meta["recording"]["last_frame_seq"], 5)
            self.assertEqual(meta["recording"]["stop_reason"], "user")
            self.assertIsNotNone(meta["recording"]["stopped_at"])
            self.assertEqual([change["field"] for change in meta["changes"]], ["calibration.output_mode"])
            self.assertEqual(meta["changes"][0]["frame_seq"], 4)


if __name__ == "__main__":
    unittest.main()
