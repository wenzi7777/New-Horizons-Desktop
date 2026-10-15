"""App events written beside the recorded samples.

The point of the sidecar is a join: an event says which frame it happened on,
and the sample CSV carries the same number. Without that, a detected heel
strike cannot be located in the data at all.
"""

import csv
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.app_event_log import (  # noqa: E402
    EVENT_COLUMNS,
    FrameClock,
    append_dropped_marker,
    append_events,
    events_lost_since,
    sidecar_path_for,
)


EVENTS = [
    {"seq": 1, "frame_seq": 18400, "ms": 1000, "app": "flow", "event": "heel_strike",
     "detail": "rise"},
    {"seq": 2, "frame_seq": 18418, "ms": 1300, "app": "flow", "event": "heel_strike",
     "detail": "fall"},
]


class SidecarTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.sample = Path(self._tmp.name) / "20260923" / "101500.csv"

    def read_rows(self):
        with sidecar_path_for(self.sample).open(encoding="utf-8") as handle:
            return list(csv.reader(handle))

    def test_the_sidecar_sits_beside_the_sample_file(self):
        self.assertEqual(sidecar_path_for(self.sample).name, "101500.events.csv")
        self.assertEqual(sidecar_path_for(self.sample).parent, self.sample.parent)

    def test_events_are_written_with_a_header(self):
        self.assertEqual(append_events(self.sample, EVENTS), 2)
        rows = self.read_rows()
        self.assertEqual(rows[0], EVENT_COLUMNS)
        self.assertEqual(len(rows), 3)

    def test_appending_does_not_repeat_the_header(self):
        append_events(self.sample, EVENTS[:1])
        append_events(self.sample, EVENTS[1:])
        rows = self.read_rows()
        self.assertEqual(rows.count(EVENT_COLUMNS), 1)
        self.assertEqual(len(rows), 3)

    def test_the_frame_sequence_survives_the_round_trip(self):
        # This column is the whole point: it is what joins an event to a sample.
        append_events(self.sample, EVENTS)
        rows = self.read_rows()
        frame_column = rows[0].index("frame_seq")
        self.assertEqual([row[frame_column] for row in rows[1:]], ["18400", "18418"])

    def test_a_valued_event_keeps_its_value(self):
        append_events(self.sample, [{"seq": 3, "frame_seq": 5, "ms": 9, "app": "flow",
                                     "event": "balance", "detail": "0.42", "value": 0.42}])
        rows = self.read_rows()
        self.assertEqual(rows[1][rows[0].index("value")], "0.42")

    def test_a_valueless_event_leaves_the_column_empty(self):
        append_events(self.sample, EVENTS[:1])
        rows = self.read_rows()
        self.assertEqual(rows[1][rows[0].index("value")], "")

    def test_nothing_is_written_for_no_events(self):
        self.assertEqual(append_events(self.sample, []), 0)
        self.assertFalse(sidecar_path_for(self.sample).exists())

    def test_malformed_events_are_skipped_not_fatal(self):
        self.assertEqual(append_events(self.sample, ["nonsense", {"seq": "x"}, EVENTS[0]]), 1)

    def test_dropped_events_are_recorded_as_a_marker(self):
        # A gap in the sequence would otherwise look the same as a quiet
        # period, which is the difference between "still" and "lost data".
        append_events(self.sample, EVENTS)
        append_dropped_marker(self.sample, 2, 5)
        rows = self.read_rows()
        self.assertEqual(rows[-1][rows[0].index("event")], "events_dropped")
        self.assertEqual(rows[-1][rows[0].index("edge")], "5")

    def test_no_marker_when_nothing_was_dropped(self):
        append_events(self.sample, EVENTS)
        append_dropped_marker(self.sample, 2, 0)
        self.assertEqual(len(self.read_rows()), 3)


