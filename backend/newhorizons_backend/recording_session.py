"""One recording in progress: its sample file, how far behind it is, and
how it finishes.

Why this exists (2026-10-28): a gateway's frames are handled one after
another on that gateway's WebSocket thread, and Flask-Sock's simple_websocket
reads the socket on a thread of its own into an unbounded list. Handling that
falls behind therefore loses nothing and slows nobody down -- it just queues,
silently, in memory. Writing a sample used to cost a mkdir, an exists(), an
open() and a close() per frame; on the lab server that was ~7 ms, so six
boards at 60 fps were written at ~0.41x real time, and pressing Stop threw
away whatever was still queued: a 6-minute recording held 2:27.

So:

- RecordingWriter keeps the file open with a large buffer and flushes it
  every FLUSH_EVERY_SEC (and on close): a frame is one in-memory append.
- LagTracker measures how far behind the frames being written are, from
  each clock's own elapsed time -- the device's (timestamp_ms) and this
  server's (monotonic) -- so an offset between the two clocks does not
  matter. Its baseline is the least-delayed frame seen, so lag only counts
  delay that built up during the recording.
- Stop does not cut a recording at the moment it is pressed if frames are
  still queued: the session keeps writing until the frame scanned at that
  moment arrives (or DRAIN_TIMEOUT runs out), so a recording covers the time
  it was switched on, however far behind the server was.
"""

from __future__ import annotations

import csv
import threading
import time
from pathlib import Path
from typing import Callable

from .recording_meta import RecordingMeta, RecordingPaths


class RecordingWriter:
    FLUSH_EVERY_SEC = 1.0
    BUFFER_BYTES = 1 << 20

    def __init__(self, path: Path, *, monotonic: Callable[[], float] = time.monotonic) -> None:
        self.path = path
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self._handle = None
        self._writer = None
        self._flushed_at = monotonic()
        self.closed = False

    def write(self, header: Callable[[], list], row: list) -> None:
        """Appends a row (the header first, if the file is empty). Raises
        OSError from the file system, as the per-frame open() did."""
        with self._lock:
            if self.closed:
                return
            if self._handle is None:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self._handle = self.path.open("a", newline="", encoding="utf-8", buffering=self.BUFFER_BYTES)
                self._writer = csv.writer(self._handle)
                if self._handle.tell() == 0:
                    self._writer.writerow(header())
            self._writer.writerow(row)
            now = self._monotonic()
            if now - self._flushed_at >= self.FLUSH_EVERY_SEC:
                self._handle.flush()
                self._flushed_at = now

    def flush(self) -> None:
        with self._lock:
            if self._handle is not None and not self.closed:
                self._handle.flush()
                self._flushed_at = self._monotonic()

    def close(self) -> None:
        with self._lock:
            self.closed = True
            handle, self._handle = self._handle, None
            if handle is not None:
                try:
                    handle.close()
                except OSError:
                    pass


class LagTracker:
    """How far behind real time the frames being handled are, in ms."""

    # A device clock that jumps back by more than this restarted (or was set):
    # its timestamps start over and so does the baseline.
    RESTART_JUMP_MS = 1000.0

    def __init__(self, *, monotonic: Callable[[], float] = time.monotonic) -> None:
        self._monotonic = monotonic
        self._base_server: float | None = None
        self._base_device = 0.0
        self._min_offset = 0.0
        self._last_device = 0.0
        self.lag_ms = 0.0
        self.max_lag_ms = 0.0

    def observe(self, device_ms: float) -> float:
        now = self._monotonic()
        if self._base_server is None or device_ms < self._last_device - self.RESTART_JUMP_MS:
            self._base_server = now
            self._base_device = device_ms
            self._min_offset = 0.0
            self._last_device = device_ms
            self.lag_ms = 0.0
            return 0.0
        offset = (now - self._base_server) * 1000.0 - (device_ms - self._base_device)
        if offset < self._min_offset:
            # A frame that came through faster than any before: the new
            # baseline.
            self._min_offset = offset
        self._last_device = max(self._last_device, device_ms)
        self.lag_ms = offset - self._min_offset
        self.max_lag_ms = max(self.max_lag_ms, self.lag_ms)
        return self.lag_ms

    def device_ms_now(self) -> float | None:
        """The device time being scanned right now, as the least-delayed
        frames place it; None before any frame."""
        if self._base_server is None:
            return None
        return self._base_device + (self._monotonic() - self._base_server) * 1000.0 - self._min_offset


class RecordingSession:
    # Below this a stop is immediate: nothing worth waiting for is queued.
    MIN_DRAIN_LAG_MS = 250.0
    MAX_DRAIN_SEC = 600.0

    def __init__(self, paths: RecordingPaths, meta: RecordingMeta, *, monotonic: Callable[[], float] = time.monotonic) -> None:
        self.paths = paths
        self.meta = meta
        self._monotonic = monotonic
        self.writer = RecordingWriter(paths.data, monotonic=monotonic)
        self.lag = LagTracker(monotonic=monotonic)
        self.drain_until_device_ms: float | None = None
        self.drain_deadline: float | None = None

    @property
    def draining(self) -> bool:
        return self.drain_until_device_ms is not None

    def write(self, header: Callable[[], list], row: list, frame_seq: int, timestamp_ms: int, device_clock: bool) -> str | None:
        """Writes a frame. Once a stop's last frame has been written, the
        reason to finish the session with ("user", or "user_drain_timeout"
        when the wait ran out first); otherwise None."""
        self.writer.write(header, row)
        lag = self.lag.observe(float(timestamp_ms)) if device_clock else None
        self.meta.on_frame(frame_seq, timestamp_ms, lag_ms=lag, max_lag_ms=self.lag.max_lag_ms if device_clock else None)
        if self.drain_until_device_ms is None:
            return None
        if timestamp_ms >= self.drain_until_device_ms:
            return "user"
        return "user_drain_timeout" if self.drain_expired() else None

    def drain_expired(self) -> bool:
        return self.drain_deadline is not None and self._monotonic() >= self.drain_deadline

    def begin_drain(self) -> float | None:
        """Stop pressed. Returns the seconds to wait for frames still queued
        (None: nothing queued, finish now)."""
        target = self.lag.device_ms_now()
        if target is None or self.lag.lag_ms < self.MIN_DRAIN_LAG_MS:
            return None
        # Twice the backlog plus a margin: once writing is cheap the queue
        # drains far faster than real time; this only bounds a stuck stream.
        wait = min(self.MAX_DRAIN_SEC, 10.0 + 2.0 * self.lag.lag_ms / 1000.0)
        self.drain_until_device_ms = target
        self.drain_deadline = self._monotonic() + wait
        self.meta.request_stop()
        return wait

    def finish(self, reason: str) -> None:
        self.writer.close()
        self.meta.stop(reason)
