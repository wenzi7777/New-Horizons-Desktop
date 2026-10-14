"""Whether a command may be sent to a device right now, and the bookkeeping
around commands in flight: the device's mode (normal / maintenance / safe),
the boot transitions enter_maintenance / exit_maintenance / reboot start,
and the pending-command table that turns a status into the result of a
command whose reply was lost.

With a device's own command catalog (firmware v1.15.0+, device_commands.py)
the catalog's flags decide; without one the static tables do.

A mixin of NewHorizonsService (service.py): it shares the service's lock and
state and has no __init__ of its own.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
import time


class CommandGatingMixin:
    def _boot_command_mode_error_locked(self, device_uid: str, payload: dict[str, Any]) -> str:
        status = self._latest_status.get(device_uid) or {}
        catalog_error = self._catalog_command_mode_error(device_uid, status, payload)
        if catalog_error is not None:
            return catalog_error
        return self._boot_command_mode_error_for_status(status, payload)

    def _catalog_command_mode_error(self, device_uid: str, status: dict[str, Any], payload: dict[str, Any]) -> str | None:
        """Mode gating from the device's own flags; None means "no catalog".

        The firmware only distinguishes "needs maintenance" from "runs
        anywhere", so that is all this checks; an unknown mode stays
        wrong_mode as in the static path.
        """
        command = str(payload.get("command") or payload.get("cmd") or "").strip()
        if not command:
            return None
        current_mode = self._mode_from_payload(status)
        if current_mode in ("safe", "safe-maintenance"):
            current_mode = "safe_maintenance"
        # No known mode: only existence is checked, as the static path does.
        maintenance = current_mode != "normal"
        error = self._command_catalogs.mode_error(device_uid, command, maintenance)
        if error is None:
            return None
        if not error and current_mode and current_mode not in self.MODE_COMMANDS:
            return "wrong_mode"
        return error

    @classmethod
    def _boot_command_mode_error_for_status(cls, status: dict[str, Any], payload: dict[str, Any]) -> str:
        command = str(payload.get("command") or payload.get("cmd") or "").strip()
        current_mode = cls._mode_from_payload(status)
        # Existence is the allowlist's question; MODE_COMMANDS only answers
        # "may it run in this mode". Deriving existence from the mode sets is
        # what made every v1.0.0 kernel command fail as "unknown_command".
        if command not in cls.KNOWN_DEVICE_COMMANDS:
            return "unknown_command" if command else ""
        known_commands = set()
        for commands in cls.MODE_COMMANDS.values():
            known_commands.update(commands)
        if not current_mode:
            return ""
        if current_mode in ("safe", "safe-maintenance"):
            current_mode = "safe_maintenance"
        maintenance_only = cls.MAINTENANCE_COMMANDS - cls.NORMAL_COMMANDS
        if command in maintenance_only and current_mode == "normal":
            return "maintenance_required"
        if command not in known_commands:
            return ""
        allowed = cls.MODE_COMMANDS.get(current_mode)
        if allowed is None:
            return "wrong_mode"
        if allowed is not None and command not in allowed:
            return "wrong_mode"
        return ""

    @staticmethod
    def _maintenance_mode_from_result(payload: dict[str, Any]) -> str | None:
        # enter/exit_maintenance acks from the firmware do not include a "mode"
        # field, and the device does not push a status afterwards.  Derive the
        # resulting mode from the command/message so it is recorded on every
        # transport (UDP, gateway, TCP) rather than only the synchronous TCP path.
        if payload.get("ok") is False or str(payload.get("status") or "") == "error":
            return None
        command = str(payload.get("command") or payload.get("cmd") or "")
        message = str(payload.get("message") or "")
        if command == "enter_maintenance" or message == "maintenance_entered":
            return "maintenance"
        if command == "exit_maintenance" or message == "maintenance_exited":
            return "normal"
        return None

    @staticmethod
    def _mode_from_payload(payload: dict[str, Any]) -> str:
        if not isinstance(payload, dict):
            return ""
        mode = str(payload.get("mode") or "").strip().lower()
        if mode:
            return mode
        runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
        return str(runtime.get("mode") or "").strip().lower()

    def _known_mode_from_status_locked(self, device_uid: str) -> str:
        status = self._latest_status.get(device_uid) or {}
        return self._mode_from_payload(status)

    def _has_fresh_direct_mode_locked(self, existing: dict[str, Any], now_iso: str) -> bool:
        # `last_direct_mode_at` is only ever stamped by the direct
        # status/result/parsed write paths (never by the Gateway/Hub relay
        # path) -- see _record_status()/_record_result()/_record_parsed().
        direct_at = existing.get("last_direct_mode_at")
        if not direct_at or not existing.get("mode"):
            return False
        direct_dt = self._parse_iso_datetime(str(direct_at))
        if direct_dt is None:
            return False
        now_dt = self._parse_iso_datetime(now_iso) or datetime.now(timezone.utc)
        age = now_dt.timestamp() - direct_dt.timestamp()
        return 0 <= age <= self.DIRECT_MODE_FRESH_SEC

    def _clear_boot_pending_if_mode_changed_locked(self, device_uid: str, previous_mode: str, current_mode: str) -> None:
        transition = self._boot_transitions.get(device_uid)
        if transition and current_mode and current_mode == str(transition.get("target_mode") or ""):
            self._boot_transitions.pop(device_uid, None)
        if not previous_mode or not current_mode or previous_mode == current_mode:
            return
        pending_for_device = self._pending_commands.get(device_uid)
        if not pending_for_device:
            return
        return

    def _remember_pending_command(self, device_uid: str, payload: dict[str, Any]) -> None:
        request_id = str(payload.get("request_id") or "")
        command = str(payload.get("command") or payload.get("cmd") or "")
        if not request_id or not command:
            return
        boot_target = self._boot_target_mode(command)
        if boot_target:
            self._boot_transitions[device_uid] = {
                "request_id": request_id,
                "command": command,
                "target_mode": boot_target,
                "created_at": time.monotonic(),
                "expires_at": time.monotonic() + self.BOOT_GRACE_SEC,
            }
            existing = dict(self._devices.get(device_uid, {}))
            if existing:
                existing["booting"] = True
                existing["boot_target_mode"] = boot_target
                existing["boot_command"] = command
                existing["mode"] = "booting"
                self._devices[device_uid] = existing
        self._pending_commands.setdefault(device_uid, {})[request_id] = {
            "request_id": request_id,
            "command": command,
            "target_mode": payload.get("target_mode", ""),
            "created_at": time.monotonic(),
        }

    @staticmethod
    def _boot_target_mode(command: str) -> str:
        _ = command
        return ""

    def _active_boot_transition_locked(self, device_uid: str) -> dict[str, Any] | None:
        transition = self._boot_transitions.get(device_uid)
        if not transition:
            return None
        if time.monotonic() > float(transition.get("expires_at") or 0):
            self._boot_transitions.pop(device_uid, None)
            return None
        return transition

    def _with_command_expiry(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = dict(payload)
        if "expires_at_ms" not in result:
            result["expires_at_ms"] = int(time.time() * 1000) + self.COMMAND_TTL_MS
        return result

    def _forget_pending_command(self, device_uid: str, payload: dict[str, Any]) -> None:
        request_id = str(payload.get("request_id") or "")
        if not request_id:
            return
        pending_for_device = self._pending_commands.get(device_uid)
        if not pending_for_device:
            return
        pending_for_device.pop(request_id, None)
        if not pending_for_device:
            self._pending_commands.pop(device_uid, None)

    def _pending_result_from_status(self, device_uid: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            pending_for_device = self._pending_commands.get(device_uid)
            if not pending_for_device:
                return None
            now = time.monotonic()
            for request_id, pending in list(pending_for_device.items()):
                if now - float(pending.get("created_at") or 0) > 30:
                    pending_for_device.pop(request_id, None)
            if not pending_for_device:
                self._pending_commands.pop(device_uid, None)
                return None
            update_state = payload.get("update_state")
            state = update_state if isinstance(update_state, dict) else {}

            for request_id, pending in list(pending_for_device.items()):
                command = str(pending.get("command") or "")
                result = self._result_from_pending_status(command, request_id, payload, state)
                if result is not None:
                    pending_for_device.pop(request_id, None)
                    if not pending_for_device:
                        self._pending_commands.pop(device_uid, None)
                    return result
            return None

    @classmethod
    def _result_from_pending_status(
        cls,
        command: str,
        request_id: str,
        payload: dict[str, Any],
        state: dict[str, Any],
    ) -> dict[str, Any] | None:
        if command in ("status", "query", "memory_status", "scan_health"):
            result = dict(payload)
            result["command"] = command
            result["request_id"] = request_id
            result.setdefault("status", "ok")
            result.setdefault("message", command)
            return result
        if command == "storage_status":
            has_storage_payload = any(
                key in payload for key in ("total_bytes", "used_bytes", "free_bytes", "categories")
            ) or isinstance(payload.get("storage"), dict)
            if not has_storage_payload:
                return None
            result = dict(payload)
            result["command"] = command
            result["request_id"] = request_id
            result.setdefault("status", "ok")
            result.setdefault("message", command)
            return result
        if command == "enter_maintenance" and str(payload.get("mode") or "") == "maintenance":
            result = dict(payload)
            result["command"] = command
            result["request_id"] = request_id
            result.setdefault("status", "ok")
            result.setdefault("message", "maintenance_entered")
            return result
        if command == "exit_maintenance" and str(payload.get("mode") or "") == "normal":
            result = dict(payload)
            result["command"] = command
            result["request_id"] = request_id
            result.setdefault("status", "ok")
            result.setdefault("message", "maintenance_exited")
            return result

        operation = str(state.get("operation") or "")
        phase = str(state.get("phase") or "")
        if command == "check_update" and operation == command and phase == "ready":
            return {
                "status": "ok",
                "message": "update_checked",
                "command": command,
                "request_id": request_id,
                "latest_version": state.get("version", ""),
                "manifest_url": state.get("manifest_url", ""),
                "changelog_url": state.get("changelog_url", ""),
                "update_state": state,
                "reboot_required": False,
            }
        if command == "apply_update" and operation == command and cls._write_state_complete(state):
            state = cls._normalize_completed_write_state(state)
            return {
                "status": "ok",
                "message": "update_applied",
                "command": command,
                "request_id": request_id,
                "version": state.get("version", ""),
                "downloaded_files": int(state.get("downloaded_files") or 0),
                "skipped_files": int(state.get("skipped_files") or 0),
                "deleted_files": int(state.get("deleted_files") or 0),
                "update_state": state,
                "reboot_required": bool(state.get("reboot_required", True)),
            }
        return None