class FrameClockTests(unittest.TestCase):
    """Events take their frame's time from the sample CSV, not the device's
    boot time, so both files of a recording share one time base."""

    def clock(self, frames=((100, 1_000_000), (101, 1_000_017), (103, 1_000_051))):
        clock = FrameClock()
        for frame_seq, timestamp in frames:
            clock.record(frame_seq, timestamp, "device")
        return clock

    def test_a_recorded_frame_gives_its_exact_time(self):
        self.assertEqual(self.clock().time_of(101), (1_000_017, "device"))

    def test_a_lost_frame_is_interpolated(self):
        self.assertEqual(self.clock().time_of(102), (1_000_034, "estimated"))

    def test_frames_outside_the_window_are_extrapolated(self):
        self.assertEqual(self.clock().time_of(105), (1_000_085, "estimated"))

    def test_an_event_on_no_frame_takes_the_latest_time(self):
        self.assertEqual(self.clock().time_of(0), (1_000_051, "estimated"))

    def test_nothing_recorded_gives_no_time(self):
        self.assertIsNone(FrameClock().time_of(5))

    def test_first_and_last_frames_are_tracked(self):
        clock = self.clock()
        self.assertEqual((clock.first, clock.last), (100, 103))

    def test_a_device_restart_starts_over(self):
        clock = self.clock()
        clock.record(3, 2_000_000, "device")
        self.assertEqual((clock.first, clock.last), (3, 3))
        self.assertEqual(clock.time_of(3), (2_000_000, "device"))

    def test_capacity_forgets_the_oldest_frames(self):
        clock = FrameClock(capacity=2)
        for frame_seq in (1, 2, 3):
            clock.record(frame_seq, frame_seq * 10, "device")
        self.assertEqual(clock.time_of(3), (30, "device"))
        self.assertEqual(clock.time_of(1), (10, "estimated"))


class EventTimestampTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.sample = Path(self._tmp.name) / "101500.csv"

    def read(self):
        with sidecar_path_for(self.sample).open(encoding="utf-8") as handle:
            return list(csv.DictReader(handle))

    def test_events_get_the_sample_time_and_keep_the_boot_time(self):
        clock = FrameClock()
        clock.record(18400, 1792056866161, "device")
        append_events(self.sample, [EVENTS[0]], clock)
        row = self.read()[0]
        self.assertEqual(row["timestamp_ms"], "1792056866161")
        self.assertEqual(row["uptime_ms"], "1000")
        self.assertEqual(row["time_ref"], "device")

    def test_without_a_recording_the_boot_time_is_labelled(self):
        append_events(self.sample, [EVENTS[0]])
        row = self.read()[0]
        self.assertEqual(row["timestamp_ms"], "1000")
        self.assertEqual(row["time_ref"], "uptime")

    def test_new_columns_are_appended_not_inserted(self):
        self.assertEqual(EVENT_COLUMNS[:7], ["seq", "frame_seq", "timestamp_ms", "app", "event", "edge", "value"])
        self.assertEqual(EVENT_COLUMNS[7:], ["uptime_ms", "time_ref"])


