import csv
import json
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

from newhorizons_backend.recording_meta import RecordingMeta, new_recording_paths  # noqa: E402
from newhorizons_backend.recording_session import LagTracker, RecordingSession, RecordingWriter  # noqa: E402
from newhorizons_backend.service import NewHorizonsService  # noqa: E402

EPOCH = 1792132076000


class FakeClock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


def read_rows(path: Path):
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.reader(handle))


class WriterTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "a" / "x.data.csv"
        self.clock = FakeClock()

    def test_rows_are_buffered_and_flushed_once_a_second(self):
        writer = RecordingWriter(self.path, monotonic=self.clock)
        writer.write(lambda: ["h"], [1])
        writer.write(lambda: ["h"], [2])
        self.assertEqual(self.path.read_text(), "")
        self.clock.now += RecordingWriter.FLUSH_EVERY_SEC
        writer.write(lambda: ["h"], [3])
        self.assertEqual(read_rows(self.path), [["h"], ["1"], ["2"], ["3"]])
        writer.write(lambda: ["h"], [4])
        writer.close()
        self.assertEqual(read_rows(self.path)[-1], ["4"])
        # Closed: a late frame is ignored rather than reopening the file.
        writer.write(lambda: ["h"], [5])
        self.assertEqual(read_rows(self.path)[-1], ["4"])

    def test_an_existing_file_is_appended_to_without_a_second_header(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("h\n1\n", encoding="utf-8")
        writer = RecordingWriter(self.path, monotonic=self.clock)
        writer.write(lambda: ["h"], [2])
        writer.close()
        self.assertEqual(read_rows(self.path), [["h"], ["1"], ["2"]])


class LagTrackerTests(unittest.TestCase):
    def test_keeping_up_is_no_lag_whatever_the_clock_offset(self):
        clock = FakeClock()
        lag = LagTracker(monotonic=clock)
        for index in range(10):
            # The device's clock is hours off; only elapsed time matters.
            self.assertAlmostEqual(lag.observe(EPOCH + 3_600_000 + index * 17), 0.0, places=6)
            clock.now += 0.017

    def test_falling_behind_shows_as_lag(self):
        clock = FakeClock()
        lag = LagTracker(monotonic=clock)
        lag.observe(EPOCH)
        for index in range(1, 101):
            clock.now += 0.017 / 0.41  # handled at 0.41x real time
            lag.observe(EPOCH + index * 17)
        self.assertAlmostEqual(lag.lag_ms, 100 * 17 / 0.41 - 100 * 17, delta=1)
        self.assertEqual(lag.max_lag_ms, lag.lag_ms)
        # The frame scanned now is the backlog ahead of the last one written.
        self.assertAlmostEqual(lag.device_ms_now(), EPOCH + 100 * 17 + lag.lag_ms, delta=1)

    def test_catching_up_and_a_late_first_frame(self):
        clock = FakeClock()
        lag = LagTracker(monotonic=clock)
        # The first frame was already queued: later frames come through faster.
        lag.observe(EPOCH)
        clock.now += 0.001
        self.assertEqual(lag.observe(EPOCH + 500), 0.0)
        clock.now += 0.017
        self.assertAlmostEqual(lag.observe(EPOCH + 517), 0.0, places=6)

    def test_a_device_restart_starts_over(self):
        clock = FakeClock()
        lag = LagTracker(monotonic=clock)
        lag.observe(EPOCH)
        clock.now += 10
        lag.observe(EPOCH + 1000)
        self.assertGreater(lag.lag_ms, 8000)
        self.assertEqual(lag.observe(EPOCH - 50_000), 0.0)


class SessionDrainTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.clock = FakeClock()
        started = datetime(2026, 10, 27, 6, 54, 54, tzinfo=timezone.utc)
        paths = new_recording_paths(Path(self._tmp.name), "DEV", started)
        meta = RecordingMeta(paths, {}, started_at=started, first_frame_seq=1, first_timestamp_ms=EPOCH,
                             monotonic=self.clock, wall=lambda: datetime(2026, 10, 27, 7, 0, 0, tzinfo=timezone.utc))
        self.session = RecordingSession(paths, meta, monotonic=self.clock)
        self.addCleanup(self.session.writer.close)

    def frame(self, index):
        return self.session.write(lambda: ["timestamp_ms", "frame_seq"], [EPOCH + index * 17, index], index, EPOCH + index * 17, True)

    def behind(self, frames=100, speed=0.41):
        for index in range(frames):
            self.assertIsNone(self.frame(index))
            self.clock.now += 0.017 / speed

    def test_stop_without_a_backlog_is_immediate(self):
        self.behind(speed=1.0)
        self.assertIsNone(self.session.begin_drain())
        self.assertFalse(self.session.draining)

    def test_stop_waits_for_the_frame_scanned_at_that_moment(self):
        self.behind()
        wait = self.session.begin_drain()
        self.assertIsNotNone(wait)
        self.assertTrue(self.session.draining)
        target = self.session.drain_until_device_ms
        last_needed = int((target - EPOCH) // 17) + 1
        # Frames already queued keep being written...
        for index in range(100, last_needed):
            self.assertIsNone(self.frame(index))
            self.clock.now += 0.001  # cheap writes drain the queue quickly
        # ...until the one scanned when Stop was pressed.
        self.assertEqual(self.frame(last_needed), "user")
        self.assertIsNotNone(self.session.meta.document["recording"]["stop_requested_at"])
        self.assertGreater(self.session.meta.document["recording"]["max_lag_ms"], 2000)

    def test_a_stuck_stream_gives_up_after_the_wait(self):
        self.behind()
        wait = self.session.begin_drain()
        self.clock.now += wait
        self.assertEqual(self.frame(101), "user_drain_timeout")


class ServiceDrainTests(unittest.TestCase):
    """A recording that falls behind is written up to the moment Stop was
    pressed, not cut at whatever had been handled by then."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        patcher = patch.dict("os.environ", {"NEWHORIZONS_DATA_ROOT": self._tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.service = NewHorizonsService(mock_mode=False)
        self.addCleanup(self.service.stop)
        self.events = []
        self.service.add_event_listener(self.events.append)
        self.uid = "80456B76AB00"
        self.clock = FakeClock()

    def send(self, index):
        self.service._record_parsed(self.uid, {"p": [1.0, 2.0], "frame_id": index + 1, "device_epoch_ms": EPOCH + index * 17}, "test")

    def start_behind(self, frames=100):
        self.service.set_recording_enabled(self.uid, True)
        self.send(0)
        session = self.service._recording_sessions[self.uid]
        # Handle the rest at 0.41x real time, on a clock the test controls.
        session._monotonic = self.clock
        session.writer._monotonic = self.clock
        session.lag = LagTracker(monotonic=self.clock)
        session.lag.observe(EPOCH)
        for index in range(1, frames):
            self.clock.now += 0.017 / 0.41
            self.send(index)
        return session

    def data_rows(self, session):
        return read_rows(session.paths.data)[1:]

    def test_stop_finishes_once_the_queued_frames_are_written(self):
        session = self.start_behind()
        with patch("newhorizons_backend.service.threading.Timer"):
            result = self.service.set_recording_enabled(self.uid, False)
        self.assertTrue(result["finishing"])
        self.assertTrue(self.service._devices[self.uid]["recording_finishing"])
        index = 100
        while self.uid in self.service._recording_sessions:
            self.send(index)
            self.clock.now += 0.001
            index += 1
            self.assertLess(index, 10_000)
        rows = self.data_rows(session)
        self.assertEqual(len(rows), index)
        self.assertGreaterEqual(int(rows[-1][0]), session.drain_until_device_ms)
        meta = json.loads(session.paths.meta.read_text(encoding="utf-8"))
        self.assertEqual(meta["recording"]["stop_reason"], "user")
        self.assertEqual(meta["recording"]["rows"], index)
        updates = [event for event in self.events if event.get("type") == "recording_update"]
        self.assertEqual(updates[-1], {"type": "recording_update", "device_uid": self.uid, "enabled": False, "finishing": False})
        self.assertFalse(self.service._devices[self.uid]["recording_finishing"])
        # A frame after that is not recorded, and starts no new recording.
        self.send(index)
        self.assertEqual(len(self.data_rows(session)), index)
        self.assertEqual(len([path for path in Path(self._tmp.name, self.uid).glob("*/*") if path.is_dir()]), 1)

    def test_the_lag_rides_on_the_live_frame(self):
        self.start_behind()
        payload = self.service._latest_visualization[self.uid]
        self.assertGreater(payload["recording_lag_ms"], 2000)

    def test_a_stream_that_stops_ends_when_the_wait_runs_out(self):
        session = self.start_behind()
        with patch("newhorizons_backend.service.threading.Timer") as timer:
            self.service.set_recording_enabled(self.uid, False)
        _, kwargs = timer.call_args
        self.assertEqual(kwargs["args"], (self.uid, "user_drain_timeout", session))
        self.service._finish_recording(*kwargs["args"])
        meta = json.loads(session.paths.meta.read_text(encoding="utf-8"))
        self.assertEqual(meta["recording"]["stop_reason"], "user_drain_timeout")
        self.assertNotIn(self.uid, self.service._recording_sessions)

    def test_recording_again_while_finishing_ends_the_last_recording_there(self):
        first = self.start_behind()
        with patch("newhorizons_backend.service.threading.Timer"):
            self.service.set_recording_enabled(self.uid, False)
            self.service.set_recording_enabled(self.uid, True)
        self.assertTrue(first.writer.closed)
        self.assertIsNotNone(json.loads(first.paths.meta.read_text(encoding="utf-8"))["recording"]["stopped_at"])
        self.send(500)
        second = self.service._recording_sessions[self.uid]
        self.assertIsNot(second, first)

    def test_stopping_the_service_writes_out_and_ends_recordings(self):
        session = self.start_behind(frames=5)
        self.service.stop()
        self.assertTrue(session.writer.closed)
        self.assertEqual(len(self.data_rows(session)), 5)
        meta = json.loads(session.paths.meta.read_text(encoding="utf-8"))
        self.assertEqual(meta["recording"]["stop_reason"], "server_stopped")


class ThroughputTests(unittest.TestCase):
    def test_a_frame_costs_no_file_open(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {"NEWHORIZONS_DATA_ROOT": tmp}):
            service = NewHorizonsService(mock_mode=False)
            service.set_recording_enabled("80456B76AB00", True)
            service._record_parsed("80456B76AB00", {"p": [1.0], "frame_id": 1}, "test")
            opened = []
            original = Path.open

            def counting_open(path, *args, **kwargs):
                opened.append(path)
                return original(path, *args, **kwargs)

            with patch.object(Path, "open", counting_open):
                for index in range(2, 200):
                    service._record_parsed("80456B76AB00", {"p": [1.0], "frame_id": index}, "test")
            self.assertEqual([path for path in opened if path.name.endswith(".data.csv")], [])
            service.stop()


if __name__ == "__main__":
    unittest.main()
