#!/usr/bin/env python3
"""Give an existing recording's .events.csv the sample CSV's time base.

Before Desktop v0.25.1 an app event's timestamp_ms was the device's time since
boot (millis()), while the sample CSV beside it carries the wall-clock time of
each frame's scan; and the first poll also wrote events from before the
recording started. This rewrites `<recording>.events.csv` the way the backend
now writes it: timestamp_ms is the time of the event's frame in
`<recording>.csv` (interpolated for a frame whose row is missing), the boot
time moves to uptime_ms, time_ref says which, and events from before the
recording's first frame are dropped. The original is kept as
`<recording>.events.csv.bak`.

Takes either layout (recording_meta.py): `<HHMMSS>/<HHMMSS>.data.csv` from
v0.27.0 on, or the flat `<HHMMSS>.csv` from before -- or any file of a
recording, its .events.csv included.

Usage: scripts/fix_event_timestamps.py [--dry-run] RECORDING.data.csv|RECORDING.csv [...]
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from newhorizons_backend.app_event_log import EVENT_COLUMNS, FrameClock, event_row, sidecar_path_for  # noqa: E402
from newhorizons_backend.recording_meta import sibling_paths  # noqa: E402


def load_clock(sample_path: Path) -> tuple[FrameClock, bool]:
    """The recording's frame times, and whether the device restarted in it."""
    clock = FrameClock(capacity=10**9)
    restarted = False
    with sample_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = next(reader, [])
        if "timestamp_ms" not in header or "frame_seq" not in header:
            raise ValueError("no timestamp_ms/frame_seq columns (recorded before frame_seq existed)")
        ts_at, frame_at = header.index("timestamp_ms"), header.index("frame_seq")
        ref_at = header.index("time_ref") if "time_ref" in header else -1
        for row in reader:
            try:
                frame_seq, timestamp = int(row[frame_at]), int(float(row[ts_at]))
            except (IndexError, ValueError):
                continue
            if clock.last and frame_seq < clock.last:
                restarted = True
            clock.record(frame_seq, timestamp, row[ref_at] if ref_at >= 0 else "unknown")
    return clock, restarted


def load_events(events_path: Path) -> list[dict[str, object]]:
    with events_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    events = []
    for row in rows:
        # Already rewritten: the boot time is in uptime_ms.
        boot_ms = row.get("uptime_ms") or row.get("timestamp_ms") or "0"
        events.append({
            "seq": row.get("seq"),
            "frame_seq": row.get("frame_seq"),
            "ms": int(float(boot_ms or 0)),
            "app": row.get("app", ""),
            "event": row.get("event", ""),
            "detail": row.get("edge", ""),
            "value": row.get("value") or None,
        })
    return events


def fix(sample_path: Path, dry_run: bool) -> None:
    events_path = sidecar_path_for(sample_path)
    if not events_path.exists():
        print(f"{sample_path}: no {events_path.name}, skipped")
        return
    clock, restarted = load_clock(sample_path)
    if not clock.last:
        print(f"{sample_path}: no samples, skipped")
        return
    events = load_events(events_path)
    kept = [e for e in events if not (int(e["frame_seq"] or 0) and int(e["frame_seq"] or 0) < clock.first)]
    rows = [row for row in (event_row(event, clock) for event in kept) if row is not None]
    print(f"{sample_path}: frames {clock.first}..{clock.last}, {len(events)} events, "
          f"{len(events) - len(kept)} from before the recording dropped, {len(rows)} written")
    if restarted:
        print("  note: the device restarted during this recording; events before the restart get estimated times")
    for row in rows:
        print("  " + ",".join(str(cell) for cell in row))
    if dry_run:
        return
    backup = events_path.with_name(events_path.name + ".bak")
    if not backup.exists():
        shutil.copy2(events_path, backup)
    temporary = events_path.with_name(events_path.name + ".tmp")
    with temporary.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(EVENT_COLUMNS)
        writer.writerows(rows)
    temporary.replace(events_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="print the rewritten rows, change nothing")
    parser.add_argument("recordings", nargs="+", type=Path, help="a recording's sample CSV (or any of its files)")
    args = parser.parse_args()
    status = 0
    for path in args.recordings:
        path = sibling_paths(path).data
        try:
            fix(path, args.dry_run)
        except (OSError, ValueError) as exc:
            print(f"{path}: {exc}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