class CaptureTests(unittest.TestCase):
    """_capture_app_events on a service with a recording in progress."""

    UID = "80456B76AAF4"

    def setUp(self):
        from newhorizons_backend.service import NewHorizonsService

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.service = NewHorizonsService(mock_mode=False)
        self.sample = Path(self._tmp.name) / "101500.csv"
        self.clock = FrameClock()
        for frame_seq in range(2138, 2200):
            self.clock.record(frame_seq, 1792056856911 + (frame_seq - 2138) * 17, "device")
        with self.service._lock:
            self.service._recording_enabled.add(self.UID)
            self.service._csv_paths[self.UID] = self.sample
            self.service._csv_frame_clocks[self.UID] = self.clock

    def capture(self, *events, seq=None):
        seq = seq if seq is not None else max(event["seq"] for event in events)
        self.service._capture_app_events(self.UID, {"command": "app_events", "data": {"seq": seq, "events": list(events)}})

    @staticmethod
    def event(seq, frame_seq, ms):
        return {"seq": seq, "frame_seq": frame_seq, "ms": ms, "app": "flow", "event": "north", "detail": "rise"}

    def rows(self):
        path = sidecar_path_for(self.sample)
        if not path.exists():
            return []
        with path.open(encoding="utf-8") as handle:
            return list(csv.DictReader(handle))

    def test_events_from_before_the_recording_are_skipped(self):
        # The first poll asks for everything since boot.
        self.capture(self.event(1, 1, 9182), self.event(2, 2, 9195), self.event(3, 2150, 54802))
        rows = self.rows()
        self.assertEqual([row["seq"] for row in rows], ["3"])
        self.assertEqual(rows[0]["timestamp_ms"], str(1792056856911 + 12 * 17))
        self.assertEqual(self.service._app_event_seq[self.UID], 3)

    def test_an_event_ahead_of_the_samples_waits_for_its_frame(self):
        self.capture(self.event(1, 2150, 50000), self.event(2, 2300, 52000))
        self.assertEqual([row["seq"] for row in self.rows()], ["1"])
        # Read again from just before the held one.
        self.assertEqual(self.service._app_event_seq[self.UID], 1)
        self.clock.record(2300, 1792056860000, "device")
        self.capture(self.event(2, 2300, 52000))
        rows = self.rows()
        self.assertEqual([row["seq"] for row in rows], ["1", "2"])
        self.assertEqual(rows[1]["timestamp_ms"], "1792056860000")
        self.assertEqual(rows[1]["time_ref"], "device")

    def test_writing_samples_feeds_a_fresh_clock_per_recording(self):
        with self.service._lock:
            self.service._csv_paths.pop(self.UID)
            self.service._csv_frame_clocks.pop(self.UID)
        self.service._data_root = Path(self._tmp.name)
        for frame_seq in (10, 11):
            self.service._write_csv_sample(self.UID, {"p": [1, 2], "frame_id": frame_seq, "device_epoch_ms": 5000 + frame_seq})
        clock = self.service._csv_frame_clocks[self.UID]
        self.assertEqual((clock.first, clock.last), (10, 11))
        self.assertEqual(clock.time_of(11), (5011, "device"))

    def test_an_event_whose_frame_never_comes_is_written_estimated(self):
        self.service.APP_EVENT_HOLD_SEC = 0
        self.capture(self.event(1, 2300, 52000))
        self.assertEqual(self.rows(), [])
        self.capture(self.event(1, 2300, 52000))
        rows = self.rows()
        self.assertEqual([row["time_ref"] for row in rows], ["estimated"])


