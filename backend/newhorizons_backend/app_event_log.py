"""Writing app events beside the recorded samples.

An app that detects a heel strike is useless for research if nobody can say
which frame it happened on. The device stamps every event with the frame's own
sequence number, and the sample CSV carries the same number, so the two files
join on one column.

Timestamps: the device stamps an event with millis() (time since boot), the
sample CSV with the wall clock of the frame's scan. An event's `timestamp_ms`
is therefore taken from its frame's row in the sample CSV (FrameClock), so the
two files share one time base; the device's own boot time is kept as
`uptime_ms`, and `time_ref` says where `timestamp_ms` came from:

- `device` / `received`: copied from the frame's sample row (see
  service._csv_time_ref());
- `estimated`: that frame's row is missing (lost on the way), or the event
  belongs to no frame (a lost-events marker), so the time is interpolated or
  extrapolated from the frames around it;
- `uptime`: no recording to take the time from; `timestamp_ms` is the device's
  boot time, as before Desktop v0.25.1.

Kept separate from service.py because it is pure file work: given events and a
sample path, append rows. That makes it testable without a running service.
"""

from __future__ import annotations

import bisect
import csv
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterable

from .recording_meta import EVENTS_SUFFIX, sibling_paths


# timestamp_ms used to be the device's boot time; uptime_ms and time_ref are
# appended rather than inserted so a positional reader keeps working.
EVENT_COLUMNS = ["seq", "frame_seq", "timestamp_ms", "app", "event", "edge", "value", "uptime_ms", "time_ref"]


class FrameClock:
    """When each recorded frame was sampled, for one recording.

    Fed by every sample row written (frame_seq -> timestamp_ms, time_ref), and
    asked by the event writer. Bounded: the oldest frames are forgotten past
    `capacity`, which at 60 fps is a little over two minutes -- far more than
    the half-second event poll ever lags.
    """

    def __init__(self, capacity: int = 8192):
        self._capacity = capacity
        self._lock = threading.Lock()
        self._times: OrderedDict[int, tuple[int, str]] = OrderedDict()
        #: The recording's first frame: events before it happened before the
        #: recording started.
        self.first = 0
        #: The newest frame recorded so far.
        self.last = 0

    def record(self, frame_seq: int, timestamp_ms: int, time_ref: str) -> None:
        if frame_seq <= 0:
            return
        with self._lock:
            if self.last and frame_seq < self.last:
                # The device restarted and counts frames from 1 again: the old
                # numbers mean nothing now.
                self._times.clear()
                self.first = 0
                self.last = 0
            if not self.first:
                self.first = frame_seq
            self._times[frame_seq] = (int(timestamp_ms), time_ref)
            self.last = max(self.last, frame_seq)
            while len(self._times) > self._capacity:
                self._times.popitem(last=False)

    def time_of(self, frame_seq: int) -> tuple[int, str] | None:
        """(timestamp_ms, time_ref) of a frame, exact when its row was written,
        otherwise estimated from the frames around it. None before any frame."""
        with self._lock:
            if not self._times:
                return None
            exact = self._times.get(frame_seq)
            if exact is not None:
                return exact
            frames = list(self._times)  # ascending: recorded in frame order
            if frame_seq <= 0:
                # Not tied to a frame (a lost-events marker): the latest time.
                return self._times[frames[-1]][0], "estimated"
            index = bisect.bisect_left(frames, frame_seq)
            if 0 < index < len(frames):
                lo, hi = frames[index - 1], frames[index]
            elif len(frames) >= 2:
                # Outside what is held: extrapolate from the nearest two.
                lo, hi = (frames[0], frames[1]) if index == 0 else (frames[-2], frames[-1])
            else:
                return self._times[frames[0]][0], "estimated"
            t_lo, t_hi = self._times[lo][0], self._times[hi][0]
            return round(t_lo + (t_hi - t_lo) * (frame_seq - lo) / (hi - lo)), "estimated"

#: Written next to the samples, so the pair travels together:
#: `<HHMMSS>.data.csv` -> `<HHMMSS>.events.csv`, and for recordings from
#: before v0.27.0, `<HHMMSS>.csv` -> `<HHMMSS>.events.csv`.
SIDECAR_SUFFIX = EVENTS_SUFFIX


def sidecar_path_for(sample_path: Path) -> Path:
    return sibling_paths(sample_path).events


def append_events(sample_path: Path, events: Iterable[dict[str, Any]], clock: FrameClock | None = None) -> int:
    """Append events to the sidecar for `sample_path`. Returns rows written.

    With the recording's FrameClock, timestamp_ms is the frame's sample time;
    without one it stays the device's boot time (time_ref "uptime")."""
    rows = [event_row(event, clock) for event in events]
    rows = [row for row in rows if row is not None]
    if not rows:
        return 0

    target = sidecar_path_for(sample_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    is_new = not target.exists()
    with target.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        if is_new:
            writer.writerow(EVENT_COLUMNS)
        writer.writerows(rows)
    return len(rows)


def events_lost_since(previous_seq: int, device_seq: int, events: list[Any]) -> int:
    """How many events fell out of the device's ring between two reads.

    The firmware's own ``dropped`` counts every event ever pushed out of its
    ring since boot, read or not, so it grows forever once the ring has wrapped
    and says nothing about *this* reader. The honest measure is the gap in
    sequence numbers: everything after ``previous_seq`` should have come back,
    so whatever is missing before the oldest returned event was overwritten
    before we asked.
    """
    if previous_seq <= 0:
        return 0
    seqs = []
    for event in events:
        if isinstance(event, dict):
            try:
                seqs.append(int(event.get("seq") or 0))
            except (TypeError, ValueError):
                continue
    seqs = [seq for seq in seqs if seq > previous_seq]
    # Nothing came back although the device moved on: all of it rolled off.
    oldest = min(seqs) if seqs else device_seq + 1
    return max(0, oldest - previous_seq - 1)


def append_dropped_marker(sample_path: Path, seq: int, dropped: int, clock: FrameClock | None = None) -> None:
    """Record that events were lost before anyone read them.

    A gap in the sequence numbers would otherwise be indistinguishable from a
    period when nothing happened, which for an analyst is the difference
    between "the subject was still" and "we lost data".
    """
    if dropped <= 0:
        return
    append_events(sample_path, [{
        "seq": seq,
        "frame_seq": 0,
        "ms": 0,
        "app": "",
        "event": "events_dropped",
        "detail": str(dropped),
    }], clock)


def event_row(event: dict[str, Any], clock: FrameClock | None = None) -> list[Any] | None:
    """One sidecar row (EVENT_COLUMNS) for a device app event, or None."""
    if not isinstance(event, dict):
        return None
    try:
        seq = int(event.get("seq") or 0)
        frame_seq = int(event.get("frame_seq") or 0)
        uptime_ms = int(event.get("ms") or 0)
    except (TypeError, ValueError):
        return None
    value = event.get("value")
    stamped = clock.time_of(frame_seq) if clock is not None else None
    timestamp_ms, time_ref = stamped if stamped is not None else (uptime_ms, "uptime")
    return [
        seq,
        frame_seq,
        timestamp_ms,
        str(event.get("app") or ""),
        str(event.get("event") or ""),
        str(event.get("detail") or ""),
        "" if value is None else value,
        uptime_ms,
        time_ref,
    ]
