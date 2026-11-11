"""What the operator calls a device: nicknames and groups, kept per backend
in JSON files beside the recordings.

Sync (NH Studio / NH Pocket): every label also has the time it was last
changed (`_newhorizons_device_label_times.json`, {uid: {nickname: ms,
group: ms}}); clearing a label keeps its time, so a deletion syncs like any
other change. An incoming change wins only when its time is later than the
stored one (last writer wins; a tie keeps what is here). Labels from before
sync have time 0, so any synced change replaces them.

A reader's `since_ms` is compared with when a change reached this server
(`<label>_received`, server time), not with the writer's own time: an edit
made offline arrives late with an old time and must still reach every app
that synced in between.

A mixin of NewHorizonsService (service.py): it shares the service's lock and
state and has no __init__ of its own.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import re
import time

from .profile_sync import write_atomic

LABEL_FIELDS = ("nickname", "group")
_LABEL_MAX_LEN = 64
_SYNC_UID_PATTERN = re.compile(r"^[0-9A-F]{4,32}$")


def _now_ms() -> int:
    return int(time.time() * 1000)


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
            self._stamp_label_locked(device_uid, "nickname", _now_ms())
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
            self._stamp_label_locked(device_uid, "group", _now_ms())
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

    # ── Sync ─────────────────────────────────────────────────────────────

    def label_sync_snapshot(self, since_ms: int = 0) -> dict[str, Any]:
        """Every labelled device changed after `since_ms` (0: all of them)."""
        with self._lock:
            uids = set(self._nicknames) | set(self._device_groups) | set(self._label_times)
            items = []
            for uid in sorted(uids):
                item = self._label_item_locked(uid)
                if since_ms and self._label_received_ms_locked(uid) <= since_ms:
                    continue
                items.append(item)
        return {"server_time_ms": _now_ms(), "items": items}

    def apply_label_sync(self, items: Any) -> dict[str, Any]:
        """Applies each field whose time is later than the stored one."""
        if not isinstance(items, list):
            raise ValueError("items_required")
        # Checked in full before anything changes: a bad item must not leave
        # the ones before it applied in memory but unsaved.
        parsed: list[tuple[str, list[tuple[str, str, int]]]] = []
        for raw in items:
            if not isinstance(raw, dict):
                raise ValueError("item_invalid")
            uid = str(raw.get("device_uid") or "").strip().upper().replace(":", "")
            if not _SYNC_UID_PATTERN.fullmatch(uid):
                raise ValueError("device_uid_invalid")
            fields: list[tuple[str, str, int]] = []
            for label in LABEL_FIELDS:
                if label not in raw:
                    continue
                value = str(raw.get(label) or "").strip()
                if len(value) > _LABEL_MAX_LEN:
                    raise ValueError(f"{label}_too_long")
                try:
                    incoming_ms = int(raw.get(f"{label}_updated_ms") or 0)
                except (TypeError, ValueError):
                    raise ValueError(f"{label}_updated_ms_invalid") from None
                if incoming_ms <= 0:
                    raise ValueError(f"{label}_updated_ms_required")
                fields.append((label, value, incoming_ms))
            parsed.append((uid, fields))
        results: list[dict[str, Any]] = []
        changed: list[str] = []
        with self._lock:
            nicknames_dirty = groups_dirty = False
            for raw_uid, fields in parsed:
                uid = self._device_id_to_uid.get(raw_uid, raw_uid)
                applied: list[str] = []
                for label, value, incoming_ms in fields:
                    stored_ms = int(self._label_times.get(uid, {}).get(label, 0) or 0)
                    if incoming_ms <= stored_ms:
                        continue
                    target = self._nicknames if label == "nickname" else self._device_groups
                    if value:
                        target[uid] = value
                    else:
                        target.pop(uid, None)
                    self._stamp_label_locked(uid, label, incoming_ms, save=False)
                    applied.append(label)
                    if label == "nickname":
                        nicknames_dirty = True
                    else:
                        groups_dirty = True
                if applied:
                    changed.append(uid)
                results.append({**self._label_item_locked(uid), "applied": applied})
            if nicknames_dirty:
                self._save_nicknames()
            if groups_dirty:
                self._save_device_groups()
            if changed:
                self._save_string_map_times()
            events = []
            for uid in changed:
                if uid in self._devices:
                    self._devices[uid] = self._decorate_device_entry(self._devices[uid])
                    events.append(dict(self._devices[uid]))
        for item in events:
            self._emit_event({"type": "device_update", "item": item})
        return {"server_time_ms": _now_ms(), "items": results}

    def _label_item_locked(self, uid: str) -> dict[str, Any]:
        times = self._label_times.get(uid, {})
        return {
            "device_uid": uid,
            "nickname": self._nicknames.get(uid, ""),
            "nickname_updated_ms": int(times.get("nickname", 0) or 0),
            "group": self._device_groups.get(uid, ""),
            "group_updated_ms": int(times.get("group", 0) or 0),
        }

    def _stamp_label_locked(self, uid: str, label: str, at_ms: int, *, save: bool = True) -> None:
        times = self._label_times.setdefault(uid, {})
        times[label] = int(at_ms)
        times[f"{label}_received"] = _now_ms()
        if save:
            self._save_string_map_times()

    def _label_received_ms_locked(self, uid: str) -> int:
        times = self._label_times.get(uid, {})
        # Labels stamped before received times existed: their own time.
        return max(int(times.get(f"{label}_received") or times.get(label) or 0) for label in LABEL_FIELDS)

    def _load_label_times(self) -> dict[str, dict[str, int]]:
        try:
            data = json.loads(self._label_times_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        result: dict[str, dict[str, int]] = {}
        for uid, times in data.items():
            if not isinstance(times, dict):
                continue
            clean = {}
            for key in (*LABEL_FIELDS, *(f"{label}_received" for label in LABEL_FIELDS)):
                if key not in times and key not in LABEL_FIELDS:
                    continue
                try:
                    clean[key] = int(times.get(key) or 0)
                except (TypeError, ValueError):
                    continue
            result[str(uid)] = clean
        return result

    def _save_string_map_times(self) -> None:
        write_atomic(self._label_times_path, json.dumps(self._label_times, indent=2, sort_keys=True).encode("utf-8"))

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
        write_atomic(path, json.dumps(dict(sorted(values.items())), indent=2, sort_keys=True).encode("utf-8"))
