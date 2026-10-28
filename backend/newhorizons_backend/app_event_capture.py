"""App events into a recording's .events.csv sidecar (app_event_log.py).

Two ways in, one writer:

- the stream: firmware v1.16.0+ puts every app event on the stream packets as
  an app_event extension TLV (spec/PROTOCOL.md 3.1), so an event arrives a
  frame or two after it was raised, with no command at all;
- `app_events`: the command the backend sends on its own. For a streaming
  device it only fills gaps -- a lost packet shows up as a jump in `seq` --
  plus a check every APP_EVENT_STREAM_CHECK_SEC for a loss nothing came after
  to reveal. For older firmware it is the only way, polled every
  APP_EVENT_POLL_SEC as before.

Both go through _write_app_events(): an event is written once (by `seq`),
events from before the recording's first frame are left out (the first
`app_events` returns everything since boot), and each gets its frame's time
from the sample CSV (FrameClock).

A mixin of NewHorizonsService (service.py): it shares the service's lock and
state, which __init__ there creates, and has no __init__ of its own.
"""
from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .app_event_log import FrameClock, append_dropped_marker, append_events, events_lost_since


def _int_field(event: dict[str, Any], key: str) -> int:
    try:
        return int(event.get(key) or 0)
    except (TypeError, ValueError):
        return 0


