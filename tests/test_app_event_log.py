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
        self.assertEqual(self.read_rows()[1][-1], "0.42")

    def test_a_valueless_event_leaves_the_column_empty(self):
        append_events(self.sample, EVENTS[:1])
        self.assertEqual(self.read_rows()[1][-1], "")

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
        source = (BACKEND_ROOT / "newhorizons_backend" / "service.py").read_text(encoding="utf-8")
        capture = source[source.index("def _capture_app_events"):source.index("def _record_result")]
        self.assertIn("events_lost_since(previous, device_seq, events)", capture)
        self.assertNotIn('dropped = int(data.get("dropped")', capture)

    def test_a_device_restart_resets_the_baseline(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "service.py").read_text(encoding="utf-8")
        capture = source[source.index("def _capture_app_events"):source.index("def _record_result")]
        self.assertIn("if previous and device_seq < previous:", capture)


class PollerTests(unittest.TestCase):
    def test_the_backend_polls_only_while_recording(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "service.py").read_text(encoding="utf-8")
        loop = source[source.index("def _app_event_loop"):source.index("def _capture_app_events")]
        # The thread parks itself rather than polling devices nobody records.
        self.assertIn("if not recording:", loop)
        self.assertIn("return", loop)

    def test_a_failed_sidecar_write_does_not_stop_the_recording(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "service.py").read_text(encoding="utf-8")
        capture = source[source.index("def _capture_app_events"):source.index("def _record_result")]
        self.assertIn("except OSError:", capture)

    def test_capture_ignores_devices_that_are_not_recording(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "service.py").read_text(encoding="utf-8")
        capture = source[source.index("def _capture_app_events"):source.index("def _record_result")]
        self.assertIn("if device_uid not in self._recording_enabled:", capture)


if __name__ == "__main__":
    unittest.main()
