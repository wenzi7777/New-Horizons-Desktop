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

# First firmware that answers `commands`. Betas of it count (core compare).
CATALOG_MIN_FIRMWARE = (1, 15, 0)
# A `commands` request that got no reply (device went offline, relay dropped
# it) is retried after this long rather than never.
CATALOG_RETRY_SEC = 30.0

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

    def mark_requested(self, device_uid: str, firmware_version: Any, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        with self._lock:
            self._requested[device_uid] = (str(firmware_version or ""), now)

    def forget_request(self, device_uid: str) -> None:
        with self._lock:
            self._requested.pop(device_uid, None)

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
