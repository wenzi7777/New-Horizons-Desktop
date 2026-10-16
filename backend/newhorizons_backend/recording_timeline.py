"""A recording at a glance, for the CSV export page's preview.

The whole sample file is read once and boiled down to what a small chart
needs: the total pressure (the sum of the P columns) as a min/max pair per
time bucket, how long the recording runs, its rate, any lost frames or
pauses, and where its app events fall. A few kB instead of tens of MB; the
Data Analysis tool is where the rows themselves are looked at.

Results are cached per file (path, size and modification time), so selecting
a recording again is instant and a recording still being written is re-read.
"""

from __future__ import annotations

import csv
import re
import threading
from collections import OrderedDict
from pathlib import Path
from statistics import median
from typing import Any

from .recording_meta import sibling_paths

PRESSURE_COLUMN = re.compile(r"^P\d+$", re.IGNORECASE)
DEFAULT_BUCKETS = 240
MAX_EVENTS = 200
_CACHE_SIZE = 16

_cache: "OrderedDict[tuple[str, int, int, int], dict[str, Any]]" = OrderedDict()
_cache_lock = threading.Lock()


def _number(text: str) -> float | None:
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    return value if value == value and value not in (float("inf"), float("-inf")) else None


def _event_offsets(events_path: Path, start_ms: float) -> tuple[list[dict[str, Any]], int]:
    """(up to MAX_EVENTS events as {at_ms, label}, how many there are)."""
    try:
        handle = events_path.open(newline="", encoding="utf-8", errors="replace")
    except OSError:
        return [], 0
    markers: list[dict[str, Any]] = []
    total = 0
    with handle:
        for row in csv.DictReader(handle):
            timestamp = _number(row.get("timestamp_ms") or "")
            # A pre-v0.25.1 sidecar's timestamps are device uptime, not the
            # samples' clock: nowhere to put them on this timeline.
            if timestamp is None or (row.get("time_ref") or "") == "uptime":
                continue
            total += 1
            if len(markers) < MAX_EVENTS:
                label = " · ".join(part for part in (row.get("app"), row.get("event"), row.get("edge")) if part)
                markers.append({"at_ms": round(timestamp - start_ms), "label": label})
    return markers, total


def compute_timeline(data_path: Path, buckets: int = DEFAULT_BUCKETS) -> dict[str, Any]:
    times: list[float] = []
    totals: list[float] = []
    lost_frames = 0
    restarts = 0
    skipped = 0
    sensor_count = 0
    with data_path.open(newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.reader(handle)
        header = next(reader, [])
        columns = [cell.strip() for cell in header]
        time_column = columns.index("timestamp_ms") if "timestamp_ms" in columns else 0
        pressure = [index for index, name in enumerate(columns) if PRESSURE_COLUMN.match(name)]
        sensor_count = len(pressure)
        # The P columns are contiguous in every file the backend writes; a
        # slice is much cheaper than picking cells one by one.
        contiguous = bool(pressure) and pressure == list(range(pressure[0], pressure[-1] + 1))
        seq_column = columns.index("frame_seq") if "frame_seq" in columns else -1
        previous_seq: float | None = None
        for row in reader:
            if len(row) < len(columns):
                skipped += 1
                continue
            timestamp = _number(row[time_column])
            if timestamp is None:
                skipped += 1
                continue
            try:
                cells = row[pressure[0] : pressure[-1] + 1] if contiguous else [row[index] for index in pressure]
                total = sum(map(float, cells)) if cells else 0.0
            except ValueError:
                skipped += 1
                continue
            times.append(timestamp)
            totals.append(total)
            if seq_column >= 0:
                seq = _number(row[seq_column])
                if seq is not None and previous_seq is not None:
                    if seq < previous_seq:
                        restarts += 1
                    elif seq - previous_seq > 1:
                        lost_frames += int(seq - previous_seq - 1)
                previous_seq = seq if seq is not None else previous_seq

    rows = len(times)
    start = times[0] if rows else 0.0
    end = times[-1] if rows else 0.0
    duration = max(0.0, end - start)
    steps = [b - a for a, b in zip(times, times[1:])]
    typical = median(steps) if steps else 0.0
    gap_threshold = max(100.0, typical * 5)
    gaps = sum(1 for step in steps if step > gap_threshold)

    count = max(1, min(buckets, rows or 1))
    envelope: list[list[float] | None] = [None] * count
    span = duration or 1.0
    for timestamp, total in zip(times, totals):
        index = min(count - 1, max(0, int((timestamp - start) / span * count)))
        bucket = envelope[index]
        if bucket is None:
            envelope[index] = [total, total]
        else:
            if total < bucket[0]:
                bucket[0] = total
            if total > bucket[1]:
                bucket[1] = total

    events, events_total = _event_offsets(sibling_paths(data_path).events, start) if rows else ([], 0)
    return {
        "rows": rows,
        "skipped_lines": skipped,
        "sensor_count": sensor_count,
        "start_ms": round(start),
        "end_ms": round(end),
        "duration_ms": round(duration),
        "rate_hz": round((rows - 1) * 1000 / duration, 2) if duration > 0 else 0,
        "median_interval_ms": round(typical, 2),
        "lost_frames": lost_frames,
        "restarts": restarts,
        "gaps": gaps,
        "series": "total",
        "bucket_ms": duration / count if rows else 0,
        "buckets": [[round(pair[0], 3), round(pair[1], 3)] if pair is not None else None for pair in envelope],
        "max_value": round(max(totals), 3) if totals else 0,
        "events": events,
        "events_total": events_total,
    }


def timeline_for(data_path: Path, buckets: int = DEFAULT_BUCKETS) -> dict[str, Any]:
    stat = data_path.stat()
    key = (str(data_path), stat.st_size, stat.st_mtime_ns, buckets)
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None:
            _cache.move_to_end(key)
            return cached
    result = compute_timeline(data_path, buckets)
    with _cache_lock:
        _cache[key] = result
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return result
