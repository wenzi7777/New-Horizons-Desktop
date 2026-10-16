"""Where a recording's files live, and the `.meta.json` that describes it.

Layout (Desktop v0.27.0+): one folder per recording, every file named after
the moment the first frame arrived, in UTC::

    <data_root>/<device_uid>/<YYYYMMDD>/<HHMMSS>/
        <HHMMSS>.data.csv     the samples (columns as before; service.py)
        <HHMMSS>.events.csv   app events, when there were any (app_event_log.py)
        <HHMMSS>.meta.json    this module

A second recording started within the same second gets `<HHMMSS>-2`, so it
never lands in (and appends to) the first one's file. Recordings from before
v0.27.0 sit flat in the day folder as `<HHMMSS>.csv` + `<HHMMSS>.events.csv`
with no meta; everything that reads recordings takes both layouts, and
recording_base() is what ties a file to its siblings in either.

The meta file (format 1) says what the samples cannot: which device and
firmware recorded them, how the sensors are laid out, what the calibration
was doing, how the frames travelled, and whether the recording ended
properly::

    format, files {data, events}
    device {uid, display_name, nickname, group, hardware_model,
            firmware_version, firmware_prerelease, protocol}
    sensors {count, matrix_shape {rows, cols}, matrix_layout, order,
             raw_adc_columns}
    calibration {enabled, output_mode, tare_complete, fit_settings, metadata}
    stream {target_fps, send_every_n_frames, filter, stream_raw_adc, imu,
            magnetometer}
    transport {path, relay (gateway | hub | direct), relay_id}
    clock               the device's clock status, as it reported it
    battery_at_start {soc_percent, vbat_mv}
    status_received_at  when the status the fields above came from arrived;
                        null = no full status yet (fields filled in later)
    recording {started_at, name_time_zone, server_time_zone,
               first_frame_seq, first_timestamp_ms, last_frame_seq,
               last_timestamp_ms, rows, updated_at, stopped_at, stop_reason}
    changes [{at, frame_seq, field, from, to}]

Anything unknown is null, never "unknown". The device fields are taken when
the recording starts and filled in as a full status arrives; afterwards only
the TRACKED fields follow the device, each change logged in `changes` (a tare
half way through a recording, say). `recording` is rewritten every
WRITE_EVERY_SEC while frames arrive, so a recording the backend never got to
stop -- a restart, a crash -- is the one with no `stopped_at`.

A failed write never interrupts the recording: the samples are the thing
being measured, the meta only describes them.
"""

from __future__ import annotations

import copy
import json
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

META_FORMAT = 1

DATA_SUFFIX = ".data.csv"
EVENTS_SUFFIX = ".events.csv"
META_SUFFIX = ".meta.json"
# Before v0.27.0 the samples were `<HHMMSS>.csv`.
LEGACY_DATA_SUFFIX = ".csv"


@dataclass(frozen=True)
class RecordingPaths:
    directory: Path
    data: Path
    events: Path
    meta: Path


def recording_base(path: Path) -> str:
    """`062756` for any of a recording's files, in either layout."""
    name = path.name
    lowered = name.lower()
    for suffix in (DATA_SUFFIX, EVENTS_SUFFIX, META_SUFFIX, LEGACY_DATA_SUFFIX):
        if lowered.endswith(suffix):
            return name[: -len(suffix)]
    return path.stem


def sibling_paths(path: Path) -> RecordingPaths:
    """The files that belong with `path` (any of them, either layout). The
    data file is the legacy `<base>.csv` when that is what exists."""
    base = recording_base(path)
    directory = path.parent
    data = directory / f"{base}{DATA_SUFFIX}"
    legacy = directory / f"{base}{LEGACY_DATA_SUFFIX}"
    if not data.exists() and (legacy.exists() or path == legacy):
        data = legacy
    return RecordingPaths(directory, data, directory / f"{base}{EVENTS_SUFFIX}", directory / f"{base}{META_SUFFIX}")


def is_recording_dir(path: Path) -> bool:
    try:
        return path.is_dir() and any(child.name.lower().endswith(DATA_SUFFIX) for child in path.iterdir())
    except OSError:
        return False


def new_recording_paths(data_root: Path, device_uid: str, now: datetime) -> RecordingPaths:
    """Creates the folder for a recording whose first frame arrived at `now`."""
    day = data_root / device_uid / now.strftime("%Y%m%d")
    stem = now.strftime("%H%M%S")
    base = stem
    attempt = 2
    while (day / base).exists() or (day / f"{base}{LEGACY_DATA_SUFFIX}").exists():
        base = f"{stem}-{attempt}"
        attempt += 1
    directory = day / base
    directory.mkdir(parents=True, exist_ok=True)
    return RecordingPaths(
        directory,
        directory / f"{base}{DATA_SUFFIX}",
        directory / f"{base}{EVENTS_SUFFIX}",
        directory / f"{base}{META_SUFFIX}",
    )


