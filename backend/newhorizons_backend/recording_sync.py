"""Recordings uploaded by NH Studio / NH Pocket, and the listing they sync from.

A recording lives where it was made; an app uploads it here only when its
sync is on. The upload is chunked and resumable, and lands in the same
layout the Backend's own recordings use (recording_meta.py)::

    <data_root>/<device_uid>/<YYYYMMDD>/<HHMMSS>/<HHMMSS>.{data.csv,events.csv,meta.json}

so the Files page, the timeline and the analysis tools read it like any
other. The meta gets a `source` block saying which app sent it.

Protocol (api.py routes, all under /api/sync/recordings):

1. begin  -- {recording_id, device_uid, started_at, files: [{role, size,
   sha256}]}. `recording_id` is the app's own id for the recording, unique
   and stable: it is what makes a re-upload a no-op. `started_at` (ISO 8601)
   is when the first frame arrived; it names the folder, in UTC.
   Answers the upload state: how many bytes of each file are here already.
   Same id, same files -> resume; same id, different files while still
   uploading -> start over; same id already complete -> "complete" (or 409
   recording_id_conflict when the files differ).
2. chunk  -- the raw bytes of one file from `offset`, which must be exactly
   the number of bytes received so far (else 409 offset_mismatch with the
   right number, so a client that lost a reply just carries on from there).
3. complete -- checks every size and SHA-256, moves the files into place,
   writes the meta. A file whose checksum is wrong is discarded (422) and
   must be sent again.

Partial uploads wait in `<data_root>/_newhorizons_sync/uploads/`; finished
ones are indexed in `<data_root>/_newhorizons_sync/index.json` by
recording_id. Underscore folders are not device folders to the Files page.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .recording_meta import DATA_SUFFIX, EVENTS_SUFFIX, META_FORMAT, META_SUFFIX, is_recording_dir, new_recording_paths, read_meta

SYNC_DIR_NAME = "_newhorizons_sync"
ROLES = ("data", "events", "meta")
ROLE_SUFFIX = {"data": DATA_SUFFIX, "events": EVENTS_SUFFIX, "meta": META_SUFFIX}
MAX_CHUNK_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
_RECORDING_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_UID_PATTERN = re.compile(r"^[0-9A-F]{4,32}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_DAY_PATTERN = re.compile(r"^\d{8}$")


class SyncError(Exception):
    """An upload problem the client can act on: `code` is the API error,
    `status` the HTTP status, `extra` goes into the reply body."""

    def __init__(self, code: str, status: int = 400, **extra: Any) -> None:
        super().__init__(code)
        self.code = code
        self.status = status
        self.extra = extra


def _now_ms() -> int:
    return int(time.time() * 1000)


def _max_file_bytes() -> int:
    try:
        return max(1, int(os.getenv("NEWHORIZONS_SYNC_MAX_FILE_BYTES", str(DEFAULT_MAX_FILE_BYTES))))
    except ValueError:
        return DEFAULT_MAX_FILE_BYTES


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_started_at(value: Any) -> datetime:
    text = str(value or "").strip()
    if not text:
        raise SyncError("started_at_required")
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise SyncError("started_at_invalid") from None
    if moment.tzinfo is None:
        raise SyncError("started_at_needs_time_zone")
    return moment.astimezone(timezone.utc)


def normalize_device_uid(value: Any) -> str:
    uid = str(value or "").strip().upper().replace(":", "")
    if not _UID_PATTERN.fullmatch(uid):
        raise SyncError("device_uid_invalid")
    return uid


class RecordingSyncStore:
    _lock = threading.RLock()

    def __init__(self, data_root: Path) -> None:
        self.data_root = Path(data_root)

    # ── Paths and the index ──────────────────────────────────────────────

    @property
    def _sync_dir(self) -> Path:
        return self.data_root / SYNC_DIR_NAME

    def _index_path(self) -> Path:
        return self._sync_dir / "index.json"

    def _staging_dir(self, recording_id: str) -> Path:
        # Hashed, so nothing an app sends ends up in a path.
        return self._sync_dir / "uploads" / hashlib.sha256(recording_id.encode("utf-8")).hexdigest()[:32]

    def _load_index(self) -> dict[str, dict[str, Any]]:
        try:
            data = json.loads(self._index_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save_index(self, index: dict[str, dict[str, Any]]) -> None:
        self._sync_dir.mkdir(parents=True, exist_ok=True)
        tmp = self._index_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(index, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(self._index_path())

    def _completed(self, recording_id: str) -> dict[str, Any] | None:
        """The index entry, if the recording is still on disk. One deleted
        from the Files page since can be uploaded again."""
        index = self._load_index()
        entry = index.get(recording_id)
        if entry is None:
            return None
        if not (self.data_root / str(entry.get("path") or "_missing_")).is_dir():
            index.pop(recording_id, None)
            self._save_index(index)
            return None
        return entry

    @staticmethod
    def _check_recording_id(recording_id: Any) -> str:
        recording_id = str(recording_id or "").strip()
        if not _RECORDING_ID_PATTERN.fullmatch(recording_id):
            raise SyncError("recording_id_invalid")
        return recording_id

    # ── Upload ───────────────────────────────────────────────────────────

    def begin(self, payload: Any, *, source: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise SyncError("invalid_json")
        recording_id = self._check_recording_id(payload.get("recording_id"))
        device_uid = normalize_device_uid(payload.get("device_uid"))
        started_at = parse_started_at(payload.get("started_at"))
        files = self._check_files(payload.get("files"))
        with self._lock:
            done = self._completed(recording_id)
            if done is not None:
                if done.get("files") != files or done.get("device_uid") != device_uid:
                    raise SyncError("recording_id_conflict", 409, path=done.get("path"))
                return self._complete_payload(recording_id, done)
            staging = self._staging_dir(recording_id)
            manifest = self._read_manifest(staging)
            wanted = {
                "recording_id": recording_id,
                "device_uid": device_uid,
                "started_at": started_at.isoformat().replace("+00:00", "Z"),
                "files": files,
            }
            if manifest is None or any(manifest.get(key) != value for key, value in wanted.items()):
                # New, or the app is sending something else under this id
                # now (it re-exported the recording): start over.
                shutil.rmtree(staging, ignore_errors=True)
                staging.mkdir(parents=True, exist_ok=True)
                manifest = {**wanted, "source": dict(source), "created_at_ms": _now_ms()}
                (staging / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
                for role in files:
                    (staging / f"{role}.part").touch()
            return self._upload_payload(staging, manifest)

    def status(self, recording_id: str) -> dict[str, Any]:
        recording_id = self._check_recording_id(recording_id)
        with self._lock:
            done = self._completed(recording_id)
            if done is not None:
                return self._complete_payload(recording_id, done)
            staging = self._staging_dir(recording_id)
            manifest = self._read_manifest(staging)
            if manifest is None:
                raise SyncError("upload_not_found", 404)
            return self._upload_payload(staging, manifest)

    def write_chunk(self, recording_id: str, role: str, offset: int, data: bytes) -> dict[str, Any]:
        recording_id = self._check_recording_id(recording_id)
        if role not in ROLES:
            raise SyncError("role_invalid")
        if len(data) > MAX_CHUNK_BYTES:
            raise SyncError("chunk_too_large", 413, max_chunk_bytes=MAX_CHUNK_BYTES)
        with self._lock:
            if self._completed(recording_id) is not None:
                raise SyncError("upload_already_complete", 409)
            staging = self._staging_dir(recording_id)
            manifest = self._read_manifest(staging)
            if manifest is None:
                raise SyncError("upload_not_found", 404)
            expected = manifest["files"].get(role)
            if expected is None:
                raise SyncError("role_not_in_upload")
            part = staging / f"{role}.part"
            received = part.stat().st_size if part.exists() else 0
            if offset != received:
                raise SyncError("offset_mismatch", 409, role=role, received=received)
            if received + len(data) > int(expected["size"]):
                raise SyncError("chunk_exceeds_size", role=role, received=received, size=expected["size"])
            with part.open("ab") as handle:
                handle.write(data)
            return {"recording_id": recording_id, "role": role, "received": received + len(data), "size": int(expected["size"])}

    def complete(self, recording_id: str) -> dict[str, Any]:
        recording_id = self._check_recording_id(recording_id)
        with self._lock:
            done = self._completed(recording_id)
            if done is not None:
                return self._complete_payload(recording_id, done)
            staging = self._staging_dir(recording_id)
            manifest = self._read_manifest(staging)
            if manifest is None:
                raise SyncError("upload_not_found", 404)
            files: dict[str, dict[str, Any]] = manifest["files"]
            incomplete = {}
            for role, expected in files.items():
                part = staging / f"{role}.part"
                received = part.stat().st_size if part.exists() else 0
                if received != int(expected["size"]):
                    incomplete[role] = {"received": received, "size": int(expected["size"])}
            if incomplete:
                raise SyncError("upload_incomplete", 409, files=incomplete)
            bad = []
            for role, expected in files.items():
                part = staging / f"{role}.part"
                if _sha256_file(part) != expected["sha256"]:
                    # Received in full but wrong: drop it so it is resent.
                    part.write_bytes(b"")
                    bad.append(role)
            if bad:
                raise SyncError("checksum_mismatch", 422, roles=bad)
            meta: dict[str, Any] = {}
            if "meta" in files:
                try:
                    loaded = json.loads((staging / "meta.part").read_text(encoding="utf-8"))
                except ValueError:
                    loaded = None
                if not isinstance(loaded, dict):
                    (staging / "meta.part").write_bytes(b"")
                    raise SyncError("meta_invalid", 422, roles=["meta"])
                meta = loaded
            started_at = parse_started_at(manifest["started_at"])
            paths = new_recording_paths(self.data_root, manifest["device_uid"], started_at)
            shutil.move(str(staging / "data.part"), paths.data)
            if "events" in files:
                shutil.move(str(staging / "events.part"), paths.events)
            source = dict(manifest.get("source") or {})
            uploaded_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            meta["format"] = meta.get("format") or META_FORMAT
            meta["files"] = {"data": paths.data.name, "events": paths.events.name if "events" in files else None}
            device = meta.get("device") if isinstance(meta.get("device"), dict) else {}
            device.setdefault("uid", manifest["device_uid"])
            meta["device"] = device
            client_type = str(source.get("client_type") or "")
            transport = meta.get("transport") if isinstance(meta.get("transport"), dict) else {}
            if client_type and not transport.get("path"):
                transport["path"] = client_type
            meta["transport"] = transport
            recording = meta.get("recording") if isinstance(meta.get("recording"), dict) else {}
            recording.setdefault("started_at", manifest["started_at"])
            meta["recording"] = recording
            meta["source"] = {
                **source,
                "recording_id": recording_id,
                "uploaded_at": uploaded_at,
            }
            paths.meta.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
            relative = paths.directory.relative_to(self.data_root).as_posix()
            entry = {
                "path": relative,
                "device_uid": manifest["device_uid"],
                "files": files,
                "source": source,
                "completed_at_ms": _now_ms(),
            }
            index = self._load_index()
            index[recording_id] = entry
            self._save_index(index)
            shutil.rmtree(staging, ignore_errors=True)
            return self._complete_payload(recording_id, entry)

    # ── Listing and download ─────────────────────────────────────────────

    def list_recordings(self, *, device_uid: str = "", since_ms: int = 0, limit: int = 200, offset: int = 0) -> dict[str, Any]:
        """Every recording folder here (uploaded or the Backend's own),
        newest first. Pre-v0.27.0 flat recordings are not listed."""
        items: list[dict[str, Any]] = []
        root = self.data_root
        device_dirs = [root / normalize_device_uid(device_uid)] if device_uid else (
            [child for child in root.iterdir() if child.is_dir() and not child.name.startswith(("_", "."))] if root.is_dir() else []
        )
        for device_dir in device_dirs:
            if not device_dir.is_dir():
                continue
            for day_dir in device_dir.iterdir():
                if not day_dir.is_dir() or not _DAY_PATTERN.fullmatch(day_dir.name):
                    continue
                for rec_dir in day_dir.iterdir():
                    if not is_recording_dir(rec_dir):
                        continue
                    item = self._recording_item(rec_dir)
                    if since_ms and item["modified_ms"] <= since_ms:
                        continue
                    items.append(item)
        items.sort(key=lambda item: (-item["modified_ms"], item["path"]))
        total = len(items)
        page = items[offset: offset + limit]
        return {
            "server_time_ms": _now_ms(),
            "total": total,
            "offset": offset,
            "items": page,
            "next_offset": offset + len(page) if offset + len(page) < total else None,
        }

    def _recording_item(self, rec_dir: Path) -> dict[str, Any]:
        files = []
        modified_ms = 0
        for child in sorted(rec_dir.iterdir()):
            if not child.is_file():
                continue
            role = next((r for r, suffix in ROLE_SUFFIX.items() if child.name.lower().endswith(suffix)), "")
            if not role:
                continue
            stat = child.stat()
            modified_ms = max(modified_ms, int(stat.st_mtime * 1000))
            files.append({"role": role, "name": child.name, "size": stat.st_size})
        meta = read_meta(rec_dir / f"{rec_dir.name}{META_SUFFIX}") or {}
        source = meta.get("source") if isinstance(meta.get("source"), dict) else None
        recording = meta.get("recording") if isinstance(meta.get("recording"), dict) else {}
        return {
            "path": rec_dir.relative_to(self.data_root).as_posix(),
            "device_uid": rec_dir.parent.parent.name,
            "recording_id": (source or {}).get("recording_id"),
            # Who made it: an app's source block, or this server.
            "source": source or {"client_type": "server"},
            "started_at": recording.get("started_at"),
            "stopped_at": recording.get("stopped_at"),
            "size": sum(int(item["size"]) for item in files),
            "modified_ms": modified_ms,
            "files": files,
        }

    def resolve_file(self, raw_path: str, role: str) -> Path:
        if role not in ROLES:
            raise SyncError("role_invalid")
        root = self.data_root.resolve()
        relative = Path(str(raw_path or "").strip().strip("/"))
        parts = relative.parts
        if len(parts) != 3 or any(part.startswith((".", "_")) for part in parts):
            raise SyncError("path_invalid")
        rec_dir = (root / relative).resolve()
        try:
            rec_dir.relative_to(root)
        except ValueError:
            raise SyncError("path_invalid", 403) from None
        if not is_recording_dir(rec_dir):
            raise SyncError("recording_not_found", 404)
        for child in rec_dir.iterdir():
            if child.is_file() and child.name.lower().endswith(ROLE_SUFFIX[role]):
                return child
        raise SyncError("file_not_found", 404)

    # ── Helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _check_files(raw: Any) -> dict[str, dict[str, Any]]:
        if not isinstance(raw, list) or not raw:
            raise SyncError("files_required")
        files: dict[str, dict[str, Any]] = {}
        limit = _max_file_bytes()
        for item in raw:
            if not isinstance(item, dict):
                raise SyncError("file_invalid")
            role = str(item.get("role") or "")
            if role not in ROLES or role in files:
                raise SyncError("role_invalid")
            try:
                size = int(item.get("size"))
            except (TypeError, ValueError):
                raise SyncError("size_invalid") from None
            if size < 0 or size > limit:
                raise SyncError("size_invalid", max_file_bytes=limit)
            sha256 = str(item.get("sha256") or "").strip().lower()
            if not _SHA256_PATTERN.fullmatch(sha256):
                raise SyncError("sha256_invalid")
            files[role] = {"size": size, "sha256": sha256}
        if "data" not in files:
            raise SyncError("data_file_required")
        return files

    @staticmethod
    def _read_manifest(staging: Path) -> dict[str, Any] | None:
        try:
            manifest = json.loads((staging / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return manifest if isinstance(manifest, dict) else None

    @staticmethod
    def _upload_payload(staging: Path, manifest: dict[str, Any]) -> dict[str, Any]:
        files = []
        for role, expected in manifest["files"].items():
            part = staging / f"{role}.part"
            files.append({
                "role": role,
                "size": int(expected["size"]),
                "received": part.stat().st_size if part.exists() else 0,
            })
        return {
            "status": "uploading",
            "recording_id": manifest["recording_id"],
            "files": files,
            "max_chunk_bytes": MAX_CHUNK_BYTES,
        }

    @staticmethod
    def _complete_payload(recording_id: str, entry: dict[str, Any]) -> dict[str, Any]:
        return {
            "status": "complete",
            "recording_id": recording_id,
            "path": entry.get("path"),
            "device_uid": entry.get("device_uid"),
            "completed_at_ms": entry.get("completed_at_ms"),
        }
