"""Firmware-update progress as the Desktop shows it: reading a device's
check_update / apply_update results (direct, relayed through a Gateway or
a Hub) into one update_state, and merging successive reports so a partial
one never wipes what is known.

A mixin of NewHorizonsService (service.py); stateless (static and class
methods only).
"""
from __future__ import annotations

from typing import Any


class UpdateStateMixin:
    # The reply a Direct-mode (ESP-NOW) device sends to check_update /
    # apply_update only *starts* the Hub-relayed operation; the state it
    # carries is still "idle" with no version (firmware v1.13.0 and earlier).
    # Taken literally it overwrote the last known update info with blanks.
    RELAYED_UPDATE_START = {"update_check_started": "checking", "update_started": "starting"}

    @classmethod
    def _mark_relayed_update_started(cls, payload: dict[str, Any]) -> None:
        phase = cls.RELAYED_UPDATE_START.get(str(payload.get("message") or ""))
        if phase is None:
            return
        for container in (payload, payload.get("data")):
            if not isinstance(container, dict):
                continue
            state = container.get("update_state")
            if isinstance(state, dict) and str(state.get("phase") or "idle") == "idle":
                state = dict(state)
                state["phase"] = phase
                state.setdefault("operation", "check_update" if phase == "checking" else "apply_update")
                # Blank fields would erase what the last status knew.
                container["update_state"] = {k: v for k, v in state.items() if v not in ("", None)}

    @staticmethod
    def _update_state_from_result(payload: dict[str, Any]) -> dict[str, Any] | None:
        message = str(payload.get("message") or "")
        if message == "update_checked":
            return {
                "phase": "ready",
                "operation": "check_update",
                "version": payload.get("version") or payload.get("latest_version", ""),
                "manifest_url": payload.get("manifest_url", ""),
                "changelog_url": payload.get("changelog_url", ""),
                "total_files": 0,
                "applied_files": 0,
                "downloaded_files": 0,
                "skipped_files": 0,
                "current_file": "",
                "last_error": "",
                "last_result": "manifest_ready",
                "reboot_required": False,
            }
        if message == "update_applied":
            downloaded = int(payload.get("downloaded_files") or 0)
            skipped = int(payload.get("skipped_files") or 0)
            total = int(payload.get("total_files") or downloaded + skipped or 1)
            return {
                "phase": "done",
                "operation": "apply_update",
                "version": payload.get("version", ""),
                "total_files": total,
                "applied_files": total,
                "downloaded_files": downloaded,
                "skipped_files": skipped,
                "deleted_files": int(payload.get("deleted_files") or 0),
                "current_file": "",
                "last_error": "",
                "last_result": "applied",
                "reboot_required": bool(payload.get("reboot_required", True)),
            }
        if message == "update_started":
            return {
                "phase": "downloading",
                "operation": "apply_update",
                "version": payload.get("version", ""),
                "total_files": 0,
                "applied_files": 0,
                "downloaded_files": 0,
                "skipped_files": 0,
                "current_file": payload.get("current_file", "firmware"),
                "last_error": "",
                "last_result": "starting",
                "reboot_required": bool(payload.get("reboot_required", True)),
            }
        if message == "command_failed" or payload.get("status") == "error":
            return {
                "phase": "error",
                "operation": str(payload.get("command") or ""),
                "total_files": 0,
                "applied_files": 0,
                "downloaded_files": 0,
                "skipped_files": 0,
                "current_file": "",
                "last_error": str(payload.get("error") or payload.get("message") or "command_failed"),
                "last_result": "error",
                "reboot_required": False,
            }
        return None

    @classmethod
    def _write_state_complete(cls, state: dict[str, Any]) -> bool:
        if str(state.get("operation") or "") != "apply_update":
            return False
        if str(state.get("phase") or "") == "done":
            return True
        try:
            total = int(state.get("total_files") or 0)
        except (TypeError, ValueError):
            total = 0
        return total > 0 and cls._applied_count(state) >= total

    @classmethod
    def _normalize_completed_write_state(cls, state: dict[str, Any]) -> dict[str, Any]:
        if not cls._write_state_complete(state):
            return state
        result = dict(state)
        result["phase"] = "done"
        result["current_file"] = ""
        result["last_error"] = ""
        result["last_result"] = "applied"
        result["reboot_required"] = True
        return result

    @staticmethod
    def _applied_count(state: dict[str, Any]) -> int:
        try:
            applied = int(state.get("applied_files") or 0)
        except (TypeError, ValueError):
            applied = 0
        if applied:
            return applied
        try:
            downloaded = int(state.get("downloaded_files") or 0)
        except (TypeError, ValueError):
            downloaded = 0
        try:
            skipped = int(state.get("skipped_files") or 0)
        except (TypeError, ValueError):
            skipped = 0
        return downloaded + skipped

    @classmethod
    def _finalize_apply_update_for_firmware_version(cls, payload: Any) -> Any:
        if not isinstance(payload, dict):
            return payload
        state = payload.get("update_state")
        if not isinstance(state, dict):
            return payload
        if str(state.get("operation") or "") != "apply_update":
            return payload
        firmware_version = str(payload.get("firmware_version") or "")
        target_version = str(state.get("version") or "")
        if not firmware_version or not target_version or firmware_version != target_version:
            return payload

        result = dict(payload)
        completed = dict(state)
        try:
            total = int(completed.get("total_files") or 0)
        except (TypeError, ValueError):
            total = 0
        try:
            downloaded = int(completed.get("downloaded_files") or 0)
        except (TypeError, ValueError):
            downloaded = 0
        try:
            skipped = int(completed.get("skipped_files") or 0)
        except (TypeError, ValueError):
            skipped = 0

        if total <= 0:
            total = max(downloaded + skipped, 1)
        if downloaded <= 0 and skipped <= 0:
            downloaded = 1
        try:
            applied = int(completed.get("applied_files") or 0)
        except (TypeError, ValueError):
            applied = 0

        completed["phase"] = "done"
        completed["total_files"] = total
        completed["applied_files"] = max(applied, total)
        completed["downloaded_files"] = downloaded
        completed["skipped_files"] = skipped
        completed["current_file"] = ""
        completed["last_error"] = ""
        completed["last_result"] = "applied"
        completed["reboot_required"] = True
        result["update_state"] = completed
        return result

    @classmethod
    def _merge_update_state(
        cls,
        existing: Any,
        incoming: Any,
        existing_mode: str = "",
        incoming_mode: str = "",
    ) -> Any:
        if not isinstance(incoming, dict):
            return existing
        incoming = cls._normalize_completed_write_state(incoming)
        if not isinstance(existing, dict):
            return incoming
        existing = cls._normalize_completed_write_state(existing)

        existing_phase = str(existing.get("phase") or "")
        incoming_phase = str(incoming.get("phase") or "")
        existing_operation = str(existing.get("operation") or "")
        incoming_operation = str(incoming.get("operation") or "")
        mode_changed = bool(existing_mode and incoming_mode and existing_mode != incoming_mode)

        if incoming_phase in ("", "idle") and existing_operation:
            if mode_changed:
                return incoming
            return existing
        if (
            existing_phase == "done"
            and incoming_operation == existing_operation
            and incoming_operation == "apply_update"
            and incoming_phase == "downloading"
            and str(incoming.get("last_result") or "") in ("starting", "planned")
        ):
            return incoming
        if existing_phase == "done" and incoming_phase != "done":
            if mode_changed:
                return incoming
            return existing
        if incoming_operation == existing_operation and incoming_operation == "apply_update":
            if cls._applied_count(incoming) < cls._applied_count(existing):
                return existing
        return incoming