def read_meta(path: Path) -> dict[str, Any] | None:
    """The meta beside `path` (any of the recording's files), or None."""
    target = path if path.name.lower().endswith(META_SUFFIX) else sibling_paths(path).meta
    try:
        document = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return document if isinstance(document, dict) else None


# ── Building the device fields ────────────────────────────────────────────


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _known(*values: Any) -> Any:
    for value in values:
        if value is None or value == "" or value == "unknown":
            continue
        return value
    return None


def _matrix_shape(*candidates: Any) -> dict[str, int] | None:
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        try:
            rows, cols = int(candidate.get("rows")), int(candidate.get("cols"))
        except (TypeError, ValueError):
            continue
        if rows > 0 and cols > 0:
            return {"rows": rows, "cols": cols}
    return None


def status_is_full(status: dict[str, Any]) -> bool:
    """A real `status` reply, rather than the stand-in a heartbeat or a bare
    stream packet leaves (device_name, protocol and little else)."""
    system = _dict(status.get("system"))
    return bool(
        _known(system.get("hardware_model"), status.get("hardware_model"))
        or _dict(status.get("matrix_shape"))
        or _dict(status.get("calibration"))
    )


def build_device_meta(
    device_uid: str,
    device: dict[str, Any],
    status: dict[str, Any],
    *,
    nickname: str = "",
    group: str = "",
    relay_client_type: str = "",
    target_fps: int | None = None,
    sensor_count: int | None = None,
    raw_adc_columns: bool | None = None,
    battery: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The device-describing blocks of the meta, from what the backend knows
    about the device (its entry, its last status merged) at this moment."""
    system = _dict(status.get("system"))
    runtime = _dict(status.get("runtime"))
    summary = _dict(device.get("system_summary"))
    calibration = _dict(status.get("calibration"))
    scan = _dict(runtime.get("scan_timing"))
    imu = _dict(status.get("imu"))
    stream_battery = _dict(battery) or _dict(status.get("battery"))
    transport = _dict(runtime.get("transport"))

    gateway_id = str(device.get("gateway_id") or "")
    if gateway_id and device.get("gateway_connected"):
        relay = relay_client_type or str(device.get("client_type") or "") or "gateway"
    else:
        relay = "direct"
    prerelease = _known(status.get("firmware_prerelease"), system.get("firmware_prerelease"))

    return {
        "device": {
            "uid": device_uid,
            "display_name": _known(device.get("display_name"), nickname, device.get("device_name"), status.get("device_name")),
            "nickname": nickname or None,
            "group": group or None,
            "hardware_model": _known(system.get("hardware_model"), status.get("hardware_model"), device.get("hardware_model"), summary.get("hardware_model")),
            "firmware_version": _known(system.get("firmware_version"), status.get("firmware_version"), device.get("firmware_version"), summary.get("firmware_version")),
            "firmware_prerelease": prerelease if isinstance(prerelease, bool) else None,
            "protocol": _known(status.get("protocol"), runtime.get("protocol"), device.get("protocol")),
        },
        "sensors": {
            "count": sensor_count,
            "matrix_shape": _matrix_shape(status.get("matrix_shape"), device.get("matrix_shape"), summary.get("matrix_shape")),
            "matrix_layout": copy.deepcopy(status.get("matrix_layout")) if isinstance(status.get("matrix_layout"), dict) else None,
            "order": "row-major from P1",
            "raw_adc_columns": raw_adc_columns,
        },
        "calibration": {
            "enabled": calibration.get("enabled") if isinstance(calibration.get("enabled"), bool) else None,
            "output_mode": _known(calibration.get("output_mode")),
            "tare_complete": calibration.get("tare_complete") if isinstance(calibration.get("tare_complete"), bool) else None,
            # The settings, not the fitted levels/coefficients: those are
            # large and the device keeps them.
            "fit_settings": copy.deepcopy(calibration.get("fit_settings")) if isinstance(calibration.get("fit_settings"), dict) else None,
            "metadata": copy.deepcopy(calibration.get("metadata")) if isinstance(calibration.get("metadata"), dict) else None,
        },
        "stream": {
            "target_fps": target_fps,
            "send_every_n_frames": _known(scan.get("send_every_n_frames")),
            "filter": copy.deepcopy(status.get("filter")) if isinstance(status.get("filter"), dict) else None,
            "stream_raw_adc": status.get("stream_raw_adc") if isinstance(status.get("stream_raw_adc"), bool) else None,
            "imu": {"chip": _known(imu.get("chip")), "sample_rate_hz": _known(imu.get("sample_rate_hz"))} if imu else None,
            "magnetometer": copy.deepcopy(status.get("magnetometer")) if isinstance(status.get("magnetometer"), (dict, bool)) else None,
        },
        "transport": {
            "path": _known(device.get("transport_path"), status.get("transport_path"), transport.get("mode"), device.get("transport_mode")),
            "relay": relay,
            "relay_id": gateway_id if relay != "direct" else None,
        },
        "clock": copy.deepcopy(status.get("clock")) if isinstance(status.get("clock"), dict) else None,
        "battery_at_start": (
            {"soc_percent": _known(stream_battery.get("soc_percent")), "vbat_mv": _known(stream_battery.get("vbat_mv"))}
            if stream_battery
            else None
        ),
        "status_received_at": _known(status.get("received_at")) if status_is_full(status) else None,
    }


# ── One recording's meta file ─────────────────────────────────────────────


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _server_time_zone() -> str:
    offset = datetime.now().astimezone().strftime("%z")
    return f"{offset[:3]}:{offset[3:]}" if len(offset) == 5 else offset or "+00:00"


class RecordingMeta:
    """The `.meta.json` of the recording in progress for one device. Fed from
    the stream thread (frames), the status path and the recording switch, so
    every method takes the instance's own lock."""

    WRITE_EVERY_SEC = 10.0
    MAX_CHANGES = 200
    # Followed for the whole recording; everything else stays as it was at
    # the start (filled in once if it was not known yet).
    TRACKED = (
        ("calibration", "enabled"),
        ("calibration", "output_mode"),
        ("stream", "target_fps"),
        ("stream", "stream_raw_adc"),
        ("transport", "path"),
        ("transport", "relay_id"),
        ("device", "firmware_version"),
    )

    def __init__(
        self,
        paths: RecordingPaths,
        device_meta: dict[str, Any],
        *,
        started_at: datetime,
        first_frame_seq: int,
        first_timestamp_ms: int,
        monotonic: Callable[[], float] = time.monotonic,
        wall: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self.paths = paths
        self._lock = threading.Lock()
        self._monotonic = monotonic
        self._wall = wall
        self._written_at = 0.0
        self._document: dict[str, Any] = {
            "format": META_FORMAT,
            "files": {"data": paths.data.name, "events": paths.events.name},
            **copy.deepcopy(device_meta),
            "recording": {
                "started_at": _iso(started_at),
                "name_time_zone": "UTC",
                "server_time_zone": _server_time_zone(),
                "first_frame_seq": first_frame_seq or None,
                "first_timestamp_ms": first_timestamp_ms,
                "last_frame_seq": first_frame_seq or None,
                "last_timestamp_ms": first_timestamp_ms,
                "rows": 0,
                "updated_at": _iso(started_at),
                "stopped_at": None,
                "stop_reason": None,
            },
            "changes": [],
        }

    @property
    def document(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._document)

    def on_frame(self, frame_seq: int, timestamp_ms: int) -> None:
        with self._lock:
            recording = self._document["recording"]
            recording["rows"] += 1
            if frame_seq:
                recording["last_frame_seq"] = frame_seq
            recording["last_timestamp_ms"] = timestamp_ms
            due = self._monotonic() - self._written_at >= self.WRITE_EVERY_SEC
        if due:
            self.write()

    def refresh_device(self, device_meta: dict[str, Any]) -> None:
        """Fills in what was unknown and logs a change in a TRACKED field."""
        changed = False
        with self._lock:
            at = _iso(self._wall())
            frame_seq = self._document["recording"]["last_frame_seq"]
            tracked = set(self.TRACKED)
            for block, values in device_meta.items():
                current = self._document.get(block)
                if not isinstance(values, dict):
                    if current is None and values is not None:
                        self._document[block] = copy.deepcopy(values)
                        changed = True
                    continue
                if not isinstance(current, dict):
                    self._document[block] = copy.deepcopy(values)
                    changed = True
                    continue
                for field, value in values.items():
                    if value is None:
                        continue
                    old = current.get(field)
                    if old is None:
                        current[field] = copy.deepcopy(value)
                        changed = True
                    elif (block, field) in tracked and old != value:
                        changes = self._document["changes"]
                        if len(changes) < self.MAX_CHANGES:
                            changes.append({"at": at, "frame_seq": frame_seq, "field": f"{block}.{field}", "from": old, "to": value})
                        current[field] = copy.deepcopy(value)
                        changed = True
        if changed:
            self.write()

    def stop(self, reason: str) -> None:
        with self._lock:
            recording = self._document["recording"]
            if recording["stopped_at"] is None:
                recording["stopped_at"] = _iso(self._wall())
                recording["stop_reason"] = reason
        self.write()

    def write(self) -> bool:
        with self._lock:
            self._document["recording"]["updated_at"] = _iso(self._wall())
            text = json.dumps(self._document, indent=2, ensure_ascii=False) + "\n"
            self._written_at = self._monotonic()
            temporary = self.paths.meta.with_name(self.paths.meta.name + ".tmp")
            try:
                temporary.write_text(text, encoding="utf-8")
                os.replace(temporary, self.paths.meta)
            except OSError:
                return False
        return True
