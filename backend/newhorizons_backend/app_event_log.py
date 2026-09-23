"""Writing app events beside the recorded samples.

An app that detects a heel strike is useless for research if nobody can say
which frame it happened on. The device stamps every event with the frame's own
sequence number, and the sample CSV carries the same number, so the two files
join on one column.

Kept separate from service.py because it is pure file work: given events and a
sample path, append rows. That makes it testable without a running service.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Iterable


EVENT_COLUMNS = ["seq", "frame_seq", "timestamp_ms", "app", "event", "edge", "value"]

#: Written next to `<session>.csv`, so the pair travels together.
SIDECAR_SUFFIX = ".events.csv"


def sidecar_path_for(sample_path: Path) -> Path:
    return sample_path.with_suffix("") .with_name(sample_path.stem + SIDECAR_SUFFIX)


def append_events(sample_path: Path, events: Iterable[dict[str, Any]]) -> int:
    """Append events to the sidecar for `sample_path`. Returns rows written."""
    rows = [_row(event) for event in events]
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


def append_dropped_marker(sample_path: Path, seq: int, dropped: int) -> None:
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
    }])


def _row(event: dict[str, Any]) -> list[Any] | None:
    if not isinstance(event, dict):
        return None
    try:
        seq = int(event.get("seq") or 0)
    except (TypeError, ValueError):
        return None
    value = event.get("value")
    return [
        seq,
        int(event.get("frame_seq") or 0),
        int(event.get("ms") or 0),
        str(event.get("app") or ""),
        str(event.get("event") or ""),
        str(event.get("detail") or ""),
        "" if value is None else value,
    ]
