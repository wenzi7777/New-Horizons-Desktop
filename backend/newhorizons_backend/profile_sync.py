"""Sensor-layout profiles, synced with NH Studio / NH Pocket.

Profiles stay what they were: `<profiles_dir>/<name>.json`, one per profile.
Sync adds, beside them, `.profiles-sync-state` (not a .json, so the profile
listing never takes it for a profile): for each name the time it last
changed and whether it was deleted (a tombstone, so a deletion syncs too).

Last writer wins: an incoming change is applied only when its updated_ms is
later than the stored one; a tie keeps what is here. A profile with no
entry (saved before sync existed, or copied in by hand) counts as changed at
its file's modification time.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path
from typing import Any

STATE_FILE_NAME = ".profiles-sync-state"
_LOCK = threading.RLock()


def sanitize_profile_name(name: str) -> str:
    """The same rule api.py has always used for profile file names."""
    return "".join(char if char.isalnum() or char in {"_", "-"} else "_" for char in str(name or ""))


def _now_ms() -> int:
    return int(time.time() * 1000)


def _canonical_bytes(profile: Any) -> bytes:
    return json.dumps(profile, indent=2, sort_keys=True).encode("utf-8")


class ProfileSyncStore:
    def __init__(self, profiles_dir: Path) -> None:
        self.profiles_dir = Path(profiles_dir)

    # ── State file ───────────────────────────────────────────────────────

    def _state_path(self) -> Path:
        return self.profiles_dir / STATE_FILE_NAME

    def _load_state(self) -> dict[str, dict[str, Any]]:
        try:
            data = json.loads(self._state_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return {str(k): v for k, v in data.items() if isinstance(v, dict)} if isinstance(data, dict) else {}

    def _save_state(self, state: dict[str, dict[str, Any]]) -> None:
        self.profiles_dir.mkdir(parents=True, exist_ok=True)
        self._state_path().write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")

    # ── Hooks for the plain profile routes ───────────────────────────────

    def note_saved(self, name: str) -> None:
        with _LOCK:
            state = self._load_state()
            state[sanitize_profile_name(name)] = {"updated_ms": _now_ms(), "deleted": False}
            self._save_state(state)

    def note_deleted(self, name: str) -> None:
        with _LOCK:
            state = self._load_state()
            state[sanitize_profile_name(name)] = {"updated_ms": _now_ms(), "deleted": True}
            self._save_state(state)

    # ── Sync ─────────────────────────────────────────────────────────────

    def _item(self, name: str, state: dict[str, dict[str, Any]], *, include_body: bool = True) -> dict[str, Any] | None:
        path = self.profiles_dir / f"{name}.json"
        entry = state.get(name, {})
        if path.is_file():
            try:
                raw = path.read_bytes()
                profile = json.loads(raw.decode("utf-8"))
            except (OSError, ValueError):
                return None
            updated_ms = int(entry.get("updated_ms") or 0) if not entry.get("deleted") else 0
            if not updated_ms:
                updated_ms = int(path.stat().st_mtime * 1000)
            item: dict[str, Any] = {
                "name": name,
                "updated_ms": updated_ms,
                "deleted": False,
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
            if include_body:
                item["profile"] = profile
            return item
        if entry.get("deleted"):
            return {"name": name, "updated_ms": int(entry.get("updated_ms") or 0), "deleted": True}
        return None

    def snapshot(self, since_ms: int = 0) -> dict[str, Any]:
        with _LOCK:
            state = self._load_state()
            names = set(state)
            if self.profiles_dir.is_dir():
                names.update(path.stem for path in self.profiles_dir.glob("*.json"))
            items = []
            for name in sorted(names):
                item = self._item(name, state)
                if item is None or (since_ms and item["updated_ms"] <= since_ms):
                    continue
                items.append(item)
        return {"server_time_ms": _now_ms(), "items": items}

    def apply(self, items: Any) -> dict[str, Any]:
        if not isinstance(items, list):
            raise ValueError("items_required")
        results = []
        with _LOCK:
            state = self._load_state()
            for raw in items:
                if not isinstance(raw, dict):
                    raise ValueError("item_invalid")
                name = str(raw.get("name") or "").strip()
                if not name or sanitize_profile_name(name) != name or len(name) > 128:
                    raise ValueError("profile_name_invalid")
                try:
                    incoming_ms = int(raw.get("updated_ms") or 0)
                except (TypeError, ValueError):
                    raise ValueError("updated_ms_invalid") from None
                if incoming_ms <= 0:
                    raise ValueError("updated_ms_required")
                deleted = bool(raw.get("deleted"))
                profile = raw.get("profile")
                if not deleted and not isinstance(profile, dict):
                    raise ValueError("profile_required")
                current = self._item(name, state, include_body=False)
                current_ms = int(current["updated_ms"]) if current else 0
                applied = incoming_ms > current_ms
                if applied:
                    path = self.profiles_dir / f"{name}.json"
                    self.profiles_dir.mkdir(parents=True, exist_ok=True)
                    if deleted:
                        path.unlink(missing_ok=True)
                    else:
                        path.write_bytes(_canonical_bytes(profile))
                    state[name] = {"updated_ms": incoming_ms, "deleted": deleted}
                    self._save_state(state)
                result = self._item(name, state, include_body=not applied) or {"name": name, "updated_ms": 0, "deleted": True}
                result["applied"] = applied
                results.append(result)
        return {"server_time_ms": _now_ms(), "items": results}