class AppEventCaptureMixin:
    # This is the one place the backend sends commands on its own initiative.
    # It earns that because it already owns the recording's lifecycle: the
    # frontend cannot be the one polling, since closing the tab would silently
    # stop capturing events half way through a session.
    APP_EVENT_POLL_SEC = 0.5
    # A streaming device is asked only this often, for a lost last event.
    APP_EVENT_STREAM_CHECK_SEC = 5.0
    # At most one gap repair this often per device.
    APP_EVENT_REPAIR_MIN_SEC = 1.0
    # How long a polled event may wait for its frame's sample before it is
    # written with an estimated time instead.
    APP_EVENT_HOLD_SEC = 3.0
    # Sequences remembered as written, per device, to write each event once.
    APP_EVENT_WRITTEN_KEEP = 1024

    def _ensure_app_event_poller(self) -> None:
        if self._mock_mode:
            return
        if self._app_event_thread is not None and self._app_event_thread.is_alive():
            return
        self._app_event_stop.clear()
        self._app_event_thread = threading.Thread(
            target=self._app_event_loop, name="newhorizons-app-events", daemon=True
        )
        self._app_event_thread.start()

    def _app_event_loop(self) -> None:
        while not self._app_event_stop.wait(self.APP_EVENT_POLL_SEC):
            with self._lock:
                recording = sorted(self._recording_enabled)
            if not recording:
                # Nothing to capture; the thread parks itself rather than
                # polling devices nobody is recording.
                return
            now = time.monotonic()
            for device_uid in recording:
                interval = self.APP_EVENT_STREAM_CHECK_SEC if device_uid in self._app_event_streaming else self.APP_EVENT_POLL_SEC
                # Ticks are APP_EVENT_POLL_SEC apart; the slack keeps a 0.5 s
                # poll from slipping to every other tick.
                if now - self._app_event_requested_at.get(device_uid, 0.0) >= interval - 0.1:
                    self._request_app_events(device_uid)

    def _request_app_events(self, device_uid: str) -> None:
        since = self._app_event_since(device_uid)
        request_id = "appev-" + uuid.uuid4().hex
        self._app_event_requested_at[device_uid] = time.monotonic()
        self._app_event_requests[request_id] = since
        while len(self._app_event_requests) > 64:
            self._app_event_requests.pop(next(iter(self._app_event_requests)))
        try:
            # quiet: polled, so the device skips its LED ack (v1.7.2+).
            self.publish_command(device_uid, {"command": "app_events", "since_seq": since,
                                              "quiet": True, "request_id": request_id})
        except RuntimeError:
            # Offline, booting, or the firmware predates app_events.
            # Not an error worth surfacing on every tick.
            self._app_event_requests.pop(request_id, None)

    def _app_event_since(self, device_uid: str) -> int:
        """Where to ask from: just before the oldest event the stream lost,
        else after the newest one written."""
        missing = self._app_event_missing.get(device_uid)
        if missing:
            return max(0, min(missing) - 1)
        return self._app_event_seq.get(device_uid, 0)

    def _reset_app_event_state(self, device_uid: str, *, keep_streaming: bool = False) -> None:
        """A new recording, the end of one, or a device that restarted (its
        sequence began again)."""
        for table in (self._app_event_seq, self._app_event_hold, self._app_event_written, self._app_event_missing):
            table.pop(device_uid, None)
        if not keep_streaming:
            self._app_event_requested_at.pop(device_uid, None)
            self._app_event_streaming.discard(device_uid)

    def _app_event_target(self, device_uid: str) -> tuple[Path, FrameClock] | None:
        with self._lock:
            if not self._recording_active(device_uid):
                return None
            sample_path = self._csv_paths.get(device_uid)
            clock = self._csv_frame_clocks.get(device_uid)
        if sample_path is None or clock is None:
            # No sample written yet: events wait in the device's ring.
            return None
        return sample_path, clock

    def _write_app_events(self, device_uid: str, sample_path: Path, clock: FrameClock, events: list[dict[str, Any]]) -> None:
        """Append the events not written before, leaving out those from before
        the recording's first frame. Raises OSError from the file write."""
        written = self._app_event_written.setdefault(device_uid, {})
        handled: list[int] = []
        rows: list[dict[str, Any]] = []
        for event in events:
            seq = _int_field(event, "seq")
            if seq <= 0 or seq in written or seq in handled:
                continue
            handled.append(seq)
            frame_seq = _int_field(event, "frame_seq")
            if frame_seq and clock.first and frame_seq < clock.first:
                continue
            rows.append(event)
        append_events(sample_path, rows, clock)
        for seq in handled:
            written[seq] = None
        while len(written) > self.APP_EVENT_WRITTEN_KEEP:
            written.pop(next(iter(written)))
        missing = self._app_event_missing.get(device_uid)
        if missing:
            missing.difference_update(handled)
            if not missing:
                self._app_event_missing.pop(device_uid, None)
        if handled:
            self._app_event_seq[device_uid] = max(self._app_event_seq.get(device_uid, 0), max(handled))

    def _capture_streamed_app_events(self, device_uid: str, events: list[dict[str, Any]]) -> None:
        """App events that rode a stream packet (written after its sample)."""
        target = self._app_event_target(device_uid)
        if target is None:
            return
        sample_path, clock = target
        seqs = sorted(seq for seq in (_int_field(event, "seq") for event in events if isinstance(event, dict)) if seq > 0)
        if not seqs:
            return
        repair = False
        with self._app_event_lock:
            self._app_event_streaming.add(device_uid)
            high = self._app_event_seq.get(device_uid, 0)
            known = seqs[0] in self._app_event_written.get(device_uid, {}) or seqs[0] in self._app_event_missing.get(device_uid, set())
            if high and seqs[0] <= high and not known:
                # The stream only ever brings newer events: an older one means
                # the device restarted and counts from 1 again.
                self._reset_app_event_state(device_uid, keep_streaming=True)
                high = 0
            if high and seqs[0] > high + 1:
                # A packet (or more) was lost: ask the device for what it held.
                self._app_event_missing.setdefault(device_uid, set()).update(range(high + 1, seqs[0]))
                repair = True
            try:
                self._write_app_events(device_uid, sample_path, clock, [event for event in events if isinstance(event, dict)])
            except OSError:
                # A failed sidecar write must never interrupt the sample
                # recording, which is the thing actually being measured.
                return
        if repair and time.monotonic() - self._app_event_requested_at.get(device_uid, 0.0) >= self.APP_EVENT_REPAIR_MIN_SEC:
            self._request_app_events(device_uid)

    def _capture_app_events(self, device_uid: str, payload: dict[str, Any]) -> None:
        """Write an app_events result into the recording's sidecar."""
        with self._lock:
            if not self._recording_active(device_uid):
                return
        target = self._app_event_target(device_uid)
        if target is None:
            return
        sample_path, clock = target

        data = payload.get("data")
        if not isinstance(data, dict):
            return
        events = data.get("events")
        if not isinstance(events, list):
            return
        asked_since = self._app_event_requests.pop(str(payload.get("request_id") or ""), None)
        if data.get("streaming") is True:
            self._app_event_streaming.add(device_uid)

        device_seq = _int_field(data, "seq")
        with self._app_event_lock:
            previous = self._app_event_seq.get(device_uid, 0)
            if previous and device_seq < previous:
                # The device restarted and its sequence began again. Keeping the old
                # high-water mark would filter out every new event from now on.
                self._reset_app_event_state(device_uid, keep_streaming=True)
                previous = 0
                asked_since = None

            # Oldest first. An event on a frame whose sample has not been
            # written yet waits for the next read, so it gets that frame's
            # exact time -- unless it has waited too long (the stream stopped),
            # when it is written with an estimated time.
            ordered = sorted((event for event in events if isinstance(event, dict)), key=lambda event: _int_field(event, "seq"))
            keep: list[dict[str, Any]] = []
            held_seq = 0
            for event in ordered:
                frame_seq = _int_field(event, "frame_seq")
                if frame_seq > clock.last and not self._app_event_hold_expired(device_uid, _int_field(event, "seq")):
                    held_seq = _int_field(event, "seq")
                    break
                keep.append(event)
            if not held_seq:
                self._app_event_hold.pop(device_uid, None)

            try:
                self._write_app_events(device_uid, sample_path, clock, keep)
                # Not data["dropped"]: that is cumulative since boot and would mark
                # a loss on every poll once the ring had wrapped even once.
                lost = events_lost_since(previous, device_seq, events)
                if lost:
                    append_dropped_marker(sample_path, previous, lost, clock)
                # A gap the stream left, asked for from before it: what of it
                # this reply did not bring had already rolled off the ring.
                missing = self._app_event_missing.get(device_uid)
                if missing and asked_since is not None:
                    gone = sorted(seq for seq in missing if seq > asked_since and (not held_seq or seq < held_seq))
                    if gone:
                        append_dropped_marker(sample_path, gone[0] - 1, len(gone), clock)
                        missing.difference_update(gone)
                        if not missing:
                            self._app_event_missing.pop(device_uid, None)
            except OSError:
                # A failed sidecar write must never interrupt the sample recording,
                # which is the thing actually being measured.
                return

            if held_seq:
                # Read again from just before the held event next time.
                self._app_event_seq[device_uid] = max(self._app_event_seq.get(device_uid, 0), held_seq - 1)
            elif device_seq > self._app_event_seq.get(device_uid, 0) and not ordered:
                # Nothing returned but the device moved on (all of it rolled
                # off): advance, or the same loss is counted again next read.
                self._app_event_seq[device_uid] = device_seq

    def _app_event_hold_expired(self, device_uid: str, seq: int) -> bool:
        held = self._app_event_hold.get(device_uid)
        now = time.monotonic()
        if held is None or held[0] != seq:
            self._app_event_hold[device_uid] = (seq, now)
            return False
        return now - held[1] >= self.APP_EVENT_HOLD_SEC
