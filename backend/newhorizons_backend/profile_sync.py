"""Sensor-layout profiles, synced with NH Studio / NH Pocket.

Profiles stay what they were: `<profiles_dir>/<name>.json`, one per profile.
Sync adds, beside them, `.profiles-sync-state` (not a .json, so the profile
listing never takes it for a profile): for each name the time it last
changed and whether it was deleted (a tombstone, so a deletion syncs too).

Last writer wins: an incoming change is applied only when its updated_ms is
later than the stored one; a tie keeps what is here. A profile with no
entry (saved before sync existed, or copied in by hand) counts as changed at
its file's modification time.

What a reader's `since_ms` is compared with is `received_ms`, the server's
own time when the change arrived here, never the writer's updated_ms: an
edit made offline arrives with an old updated_ms, after other apps already
synced past it, and would otherwise never reach them.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
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


def write_atomic(path: Path, data: bytes) -> None:
    """Writes `path` through a temporary file and a rename, so a crash
    leaves the old file or the new one, never a torn one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


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
        write_atomic(self._state_path(), json.dumps(state, indent=2, sort_keys=True).encode("utf-8"))

    # ── Hooks for the plain profile routes ───────────────────────────────

    def note_saved(self, name: str) -> None:
        with _LOCK:
            state = self._load_state()
            now = _now_ms()
            state[sanitize_profile_name(name)] = {"updated_ms": now, "received_ms": now, "deleted": False}
            self._save_state(state)

    def note_deleted(self, name: str) -> None:
        with _LOCK:
            state = self._load_state()
            now = _now_ms()
            state[sanitize_profile_name(name)] = {"updated_ms": now, "received_ms": now, "deleted": True}
            self._save_state(state)

    def save_local(self, name: str, profile: Any) -> str:
        """The plain profile route's save: the file and its sync entry
        under the same lock as a sync, so neither overwrites the other."""
        name = sanitize_profile_name(name)
        with _LOCK:
            write_atomic(self.profiles_dir / f"{name}.json", json.dumps(profile, indent=2, sort_keys=True).encode("utf-8"))
            self.note_saved(name)
        return name

    def delete_local(self, name: str) -> bool:
        name = sanitize_profile_name(name)
        with _LOCK:
            path = self.profiles_dir / f"{name}.json"
            if not path.exists():
                return False
            path.unlink()
            self.note_deleted(name)
        return True

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
            received_ms = int(entry.get("received_ms") or 0) if not entry.get("deleted") else 0
            item: dict[str, Any] = {
                "name": name,
                "updated_ms": updated_ms,
                "deleted": False,
                "sha256": hashlib.sha256(raw).hexdigest(),
                # Internal: when it arrived here (see the module docstring).
                "_received_ms": received_ms or updated_ms,
            }
            if include_body:
                item["profile"] = profile
            return item
        if entry.get("deleted"):
            updated_ms = int(entry.get("updated_ms") or 0)
            return {"name": name, "updated_ms": updated_ms, "deleted": True, "_received_ms": int(entry.get("received_ms") or 0) or updated_ms}
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
                if item is None or (since_ms and item.pop("_received_ms") <= since_ms):
                    continue
                item.pop("_received_ms", None)
                items.append(item)
        return {"server_time_ms": _now_ms(), "items": items}

    def apply(self, items: Any) -> dict[str, Any]:
        if not isinstance(items, list):
            raise ValueError("items_required")
        # Every item is checked before any is applied: a bad item must not
        # leave the ones before it written while the request fails.
        parsed: list[tuple[str, int, bool, Any]] = []
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
            parsed.append((name, incoming_ms, deleted, profile))
        results = []
        with _LOCK:
            state = self._load_state()
            for name, incoming_ms, deleted, profile in parsed:
                current = self._item(name, state, include_body=False)
                current_ms = int(current["updated_ms"]) if current else 0
                applied = incoming_ms > current_ms
                if applied:
                    path = self.profiles_dir / f"{name}.json"
                    if deleted:
                        path.unlink(missing_ok=True)
                    else:
                        write_atomic(path, _canonical_bytes(profile))
                    state[name] = {"updated_ms": incoming_ms, "received_ms": _now_ms(), "deleted": deleted}
                    self._save_state(state)
                result = self._item(name, state, include_body=not applied) or {"name": name, "updated_ms": 0, "deleted": True}
                result.pop("_received_ms", None)
                result["applied"] = applied
                results.append(result)
        return {"server_time_ms": _now_ms(), "items": results}
