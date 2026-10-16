import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.recording_timeline import compute_timeline, timeline_for  # noqa: E402

HEADER = "timestamp_ms,P1,P2,P3,Acc_x,frame_seq,time_ref"


def write_recording(folder: Path, rows: list[str], events: list[str] | None = None) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    data = folder / "062756.data.csv"
    data.write_text("\n".join([HEADER, *rows]) + "\n", encoding="utf-8")
    if events is not None:
        (folder / "062756.events.csv").write_text(
            "\n".join(["seq,frame_seq,timestamp_ms,app,event,edge,value,uptime_ms,time_ref", *events]) + "\n",
            encoding="utf-8",
        )
    return data


class TimelineTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.folder = Path(self._tmp.name) / "062756"

    def test_duration_rate_and_the_total_pressure_envelope(self):
        rows = [f"{1000 + index * 20},{index},1,0,0.1,{index + 1},device" for index in range(11)]
        timeline = compute_timeline(write_recording(self.folder, rows), buckets=2)
        self.assertEqual(timeline["rows"], 11)
        self.assertEqual(timeline["sensor_count"], 3)
        self.assertEqual(timeline["duration_ms"], 200)
        self.assertEqual(timeline["rate_hz"], 50.0)
        self.assertEqual((timeline["lost_frames"], timeline["gaps"], timeline["restarts"]), (0, 0, 0))
        # Total = P1 + P2 + P3 = index + 1; first half 0..9 ms -> rows 0..4.
        self.assertEqual(timeline["buckets"], [[1.0, 5.0], [6.0, 11.0]])
        self.assertEqual(timeline["max_value"], 11.0)

    def test_lost_frames_pauses_and_restarts(self):
        rows = [
            "1000,0,0,0,0,1,device",
            "1017,0,0,0,0,2,device",
            "1067,0,0,0,0,5,device",   # frames 3, 4 lost
            "1084,0,0,0,0,6,device",
            "3084,0,0,0,0,7,device",   # 2 s without data
            "3101,0,0,0,0,1,device",   # the device restarted
        ]
        timeline = compute_timeline(write_recording(self.folder, rows))
        self.assertEqual(timeline["lost_frames"], 2)
        self.assertEqual(timeline["gaps"], 1)
        self.assertEqual(timeline["restarts"], 1)

    def test_events_are_placed_from_the_start_and_uptime_ones_left_out(self):
        rows = [f"{1000 + index * 20},0,0,0,0,{index + 1},device" for index in range(5)]
        events = [
            "1,2,1020,flow,magnet,rise,,5000,device",
            "2,0,99999,flow,events_dropped,3,,99999,uptime",
        ]
        timeline = compute_timeline(write_recording(self.folder, rows, events))
        self.assertEqual(timeline["events"], [{"at_ms": 20, "label": "flow · magnet · rise"}])
        self.assertEqual(timeline["events_total"], 1)

    def test_garbled_lines_are_skipped(self):
        rows = ["1000,1,1,1,0,1,device", "1020,1,oops", "1040,2,2,2,0,3,device"]
        timeline = compute_timeline(write_recording(self.folder, rows))
        self.assertEqual(timeline["rows"], 2)
        self.assertEqual(timeline["skipped_lines"], 1)

    def test_cached_until_the_file_changes(self):
        data = write_recording(self.folder, ["1000,1,0,0,0,1,device", "1020,1,0,0,0,2,device"])
        first = timeline_for(data)
        self.assertIs(timeline_for(data), first)
        with data.open("a", encoding="utf-8") as handle:
            handle.write("1040,1,0,0,0,3,device\n")
        self.assertEqual(timeline_for(data)["rows"], 3)


if __name__ == "__main__":
    unittest.main()
