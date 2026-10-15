"""Per-device command catalogs, as the device reports them (`commands`).

Firmware v1.15.0 turned its command dispatch into a table and answers
`commands` with every row: name, flags (maintenance, heavy, quiet, internal,
status_snapshot) and a summary. With a catalog the backend no longer needs its
own copy of which commands exist or which need maintenance mode: a command
added to the firmware is usable from the Desktop without a backend change.

Devices on older firmware have no catalog; everything falls back to the
static tables (terminal.DEVICE_COMMAND_ALLOWLIST, service.MODE_COMMANDS).
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from .terminal import DEVICE_COMMAND_ALLOWLIST

# --- the static tables ------------------------------------------------------
#
# What the backend knows without a catalog: which commands exist and which
# mode each may run in. Devices on firmware older than v1.15.0 are gated by
# these alone; NewHorizonsService exposes them as class attributes.

STATUS_COMMANDS = {"status", "query", "memory_status", "scan_health", "storage_status"}

SHARED_COMMANDS = {
    "status",
    "query",
    "memory_status",
    "sensor_sample",
    # The battery card's slice of status (firmware v1.14.0+), polled
    # instead of the ~18 KB status while a gauge resync runs.
    "battery_status",
    "scan_health",
    "storage_status",
    "findme_discover",
    "findme_switch_gateway",
    "set_wifi",
    "log_tail",
    "log_clear",
    "file_list",
    "file_read_begin",
    "file_read_chunk",
    "set_log",
    "set_ota_config",
    "check_update",
    "apply_update",
    "reboot",
    "reboot_wifi_setup",
    "set_transport",
    # v1.0.0 kernel layer. The firmware gates none of these on maintenance
    # mode, so they belong here rather than in MAINTENANCE_COMMANDS.
    "task_list",
    "service_list",
    "service_restart",
    "dmesg",
    "crash_log",
    "crash_clear",
    "health",
    "capabilities",
    "config_schema",
    "config_get",
    "config_set",
    "set_time",
    "clock_sync",
    "clock_status",
    "set_clock_config",
    "set_power_profile",
    "app_list",
    "app_enable",
    "app_disable",
    "app_revive",
    "app_load_flow",
    "app_unload_flow",
    "app_events",
    "app_list_packages",
    "app_verify",
    # v1.7.0: what the apps' OLED rows, status LED and strip show now.
    "app_view",
    # v1.15.0: the device's own command table (device_commands.py).
    "commands",
}

NORMAL_COMMANDS = SHARED_COMMANDS | {
    "enter_maintenance",
    "set_matrix_layout",
    "set_scan_timing",
    "set_stream_buffer",
    "set_charge_profile",
    "set_battery_profile",
    "resync_battery_gauge",
    "power_set_state",
    "set_action_button",
    "set_indicators",
    "set_imu",
    "set_filter",
    "set_raw_adc",
    "calibration_status",
    "calibration_enable",
    "calibration_disable",
    "calibration_dump_tare",
    "calibration_dump_level",
    "calibration_dump_fit",
    # Zeroing pauses the scan itself (firmware v1.5.1+); older firmware
    # answers maintenance_required and the Desktop falls back.
    "calibration_tare_capture",
    "calibration_tare_clear",
}

MAINTENANCE_COMMANDS = NORMAL_COMMANDS | {
    "exit_maintenance",
    "calibration_clear_profile",
    "calibration_delete_level",
    "calibration_session_begin",
    "calibration_session_abort",
    "calibration_session_commit",
    "calibration_capture_tare",
    "calibration_capture_cell",
    "calibration_capture_all",
    "calibration_set_fit",
    "calibration_set_reference",
    "file_write_begin",
    "file_write_chunk",
    "file_write_finish",
    "file_delete",
    "app_install",
    "app_uninstall",
    "app_activate",
    "app_deactivate",
    "app_reindex",
}

MODE_COMMANDS = {
    "normal": NORMAL_COMMANDS,
    "maintenance": MAINTENANCE_COMMANDS,
    "safe_maintenance": MAINTENANCE_COMMANDS,
    "safemaintenance": MAINTENANCE_COMMANDS,
}

# Commands that target a Hub/Gateway process itself (via
# publish_gateway_command()) rather than a downstream device_uid. Small
# and flat on purpose -- unlike device commands, Hubs have no "mode"
# concept to gate against.
HUB_COMMANDS = {"set_config", "factory_reset", "clock_sync", "check_update", "apply_update", "set_update_channel"}

# Device commands the backend issues on its own behalf (hub migration, WiFi
# provisioning). They are deliberately absent from the terminal allowlist --
# users do not type them -- but they are real commands, so the existence
# check has to know about them.
INTERNAL_DEVICE_COMMANDS = {"set_transport", "set_wifi"}

KNOWN_DEVICE_COMMANDS = DEVICE_COMMAND_ALLOWLIST | INTERNAL_DEVICE_COMMANDS


# First firmware that answers `commands`. Betas of it count (core compare).
CATALOG_MIN_FIRMWARE = (1, 15, 0)
# A `commands` request that got no reply (device went offline, relay dropped
# it) is retried after this long rather than never.
CATALOG_RETRY_SEC = 30.0
# A request that failed outright (a busy Hub refused it, a page timed out) is
# retried sooner, backing off while it keeps failing: 4 s, 8 s, 16 s ... up
# to 5 min (under the Terminal page's 5 s asking, so a retry is never just missed).
# Immediate retries made every status of a device whose `commands`
# could never get through (e.g. through a Hub without paging) fetch ~19 KB.
FAILURE_BACKOFF_MIN_SEC = 4.0
FAILURE_BACKOFF_MAX_SEC = 300.0


def failure_backoff_sec(failures: int) -> float:
    if failures <= 0:
        return 0.0
    return min(FAILURE_BACKOFF_MAX_SEC, FAILURE_BACKOFF_MIN_SEC * 2 ** (failures - 1))

_VERSION_RE = re.compile(r"^\s*[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?")


def _version_core(version: Any) -> tuple[int, int, int] | None:
    match = _VERSION_RE.match(str(version or ""))
    if not match:
        return None
    return tuple(int(part or 0) for part in match.group(1, 2, 3))  # type: ignore[return-value]


def firmware_has_catalog(firmware_version: Any) -> bool:
    core = _version_core(firmware_version)
    return core is not None and core >= CATALOG_MIN_FIRMWARE


@dataclass
class CommandCatalog:
    firmware: str
    hash: int
    commands: dict[str, dict[str, Any]] = field(default_factory=dict)

    def public_names(self) -> set[str]:
        return {name for name, spec in self.commands.items() if not spec.get("internal")}

    def as_json(self) -> dict[str, Any]:
        return {
            "firmware": self.firmware,
            "hash": self.hash,
            "commands": [dict(spec, name=name) for name, spec in self.commands.items()],
        }


class CommandCatalogStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._catalogs: dict[str, CommandCatalog] = {}
        # (firmware, monotonic time) of the `commands` request already out per
        # device, so a stream of status replies does not trigger a stream of
        # requests.
        self._requested: dict[str, tuple[str, float]] = {}
        # When each device was last asked for its firmware version (needs_probe).
        self._probed: dict[str, float] = {}
        # Consecutive failures of the `commands` fetch, for its backoff.
        self._fetch_failures: dict[str, int] = {}
        # The firmware each device last reported, from any reply that carried
        # it: a device behind a Hub reports it in no heartbeat.
        self._firmware: dict[str, str] = {}

    def get(self, device_uid: str) -> CommandCatalog | None:
        with self._lock:
            return self._catalogs.get(device_uid)

    def needs_fetch(self, device_uid: str, firmware_version: Any, now: float | None = None) -> bool:
        firmware = str(firmware_version or "")
        if not device_uid or not firmware_has_catalog(firmware):
            return False
        now = time.monotonic() if now is None else now
        with self._lock:
            catalog = self._catalogs.get(device_uid)
            if catalog is not None and catalog.firmware == firmware:
                return False
            requested = self._requested.get(device_uid)
            if requested is None or requested[0] != firmware:
                return True
            return now - requested[1] >= CATALOG_RETRY_SEC

    def note_firmware(self, device_uid: str, firmware_version: Any) -> None:
        version = str(firmware_version or "")
        if device_uid and version:
            with self._lock:
                self._firmware[device_uid] = version

    def firmware(self, device_uid: str) -> str:
        with self._lock:
            return self._firmware.get(device_uid, "")

    def needs_probe(self, device_uid: str, now: float | None = None) -> bool:
        """Whether to ask a device whose firmware is unknown for it (a small
        `capabilities`), at most once per CATALOG_RETRY_SEC. Marks the probe."""
        now = time.monotonic() if now is None else now
        with self._lock:
            last = self._probed.get(device_uid)
            if last is not None and now - last < CATALOG_RETRY_SEC:
                return False
            self._probed[device_uid] = now
            return True

    def mark_requested(self, device_uid: str, firmware_version: Any, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        with self._lock:
            self._requested[device_uid] = (str(firmware_version or ""), now)

    def note_fetch_failed(self, device_uid: str, now: float | None = None) -> None:
        """The `commands` request failed: allow the next one after the backoff."""
        now = time.monotonic() if now is None else now
        with self._lock:
            failures = self._fetch_failures.get(device_uid, 0) + 1
            self._fetch_failures[device_uid] = failures
            requested = self._requested.get(device_uid)
            if requested is not None:
                # needs_fetch() retries CATALOG_RETRY_SEC after the stamp.
                self._requested[device_uid] = (requested[0], now - CATALOG_RETRY_SEC + failure_backoff_sec(failures))

    def note_probe_failed(self, device_uid: str, now: float | None = None) -> None:
        """The firmware probe failed: allow the next one FAILURE_BACKOFF_MIN_SEC
        later. No growing backoff: a probe is ~600 B and only an ask (the
        Terminal page, a dozen times at most) starts one."""
        now = time.monotonic() if now is None else now
        with self._lock:
            self._probed[device_uid] = now - CATALOG_RETRY_SEC + FAILURE_BACKOFF_MIN_SEC

    def invalidate_if_hash_differs(self, device_uid: str, schema_hash: Any) -> bool:
        """`capabilities` carries command_schema_hash: a mismatch means the
        cached catalog is not this firmware's, even under the same version
        string (a local build). Returns True when it was dropped."""
        try:
            value = int(schema_hash)
        except (TypeError, ValueError):
            return False
        with self._lock:
            catalog = self._catalogs.get(device_uid)
            if catalog is None or catalog.hash == value:
                return False
            del self._catalogs[device_uid]
            self._requested.pop(device_uid, None)
            return True

    def record(self, device_uid: str, firmware_version: Any, data: Any) -> CommandCatalog | None:
        """Stores a `commands` reply's data. Returns None if it is malformed."""
        if not isinstance(data, dict) or not isinstance(data.get("commands"), list):
            return None
        commands: dict[str, dict[str, Any]] = {}
        for item in data["commands"]:
            if not isinstance(item, dict) or not str(item.get("name") or ""):
                continue
            name = str(item["name"])
            commands[name] = {
                "maintenance": bool(item.get("maintenance")),
                "heavy": bool(item.get("heavy")),
                "quiet": bool(item.get("quiet")),
                "internal": bool(item.get("internal")),
                "status_snapshot": bool(item.get("status_snapshot")),
                "summary": str(item.get("summary") or ""),
            }
        if not commands:
            return None
        try:
            schema_hash = int(data.get("hash") or 0)
        except (TypeError, ValueError):
            schema_hash = 0
        catalog = CommandCatalog(firmware=str(firmware_version or ""), hash=schema_hash, commands=commands)
        with self._lock:
            self._catalogs[device_uid] = catalog
            self._requested.pop(device_uid, None)
            self._fetch_failures.pop(device_uid, None)
        return catalog

    def public_names(self, device_uid: str) -> set[str] | None:
        catalog = self.get(device_uid)
        return catalog.public_names() if catalog is not None else None

    def mode_error(self, device_uid: str, command: str, maintenance: bool) -> str | None:
        """The device's own answer to "may `command` run now".

        None when there is no catalog (the caller falls back to the static
        tables). Otherwise "unknown_command" for a command the device does
        not list -- it would answer exactly that -- "maintenance_required"
        for a maintenance command outside maintenance mode, or "".
        """
        catalog = self.get(device_uid)
        if catalog is None:
            return None
        spec = catalog.commands.get(command)
        if spec is None:
            return "unknown_command"
        if spec["maintenance"] and not maintenance:
            return "maintenance_required"
        return ""
