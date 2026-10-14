"""What the operator calls a device: nicknames and groups, kept per backend
in JSON files beside the recordings.

A mixin of NewHorizonsService (service.py): it shares the service's lock and
state and has no __init__ of its own.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any
import json


class DeviceLabelsMixin:
    def set_device_nickname(self, device_uid: str, nickname: str) -> dict[str, Any]:
        device_uid = self._resolve_known_device_uid(device_uid)
        nickname = str(nickname or "").strip()
        if len(nickname) > 64:
            raise ValueError("nickname_too_long")
        with self._lock:
            if nickname:
                self._nicknames[device_uid] = nickname
            else:
                self._nicknames.pop(device_uid, None)
            self._save_nicknames()
            if device_uid in self._devices:
                self._devices[device_uid] = self._decorate_device_entry(self._devices[device_uid])
            return {
                "status": "saved",
                "device_uid": device_uid,
                "nickname": nickname,
            }

    def set_device_group(self, device_uid: str, group: str) -> dict[str, Any]:
        device_uid = self._resolve_known_device_uid(device_uid)
        group = str(group or "").strip()
        if len(group) > 64:
            raise ValueError("device_group_too_long")
        event_item: dict[str, Any] | None = None
        with self._lock:
            if group:
                self._device_groups[device_uid] = group
            else:
                self._device_groups.pop(device_uid, None)
            self._save_device_groups()
            if device_uid in self._devices:
                self._devices[device_uid] = self._decorate_device_entry(self._devices[device_uid])
                event_item = dict(self._devices[device_uid])
        if event_item is not None:
            self._emit_event({"type": "device_update", "item": event_item})
        return {
            "status": "saved",
            "device_uid": device_uid,
            "group": group,
        }

    def _load_nicknames(self) -> dict[str, str]:
        return self._load_string_map(self._nicknames_path)

    def _load_device_groups(self) -> dict[str, str]:
        return self._load_string_map(self._device_groups_path)

    @staticmethod
    def _load_string_map(path: Path) -> dict[str, str]:
        try:
            if not path.exists():
                return {}
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        if not isinstance(data, dict):
            return {}
        return {
            str(key): str(value).strip()
            for key, value in data.items()
            if str(key).strip() and str(value).strip()
        }

    def _save_nicknames(self) -> None:
        self._save_string_map(self._nicknames_path, self._nicknames)

    def _save_device_groups(self) -> None:
        self._save_string_map(self._device_groups_path, self._device_groups)

    @staticmethod
    def _save_string_map(path: Path, values: dict[str, str]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(dict(sorted(values.items())), indent=2, sort_keys=True), encoding="utf-8")
