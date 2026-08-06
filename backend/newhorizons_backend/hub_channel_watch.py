from __future__ import annotations

import json
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable


def normalize_gateway_id(value: Any) -> str:
    return str(value or "").strip()


class HubChannelWatcher:
    """Admin-configured Hub 'environments' plus each Hub's self-reported
    ESP-NOW/WiFi channel, used purely to detect (not resolve) collisions.

    This replaced an earlier DHCP-style channel *lease* design -- real-
    hardware testing found esp_wifi_set_channel() is a no-op once a Hub's
    WiFi STA is associated to a real access point (802.11 station mode
    channel is dictated by the AP, not chosen by the STA), so "assign each
    Hub a different channel" is not achievable while Hubs use WiFi STA for
    their Backend uplink -- see
    ~/.claude/plans/linked-strolling-puppy.md's "Step 5c 重新設計" section
    for the full analysis. This module now only tracks what channel each
    Hub actually landed on (self-reported, piggybacked on its existing
    gateway_status heartbeat -- see HubUplinkClient.cpp) and lets callers
    (service.py's list_hub_environments()) compute whether two *online*
    Hubs in the same admin-declared environment are currently sharing a
    channel, so an admin can be warned and address it out of band (move a
    Hub to a different AP, etc.) -- this module makes no attempt to fix it.

    Environments and hub->environment assignments are persisted (admin
    configuration), following the same flat-JSON-file convention as
    NewHorizonsService's nicknames/device groups. Reported channels are
    runtime-only, like gateway sessions themselves.
    """

    def __init__(
        self,
        path: Path | None = None,
        *,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._path = path
        self._now = now or time.time
        self._lock = threading.RLock()
        self._environments: dict[str, dict[str, Any]] = {}  # environment_id -> {"environment_id", "name", "created_at"}
        self._hub_environment: dict[str, str] = {}  # gateway_id -> environment_id
        self._channels: dict[str, int] = {}  # gateway_id -> last self-reported channel
        if self._path is not None:
            self._load()

    # ---- admin: environments -------------------------------------------------

    def list_environments(self) -> list[dict[str, Any]]:
        with self._lock:
            members: dict[str, list[str]] = {}
            for gateway_id, environment_id in self._hub_environment.items():
                members.setdefault(environment_id, []).append(gateway_id)
            return [
                {
                    "environment_id": environment_id,
                    "name": entry.get("name", ""),
                    "created_at": entry.get("created_at", ""),
                    "hub_ids": sorted(members.get(environment_id, [])),
                }
                for environment_id, entry in sorted(self._environments.items())
            ]

    def create_environment(self, name: str) -> dict[str, Any]:
        name = str(name or "").strip()
        if not name:
            raise ValueError("environment_name_required")
        if len(name) > 64:
            raise ValueError("environment_name_too_long")
        with self._lock:
            environment_id = "env-{}".format(secrets.token_hex(3))
            while environment_id in self._environments:
                environment_id = "env-{}".format(secrets.token_hex(3))
            self._environments[environment_id] = {
                "environment_id": environment_id,
                "name": name,
                "created_at": self._now(),
            }
            self._save()
            return dict(self._environments[environment_id])

    def delete_environment(self, environment_id: str) -> bool:
        environment_id = str(environment_id or "").strip()
        with self._lock:
            if environment_id not in self._environments:
                return False
            del self._environments[environment_id]
            for gateway_id in [gid for gid, eid in self._hub_environment.items() if eid == environment_id]:
                del self._hub_environment[gateway_id]
            self._save()
            return True

    def set_hub_environment(self, gateway_id: str, environment_id: str | None) -> None:
        gateway_id = normalize_gateway_id(gateway_id)
        if not gateway_id:
            raise ValueError("gateway_id_required")
        environment_id = str(environment_id or "").strip() or None
        with self._lock:
            if environment_id is not None and environment_id not in self._environments:
                raise ValueError("environment_not_found")
            if environment_id is None:
                self._hub_environment.pop(gateway_id, None)
            else:
                self._hub_environment[gateway_id] = environment_id
            self._save()

    def hub_environment(self, gateway_id: str) -> str | None:
        with self._lock:
            return self._hub_environment.get(normalize_gateway_id(gateway_id))

    # ---- Hub-facing: self-reported channel ------------------------------------

    def report_channel(self, gateway_id: str, channel: int) -> None:
        gateway_id = normalize_gateway_id(gateway_id)
        if not gateway_id:
            return
        channel = int(channel or 0)
        if channel <= 0:
            return
        with self._lock:
            self._channels[gateway_id] = channel

    def clear_channel(self, gateway_id: str) -> None:
        with self._lock:
            self._channels.pop(normalize_gateway_id(gateway_id), None)

    def channel_for(self, gateway_id: str) -> int:
        with self._lock:
            return self._channels.get(normalize_gateway_id(gateway_id), 0)

    # ---- persistence (environments + hub->environment only) --------------

    def _load(self) -> None:
        try:
            if not self._path.exists():
                return
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return
        if not isinstance(data, dict):
            return
        environments = data.get("environments")
        if isinstance(environments, dict):
            for environment_id, entry in environments.items():
                if not isinstance(entry, dict):
                    continue
                environment_id = str(environment_id).strip()
                name = str(entry.get("name") or "").strip()
                if not environment_id or not name:
                    continue
                self._environments[environment_id] = {
                    "environment_id": environment_id,
                    "name": name,
                    "created_at": entry.get("created_at", ""),
                }
        hub_environment = data.get("hub_environment")
        if isinstance(hub_environment, dict):
            for gateway_id, environment_id in hub_environment.items():
                gateway_id = normalize_gateway_id(gateway_id)
                environment_id = str(environment_id or "").strip()
                if gateway_id and environment_id in self._environments:
                    self._hub_environment[gateway_id] = environment_id

    def _save(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "environments": self._environments,
            "hub_environment": self._hub_environment,
        }
        self._path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
