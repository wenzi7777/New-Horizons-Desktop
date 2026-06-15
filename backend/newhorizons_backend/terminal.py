from __future__ import annotations

import shlex
from typing import Any


DEVICE_COMMAND_ALLOWLIST = {
    "status",
    "query",
    "check_update",
    "apply_update",
    "reboot",
    "enter_maintenance",
    "exit_maintenance",
    "memory_status",
    "scan_health",
    "storage_status",
    "calibration_status",
    "calibration_enable",
    "calibration_disable",
    "calibration_clear_profile",
    "calibration_session_begin",
    "calibration_session_abort",
    "calibration_session_commit",
    "calibration_dump_tare",
    "calibration_dump_level",
    "calibration_delete_level",
    "calibration_capture_tare",
    "calibration_capture_cell",
    "calibration_capture_all",
    "findme_discover",
    "findme_switch_gateway",
    "set_matrix_layout",
    "set_scan_timing",
    "set_stream_buffer",
    "set_charge_profile",
    "power_set_state",
    "set_log",
    "set_ota_config",
    "set_indicators",
    "set_imu",
    "file_list",
    "file_read_begin",
    "file_read_chunk",
    "file_write_begin",
    "file_write_chunk",
    "file_write_finish",
    "file_delete",
    "log_tail",
    "log_clear",
}


def validate_device_command_payload(payload: dict[str, Any]) -> dict[str, Any]:
    command = str(payload.get("command") or "").strip()
    if not command or command not in DEVICE_COMMAND_ALLOWLIST:
        raise ValueError("unknown_command")
    result = dict(payload)
    result["command"] = command
    if "scope" in result:
        scope = str(result.get("scope") or "user").strip()
        if scope not in {"user", "logs", "calibration"}:
            raise ValueError("invalid_scope")
        result["scope"] = scope
    return result