class StreamCaptureTests(CaptureTests):
    """Events that ride the stream packets (firmware v1.16.0+)."""

    def setUp(self):
        super().setUp()
        self.sent = []
        self.service.publish_command = lambda uid, payload: self.sent.append(dict(payload)) or {}

    def stream(self, *events):
        self.service._capture_streamed_app_events(self.UID, list(events))

    def test_streamed_events_get_their_frames_sample_time(self):
        self.stream(self.event(5, 2150, 50000))
        rows = self.rows()
        self.assertEqual(rows[0]["timestamp_ms"], str(1792056856911 + 12 * 17))
        self.assertEqual(rows[0]["time_ref"], "device")
        self.assertIn(self.UID, self.service._app_event_streaming)
        self.assertEqual(self.sent, [])

    def test_an_event_from_both_paths_is_written_once(self):
        self.stream(self.event(5, 2150, 50000))
        self.capture(self.event(5, 2150, 50000), seq=5)
        self.assertEqual([row["seq"] for row in self.rows()], ["5"])

    def test_a_gap_is_filled_from_the_device(self):
        self.stream(self.event(5, 2150, 50000))
        self.stream(self.event(8, 2160, 50200))
        # Asked from just before the gap, with its own request id.
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]["since_seq"], 5)
        self.assertEqual(self.service._app_event_missing[self.UID], {6, 7})
        reply = {"command": "app_events", "request_id": self.sent[0]["request_id"],
                 "data": {"seq": 8, "streaming": True,
                          "events": [self.event(6, 2152, 50050), self.event(7, 2155, 50100), self.event(8, 2160, 50200)]}}
        self.service._capture_app_events(self.UID, reply)
        self.assertEqual(sorted(int(row["seq"]) for row in self.rows()), [5, 6, 7, 8])
        self.assertNotIn(self.UID, self.service._app_event_missing)

    def test_what_the_repair_cannot_bring_back_is_marked_lost(self):
        self.stream(self.event(5, 2150, 50000))
        self.stream(self.event(8, 2160, 50200))
        # The ring had already dropped 6 and 7.
        reply = {"command": "app_events", "request_id": self.sent[0]["request_id"],
                 "data": {"seq": 8, "streaming": True, "events": [self.event(8, 2160, 50200)]}}
        self.service._capture_app_events(self.UID, reply)
        markers = [row for row in self.rows() if row["event"] == "events_dropped"]
        self.assertEqual([row["edge"] for row in markers], ["2"])
        self.assertEqual(markers[0]["time_ref"], "estimated")

    def test_an_unrelated_reply_does_not_settle_a_gap(self):
        self.stream(self.event(5, 2150, 50000))
        self.stream(self.event(8, 2160, 50200))
        reply = {"command": "app_events", "request_id": "someone-else",
                 "data": {"seq": 8, "streaming": True, "events": []}}
        self.service._capture_app_events(self.UID, reply)
        self.assertEqual(self.service._app_event_missing[self.UID], {6, 7})

    def test_a_restarted_device_starts_over(self):
        self.stream(self.event(40, 2150, 50000))
        self.stream(self.event(1, 2160, 900))
        self.assertEqual([row["seq"] for row in self.rows()], ["40", "1"])
        self.assertEqual(self.sent, [])

    def test_streaming_devices_are_checked_rarely(self):
        self.service._app_event_streaming.add(self.UID)
        self.service._app_event_requested_at[self.UID] = __import__("time").monotonic()
        loop = (BACKEND_ROOT / "newhorizons_backend" / "app_event_capture.py").read_text(encoding="utf-8")
        self.assertIn("self.APP_EVENT_STREAM_CHECK_SEC if device_uid in self._app_event_streaming else self.APP_EVENT_POLL_SEC", loop)
        self.assertGreaterEqual(self.service.APP_EVENT_STREAM_CHECK_SEC, 5.0)

    def test_the_stream_writes_after_the_sample(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "datagram_ingest.py").read_text(encoding="utf-8")
        record = source[source.index("def _record_parsed"):]
        self.assertLess(record.index("self._write_csv_sample(device_uid, payload)"),
                        record.index("self._capture_streamed_app_events(device_uid, payload[\"app_events\"])"))


