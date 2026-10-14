"""Which device a message is about. Devices are keyed by their 12-hex UID
(the WiFi MAC); messages may carry a short alias, a device_id, or only a
name, and an early message may have registered a device under a short
alias that has to be folded into the full UID once it is known.

A mixin of NewHorizonsService (service.py): it shares the service's lock and
state and has no __init__ of its own.
"""
from __future__ import annotations

from typing import Any

from .service_constants import DEFAULT_DEVICE_NAME_PREFIX, DEFAULT_DEVICE_NAME_PREFIXES


class DeviceIdentityMixin:
    @staticmethod
    def _normalize_uid(value: Any) -> str:
        raw = str(value or "").strip().upper()
        collapsed = raw.replace(":", "").replace("-", "").replace(" ", "")
        if collapsed and all(ch in "0123456789ABCDEF" for ch in collapsed):
            return collapsed
        return raw

    @classmethod
    def _is_full_hex_uid(cls, value: Any) -> bool:
        normalized = cls._normalize_uid(value)
        return len(normalized) == 12 and all(ch in "0123456789ABCDEF" for ch in normalized)

    def _resolve_known_device_uid(self, value: Any) -> str:
        normalized = self._normalize_uid(value)
        if not normalized:
            return ""
        with self._lock:
            mapped = self._device_id_to_uid.get(normalized)
            if mapped:
                return mapped
            if normalized in self._devices:
                return normalized
            if not self._is_full_hex_uid(normalized):
                matches = [
                    device_uid
                    for device_uid in self._devices
                    if self._is_full_hex_uid(device_uid) and device_uid.endswith(normalized)
                ]
                if len(matches) == 1:
                    return matches[0]
        return normalized

    def _device_uid_from_payload(self, fallback: Any, payload: dict[str, Any]) -> str:
        system = payload.get("system") if isinstance(payload.get("system"), dict) else {}
        candidates = (
            payload.get("device_uid"),
            payload.get("device_id"),
            payload.get("dn"),
            payload.get("id"),
            system.get("device_uid"),
            system.get("device_id"),
            system.get("id"),
            fallback,
        )
        for candidate in candidates:
            normalized = self._normalize_uid(candidate)
            if self._is_full_hex_uid(normalized):
                return normalized
        for candidate in candidates:
            normalized = self._normalize_uid(candidate)
            if normalized:
                return normalized
        return ""

    @staticmethod
    def _canonical_device_name(device_name: str, device_uid: str) -> str:
        if (
            device_name.startswith(DEFAULT_DEVICE_NAME_PREFIXES)
            and len(device_uid) == 12
            and device_uid.endswith(device_name.rsplit("-", 1)[-1].strip().upper())
            and not device_name.endswith(device_uid)
        ):
            return "{}{}".format(DEFAULT_DEVICE_NAME_PREFIX, device_uid)
        return device_name

    def _purge_short_aliases_locked(self, device_uid: str) -> bool:
        if not self._is_full_hex_uid(device_uid):
            return False
        aliases = [
            key
            for key in set(self._devices) | set(self._latest_status) | set(self._latest_result) | set(self._latest_visualization)
            if key != device_uid and key and len(key) < len(device_uid) and device_uid.endswith(str(key).upper())
        ]
        if not aliases:
            return False
        for alias in aliases:
            self._devices.pop(alias, None)
            self._latest_status.pop(alias, None)
            self._latest_result.pop(alias, None)
            self._latest_visualization.pop(alias, None)
            self._csv_paths.pop(alias, None)
            self._pending_commands.pop(alias, None)
            self._recording_errors.pop(alias, None)
            self._recording_enabled.discard(alias)
            self._device_id_to_uid[self._normalize_uid(alias)] = device_uid
        return True

    def _remember_device_id_mapping(self, device_uid: str, payload: dict[str, Any]) -> None:
        candidates = []
        for key in ("device_id", "id"):
            if payload.get(key):
                candidates.append(str(payload.get(key)))
        system = payload.get("system") if isinstance(payload.get("system"), dict) else {}
        for key in ("device_id", "id"):
            if system.get(key):
                candidates.append(str(system.get(key)))
        with self._lock:
            for value in candidates:
                normalized = self._normalize_device_id(value)
                if normalized:
                    self._device_id_to_uid[normalized] = device_uid

    @classmethod
    def _normalize_device_id(cls, value: str) -> str:
        normalized = cls._normalize_uid(value)
        if normalized.startswith("0X"):
            return "0x" + normalized[2:]
        return normalized