def terminal_help_items() -> list[dict[str, str]]:
    return [
        {
            "command": "status",
            "description": "Query device status.",
            "example": "status",
        },
        {
            "command": "check-update",
            "description": "Check the Arduino firmware update manifest.",
            "example": "check-update",
        },
        {
            "command": "apply-update",
            "description": "Apply an Arduino whole-firmware OTA update.",
            "example": "apply-update",
        },
        {
            "command": "enter-maintenance",
            "description": "Enter maintenance mode and stop normal scanning.",
            "example": "enter-maintenance --reason calibration",
        },
        {
            "command": "exit-maintenance",
            "description": "Exit maintenance mode.",
            "example": "exit-maintenance",
        },
        {
            "command": "scan-health",
            "description": "Query lightweight scan, stream, memory, and control health.",
            "example": "scan-health",
        },
        {
            "command": "set-stream-buffer",
            "description": "Enable or disable the packet ring buffer and choose standard or extended depth.",
            "example": "set-stream-buffer --enabled true --mode extended",
        },
        {
            "command": "calibration-status",
            "description": "Query manual calibration status, coverage, and metadata.",
            "example": "calibration-status",
        },
        {
            "command": "calibration-enable",
            "description": "Enable the saved manual calibration profile.",
            "example": "calibration-enable",
        },
        {
            "command": "calibration-disable",
            "description": "Disable the saved manual calibration profile.",
            "example": "calibration-disable",
        },
        {
            "command": "calibration-clear-profile",
            "description": "Delete the saved calibration profile and all stored levels.",
            "example": "calibration-clear-profile",
        },
        {
            "command": "calibration-session-begin",
            "description": "Start a draft calibration session.",
            "example": "calibration-session-begin",
        },
        {
            "command": "calibration-session-abort",
            "description": "Abort the current draft calibration session.",
            "example": "calibration-session-abort",
        },
        {
            "command": "calibration-session-commit",
            "description": "Commit the current draft calibration session.",
            "example": "calibration-session-commit --auto-enable true",
        },
        {
            "command": "calibration-dump-tare",
            "description": "Dump the saved and draft tare baseline matrix cells.",
            "example": "calibration-dump-tare",
        },
        {
            "command": "calibration-dump-level",
            "description": "Dump one calibration level with saved and draft matrix cells.",
            "example": "calibration-dump-level --level 10",
        },
        {
            "command": "calibration-delete-level",
            "description": "Delete one calibration level from the saved profile or current draft session.",
            "example": "calibration-delete-level --level 10",
        },
        {
            "command": "calibration-capture-cell",
            "description": "Capture one sensor into the current draft calibration session.",
            "example": "calibration-capture-cell --sensor-index 3 --level 10 --duration-ms 2500",
        },
        {
            "command": "calibration-capture-tare",
            "description": "Capture the no-load tare baseline into the current draft calibration session.",
            "example": "calibration-capture-tare --duration-ms 2500",
        },
        {
            "command": "calibration-capture-all",
            "description": "Capture all active sensors into the current draft calibration session.",
            "example": "calibration-capture-all --level 10 --duration-ms 2500",
        },
        {
            "command": "findme-discover",
            "description": "Run FindMe and attach to a New Horizons Gateway on the local network.",
            "example": "findme-discover",
        },
        {
            "command": "findme-switch-gateway",
            "description": "Ask the device to rerun FindMe with a preferred gateway claim.",
            "example": "findme-switch-gateway --preferred-gateway-id local-gateway --claim-id claim-1 --ttl-ms 30000",
        },
        {
            "command": "set-matrix-layout",
            "description": "Configure active analog and select pins.",
            "example": "set-matrix-layout --analog-pins 1,2,3 --select-pins 13,14,15",
        },
        {
            "command": "set-scan-timing",
            "description": "Configure matrix scan timing. WebUI offers 60/90 FPS presets; terminal can set custom values.",
            "example": "set-scan-timing --target-fps 75 --settle-us 20 --send-every-n-frames 2",
        },
        {
            "command": "set-charge-profile",
            "description": "Configure the charging profile. Profiles: ultra_slow (100mA), slow (200mA), balanced (250mA), fast (300mA), extreme (350mA).",
            "example": "set-charge-profile --profile balanced",
        },
        {
            "command": "power-set-state",
            "description": "Switch the device between normal mode and soft-off power states. Some boards use a remote-only soft-off UX.",
            "example": "power-set-state --state soft_off_auto",
        },
        {
            "command": "set-log",
            "description": "Configure device rolling log level and capacity.",
            "example": "set-log --enabled true --level info --mode standard",
        },
        {
            "command": "set-ota-config",
            "description": "Configure boot-time Arduino firmware auto update checks.",
            "example": "set-ota-config --auto-apply-on-boot true --manifest-url https://example.com/arduino-latest.json",
        },
        {
            "command": "set-indicators",
            "description": "Configure supported indicator hardware. Brightness expects decimal values such as 0.10, 0.35, 0.50, or 1.00.",
            "example": "set-indicators --external-led-mode enabled --preset stream_health --brightness 0.35 --oled-mode auto --oled-page live_status",
        },
        {
            "command": "set-imu",
            "description": "Enable or disable the optional IMU service.",
            "example": "set-imu --enabled false",
        },
        {
            "command": "io-config",
            "description": "Open the board-aware pin layout and overview helper in the terminal UI.",
            "example": "io-config",
        },
        {
            "command": "file-list",
            "description": "List maintenance files.",
            "example": "file-list --scope user",
        },
        {
            "command": "file-read-begin",
            "description": "Begin a maintenance-mode file read.",
            "example": "file-read-begin --scope logs --path device.log",
        },
        {
            "command": "file-read-chunk",
            "description": "Read a maintenance-mode file chunk.",
            "example": "file-read-chunk --scope logs --path device.log --offset 0 --length 1024",
        },
        {
            "command": "file-write-begin",
            "description": "Begin a maintenance-mode file write.",
            "example": "file-write-begin --scope user --path configs/profile.json --size 2 --sha256 deadbeef",
        },
        {
            "command": "file-write-chunk",
            "description": "Write a maintenance-mode file chunk.",
            "example": "file-write-chunk --scope user --path configs/profile.json --offset 0 --data 4e48",
        },
        {
            "command": "file-write-finish",
            "description": "Finish a maintenance-mode file write.",
            "example": "file-write-finish --scope user --path configs/profile.json",
        },
        {
            "command": "file-delete",
            "description": "Delete a maintenance file.",
            "example": "file-delete --scope user --path tmp/sample.csv",
        },
        {
            "command": "log-tail",
            "description": "Read the last N log lines.",
            "example": "log-tail --lines 50",
        },
        {
            "command": "log-clear",
            "description": "Clear device.log and device.log.1.",
            "example": "log-clear",
        },
        {
            "command": "reboot",
            "description": "Reboot the current system.",
            "example": "reboot",
        },
    ]