class FirmwarePacketEndToEndTests(unittest.TestCase):
    """The firmware encoder's own packet (spec/fixtures/packets.json) through
    the ingest path: sample row first, then its events beside it."""

    FIXTURE = ROOT.parent / "NewHorizonsOS-OTA" / "spec" / "fixtures" / "packets.json"

    @unittest.skipUnless(FIXTURE.exists(), "NewHorizonsOS-OTA not checked out alongside")
    def test_events_in_a_stream_packet_land_in_the_sidecar(self):
        import json

        from newhorizons_backend.packet_parser import parse_binary_packet
        from newhorizons_backend.service import NewHorizonsService

        case = next(case for case in json.loads(self.FIXTURE.read_text(encoding="utf-8"))["packets"] if case["name"] == "app_events")
        uid = case["expect"]["device_uid"]
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        service = NewHorizonsService(mock_mode=False)
        service._data_root = Path(tmp.name)
        with service._lock:
            service._recording_enabled.add(uid)
        # The frame the events were raised on arrived first, as on a device.
        service._write_csv_sample(uid, {"p": [0.0, 0.0], "frame_id": 2689, "device_epoch_ms": 1792056866161})
        parsed = parse_binary_packet(bytes.fromhex(case["hex"]))
        service._record_parsed(uid, parsed, source="udp")
        with sidecar_path_for(service._csv_paths[uid]).open(encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual([row["seq"] for row in rows], ["3", "4"])
        self.assertEqual({row["timestamp_ms"] for row in rows}, {"1792056866161"})
        self.assertEqual([row["uptime_ms"] for row in rows], ["54802", "54803"])
        self.assertEqual(rows[1]["value"], "0.75")


class SampleAlignmentTests(unittest.TestCase):
    """The sample writer has to carry the same key the events do."""

    def test_the_sample_csv_carries_the_frame_sequence(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "service.py").read_text(encoding="utf-8")
        writer = source[source.index("def _write_csv_sample"):source.index("def _normalize_device_entry")]
        self.assertIn('"frame_seq"', writer)
        self.assertIn('payload.get("frame_id")', writer)

    def test_the_column_is_appended_not_inserted(self):
        # Inserting would shift every P column and break a positional reader
        # written against an older export.
        source = (BACKEND_ROOT / "newhorizons_backend" / "service.py").read_text(encoding="utf-8")
        writer = source[source.index("def _write_csv_sample"):source.index("def _normalize_device_entry")]
        header = writer[writer.index('["timestamp_ms"]'):writer.index("writer.writerow(\n                [timestamp]")]
        self.assertLess(header.index('"Acc_z"'), header.index('"frame_seq"'))


class LossAccountingTests(unittest.TestCase):
    """Loss is a gap in sequence numbers, not the firmware's dropped counter.

    The firmware counts every event pushed out of its ring since boot, read or
    not. Using it as "lost" stamped an events_dropped row into the sidecar on
    every poll once the ring had wrapped once -- data loss that never happened.
    """

    @staticmethod
    def page(*seqs):
        return [{"seq": seq} for seq in seqs]

    def test_contiguous_reads_lose_nothing(self):
        self.assertEqual(events_lost_since(10, 13, self.page(11, 12, 13)), 0)

    def test_nothing_new_loses_nothing(self):
        self.assertEqual(events_lost_since(10, 10, []), 0)

    def test_a_gap_is_counted(self):
        # 11..14 were overwritten before this read.
        self.assertEqual(events_lost_since(10, 20, self.page(15, 16, 20)), 4)

    def test_everything_rolled_off(self):
        self.assertEqual(events_lost_since(10, 60, []), 50)

    def test_the_first_read_has_no_baseline(self):
        self.assertEqual(events_lost_since(0, 900, self.page(869, 900)), 0)

    def test_the_cumulative_counter_is_not_used(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "app_event_capture.py").read_text(encoding="utf-8")
        capture = source[source.index("def _capture_app_events"):source.index("def _app_event_hold_expired")]
        self.assertIn("events_lost_since(previous, device_seq, events)", capture)
        self.assertNotIn('dropped = int(data.get("dropped")', capture)

    def test_a_device_restart_resets_the_baseline(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "app_event_capture.py").read_text(encoding="utf-8")
        capture = source[source.index("def _capture_app_events"):source.index("def _app_event_hold_expired")]
        self.assertIn("if previous and device_seq < previous:", capture)


class PollerTests(unittest.TestCase):
    def test_the_backend_polls_only_while_recording(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "app_event_capture.py").read_text(encoding="utf-8")
        loop = source[source.index("def _app_event_loop"):source.index("def _request_app_events")]
        # The thread parks itself rather than polling devices nobody records.
        self.assertIn("if not recording:", loop)
        self.assertIn("return", loop)

    def test_a_failed_sidecar_write_does_not_stop_the_recording(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "app_event_capture.py").read_text(encoding="utf-8")
        capture = source[source.index("def _capture_app_events"):source.index("def _app_event_hold_expired")]
        self.assertIn("except OSError:", capture)

    def test_capture_ignores_devices_that_are_not_recording(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "app_event_capture.py").read_text(encoding="utf-8")
        capture = source[source.index("def _capture_app_events"):source.index("def _app_event_hold_expired")]
        self.assertIn("if device_uid not in self._recording_enabled:", capture)


if __name__ == "__main__":
    unittest.main()


class PollerStopTests(unittest.TestCase):
    def test_stopping_the_service_stops_the_poller(self):
        # stop() never set _app_event_stop, so a poller started by a recording
        # kept running (and polling) after the service was stopped.
        from newhorizons_backend.service import NewHorizonsService

        service = NewHorizonsService(mock_mode=False)
        service.APP_EVENT_POLL_SEC = 0.01
        with service._lock:
            service._recording_enabled.add("80456B76AAF4")
        service._ensure_app_event_poller()
        thread = service._app_event_thread
        self.assertTrue(thread.is_alive())
        service.stop()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