def compile_terminal_command(command_line: str) -> dict[str, Any]:
    argv = shlex.split(command_line or "")
    if not argv:
        raise ValueError("empty_command")
    command = argv[0].strip().lower()
    args = argv[1:]

    simple_commands = {
        "status": "status",
        "check-update": "check_update",
        "apply-update": "apply_update",
        "exit-maintenance": "exit_maintenance",
        "scan-health": "scan_health",
        "storage-status": "storage_status",
        "calibration-status": "calibration_status",
        "calibration-enable": "calibration_enable",
        "calibration-disable": "calibration_disable",
        "calibration-clear-profile": "calibration_clear_profile",
        "calibration-session-begin": "calibration_session_begin",
        "calibration-session-abort": "calibration_session_abort",
        "calibration-dump-tare": "calibration_dump_tare",
        "findme-discover": "findme_discover",
        "log-clear": "log_clear",
        "reboot": "reboot",
    }
    if command in simple_commands:
        payload = {"command": simple_commands[command]}
        return {"command": payload["command"], "payload": payload, "argv": argv}

    if command == "enter-maintenance":
        parsed = _parse_options(args)
        payload = {"command": "enter_maintenance"}
        if "reason" in parsed:
            payload["reason"] = parsed["reason"]
        return {"command": "enter_maintenance", "payload": payload, "argv": argv}

    if command == "calibration-session-commit":
        parsed = _parse_options(args)
        payload = {
            "command": "calibration_session_commit",
            "auto_enable": _as_bool(parsed.get("auto_enable", "false")),
        }
        return {"command": "calibration_session_commit", "payload": payload, "argv": argv}

    if command == "calibration-dump-level":
        parsed = _parse_options(args)
        payload = {
            "command": "calibration_dump_level",
            "level": float(parsed["level"]),
        }
        return {"command": "calibration_dump_level", "payload": payload, "argv": argv}

    if command == "calibration-capture-tare":
        parsed = _parse_options(args)
        payload = {
            "command": "calibration_capture_tare",
            "duration_ms": int(parsed.get("duration_ms", 3000)),
        }
        return {"command": "calibration_capture_tare", "payload": payload, "argv": argv}

    if command == "calibration-delete-level":
        parsed = _parse_options(args)
        payload = {
            "command": "calibration_delete_level",
            "level": float(parsed["level"]),
        }
        return {"command": "calibration_delete_level", "payload": payload, "argv": argv}

    if command == "calibration-capture-cell":
        parsed = _parse_options(args)
        payload = {
            "command": "calibration_capture_cell",
            "sensor_index": int(parsed["sensor_index"]),
            "duration_ms": int(parsed.get("duration_ms", 3000)),
        }
        if "level" in parsed:
            payload["level"] = float(parsed["level"])
        return {"command": "calibration_capture_cell", "payload": payload, "argv": argv}

    if command == "calibration-capture-all":
        parsed = _parse_options(args)
        payload = {
            "command": "calibration_capture_all",
            "level": float(parsed["level"]),
            "duration_ms": int(parsed.get("duration_ms", 3000)),
        }
        return {"command": "calibration_capture_all", "payload": payload, "argv": argv}

    if command == "set-matrix-layout":
        parsed = _parse_options(args)
        analog_pins = parsed.get("analog_pins", "")
        select_pins = parsed.get("select_pins", "")
        payload = {
            "command": "set_matrix_layout",
            "analog_pins": _parse_csv_ints(analog_pins),
            "select_pins": _parse_csv_ints(select_pins),
        }
        return {"command": "set_matrix_layout", "payload": payload, "argv": argv}

    if command == "set-scan-timing":
        parsed = _parse_options(args)
        payload = {"command": "set_scan_timing"}
        if "target_fps" in parsed:
            payload["target_fps"] = int(parsed["target_fps"])
        if "settle_us" in parsed:
            payload["settle_us"] = int(parsed["settle_us"])
        if "send_every_n_frames" in parsed:
            payload["send_every_n_frames"] = int(parsed["send_every_n_frames"])
        if len(payload) == 1:
            raise ValueError("scan_timing_option_required")
        return {"command": "set_scan_timing", "payload": payload, "argv": argv}

    if command == "set-stream-buffer":
        parsed = _parse_options(args)
        mode = parsed.get("mode", "standard")
        if mode not in {"standard", "extended"}:
            raise ValueError("invalid_stream_buffer_mode")
        payload = {
            "command": "set_stream_buffer",
            "enabled": _as_bool(parsed.get("enabled", "true")),
            "mode": mode,
        }
        return {"command": "set_stream_buffer", "payload": payload, "argv": argv}

    if command == "set-charge-profile":
        parsed = _parse_options(args)
        profile = parsed.get("profile", "balanced")
        if profile not in {"ultra_slow", "slow", "balanced", "fast", "extreme"}:
            raise ValueError("invalid_charge_profile")
        payload = {"command": "set_charge_profile", "profile": profile}
        return {"command": "set_charge_profile", "payload": payload, "argv": argv}

    if command == "power-set-state":
        parsed = _parse_options(args)
        state = parsed.get("state", "soft_off_auto")
        if state not in {"normal", "soft_off_auto", "soft_off_battery", "soft_off_charging"}:
            raise ValueError("invalid_power_state")
        payload = {"command": "power_set_state", "state": state}
        return {"command": "power_set_state", "payload": payload, "argv": argv}

    if command == "set-log":
        parsed = _parse_options(args)
        mode = parsed.get("mode", "standard")
        payload = {
            "command": "set_log",
            "enabled": _as_bool(parsed.get("enabled", "true")),
            "level": parsed.get("level", "error"),
            "mode": mode,
            "max_bytes": int(parsed.get("max_bytes", 24576 if mode == "extended" else 12288)),
        }
        return {"command": "set_log", "payload": payload, "argv": argv}

    if command == "set-ota-config":
        parsed = _parse_options(args)
        payload = {
            "command": "set_ota_config",
            "auto_apply_on_boot": _as_bool(parsed.get("auto_apply_on_boot", "false")),
            "manifest_url": parsed.get("manifest_url", ""),
        }
        return {"command": "set_ota_config", "payload": payload, "argv": argv}

    if command == "findme-switch-gateway":
        parsed = _parse_options(args)
        payload = {
            "command": "findme_switch_gateway",
            "preferred_gateway_id": parsed["preferred_gateway_id"],
            "claim_id": parsed.get("claim_id", ""),
            "ttl_ms": int(parsed.get("ttl_ms", 30000)),
        }
        return {"command": "findme_switch_gateway", "payload": payload, "argv": argv}

    if command == "set-indicators":
        parsed = _parse_options(args)
        payload: dict[str, Any] = {"command": "set_indicators"}
        external: dict[str, Any] = {}
        oled: dict[str, Any] = {}
        if "external_led_mode" in parsed:
            mode = parsed["external_led_mode"]
            if mode not in {"off", "enabled"}:
                raise ValueError("invalid_external_led_mode")
            external["mode"] = mode
        if "preset" in parsed:
            external["preset"] = parsed["preset"]
        if "brightness" in parsed:
            external["brightness"] = float(parsed["brightness"])
        if "oled_mode" in parsed:
            mode = parsed["oled_mode"]
            if mode not in {"off", "auto", "enabled"}:
                raise ValueError("invalid_oled_mode")
            oled["mode"] = mode
        if "oled_page" in parsed:
            oled["page"] = parsed["oled_page"]
        if "oled_update_hz" in parsed:
            oled["update_hz"] = int(parsed["oled_update_hz"])
        if "oled_contrast" in parsed:
            oled["contrast"] = int(parsed["oled_contrast"])
        if external:
            payload["external_led"] = external
        if oled:
            payload["oled"] = oled
        if len(payload) == 1:
            raise ValueError("indicator_option_required")
        return {"command": "set_indicators", "payload": payload, "argv": argv}

    if command == "set-imu":
        parsed = _parse_options(args)
        payload = {
            "command": "set_imu",
            "enabled": _as_bool(parsed.get("enabled", "true")),
        }
        return {"command": "set_imu", "payload": payload, "argv": argv}

    if command == "file-list":
        parsed = _parse_options(args)
        payload = {"command": "file_list"}
        _add_scope(payload, parsed)
        return {"command": "file_list", "payload": payload, "argv": argv}

    if command == "file-read-begin":
        parsed = _parse_options(args)
        payload = {"command": "file_read_begin", "path": parsed["path"]}
        _add_scope(payload, parsed)
        return {"command": "file_read_begin", "payload": payload, "argv": argv}

    if command == "file-read-chunk":
        parsed = _parse_options(args)
        payload = {
            "command": "file_read_chunk",
            "path": parsed["path"],
            "offset": int(parsed.get("offset", 0)),
            "length": int(parsed.get("length", 1024)),
        }
        _add_scope(payload, parsed)
        return {"command": "file_read_chunk", "payload": payload, "argv": argv}

    if command == "file-write-begin":
        parsed = _parse_options(args)
        payload = {
            "command": "file_write_begin",
            "path": parsed["path"],
            "size": int(parsed["size"]),
            "sha256": parsed.get("sha256", ""),
        }
        _add_scope(payload, parsed)
        return {"command": "file_write_begin", "payload": payload, "argv": argv}

    if command == "file-write-chunk":
        parsed = _parse_options(args)
        payload = {
            "command": "file_write_chunk",
            "path": parsed["path"],
            "offset": int(parsed.get("offset", 0)),
            "data": parsed.get("data", parsed.get("data_hex", "")),
        }
        _add_scope(payload, parsed)
        return {"command": "file_write_chunk", "payload": payload, "argv": argv}

    if command == "file-write-finish":
        parsed = _parse_options(args)
        payload = {"command": "file_write_finish", "path": parsed["path"]}
        _add_scope(payload, parsed)
        return {"command": "file_write_finish", "payload": payload, "argv": argv}

    if command == "file-delete":
        parsed = _parse_options(args)
        payload = {"command": "file_delete", "path": parsed["path"]}
        _add_scope(payload, parsed)
        return {"command": "file_delete", "payload": payload, "argv": argv}

    if command == "log-tail":
        parsed = _parse_options(args)
        payload = {"command": "log_tail", "max_lines": int(parsed.get("lines", parsed.get("max_lines", 50)))}
        return {"command": "log_tail", "payload": payload, "argv": argv}

    raise ValueError("unknown_command")


def _parse_options(args: list[str]) -> dict[str, str]:
    parsed: dict[str, str] = {}
    idx = 0
    while idx < len(args):
        token = args[idx]
        if not token.startswith("--"):
            raise ValueError("unexpected_argument")
        key = token[2:].replace("-", "_")
        if idx + 1 >= len(args):
            raise ValueError("missing_option_value")
        parsed[key] = args[idx + 1]
        idx += 2
    return parsed


def _parse_csv_ints(value: str) -> list[int]:
    return [int(part.strip()) for part in value.split(",") if part.strip()]


def _add_scope(payload: dict[str, Any], parsed: dict[str, str]) -> None:
    if "scope" in parsed:
        payload["scope"] = parsed["scope"]


def _as_bool(value: str | bool) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}
