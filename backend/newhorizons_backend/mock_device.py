"""The mock device (NEWHORIZONS_MOCK_MODE=1): a simulated device the UI can be
developed against without hardware. Answers commands the way the firmware
would, from in-memory state.

A mixin of NewHorizonsService (service.py): it shares the service's lock and
state and has no __init__ of its own.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import hashlib
import json
import time

from .board_profile import GCU_HARDWARE_MODEL, V1_HARDWARE_MODEL, board_profile_for_hardware_model
from .service_constants import MOCK_FIRMWARE_VERSION


class MockDeviceMixin:
    def _publish_mock_command(self, device_uid: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            status = dict(self._latest_status.get(device_uid) or self._mock_status_payload(device_uid))
            runtime = dict(status.get("runtime") or {})
            transport = dict(runtime.get("transport") or {})
            wifi_cfg = dict(status.get("wifi") or {})
            logging_cfg = dict(status.get("logging") or runtime.get("logging") or {})
            command = str(payload.get("command") or "").strip()
            mode_error = self._boot_command_mode_error_for_status(status, payload)
            if mode_error:
                raise RuntimeError(mode_error)

            if command in ("status", "query", "memory_status", "scan_health"):
                pass
            elif command == "storage_status":
                status["storage"] = self._mock_storage_usage(device_uid)
            elif command == "check_update":
                status["update_state"] = {
                    "phase": "ready",
                    "operation": "check_update",
                    "version": "v0.5.1",
                    "manifest_url": str(payload.get("manifest_url") or ""),
                    "changelog_url": "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/notes/v0.5.1.md",
                    "total_files": 0,
                    "applied_files": 0,
                    "current_file": "",
                    "last_error": "",
                    "last_result": "manifest_ready",
                    "reboot_required": False,
                }
            elif command == "set_ota_config":
                ota_cfg = dict(status.get("ota") or {})
                ota_cfg.update({
                    "auto_apply_on_boot": bool(payload.get("auto_apply_on_boot", ota_cfg.get("auto_apply_on_boot", False))),
                    "manifest_url": str(payload["manifest_url"]) if "manifest_url" in payload else str(ota_cfg.get("manifest_url") or ""),
                })
                if str(payload.get("channel") or "") in ("stable", "beta"):
                    ota_cfg["channel"] = str(payload["channel"])
                if "channel" in ota_cfg:
                    base = "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v10f"
                    suffix = "-beta.json" if ota_cfg["channel"] == "beta" else "-latest.json"
                    ota_cfg["resolved_manifest_url"] = ota_cfg["manifest_url"] or base + suffix
                status["ota"] = ota_cfg
            elif command == "apply_update":
                status.setdefault("system", {})["firmware_version"] = "v0.5.1"
                status["firmware_version"] = "v0.5.1"
                status["update_state"] = {
                    "phase": "done",
                    "operation": "apply_update",
                    "version": "v0.5.1",
                    "total_files": 1,
                    "applied_files": 1,
                    "skipped_files": 0,
                    "downloaded_files": 1,
                    "current_file": "",
                    "last_error": "",
                    "last_result": "applied",
                    "reboot_required": True,
                }
            elif command == "enter_maintenance":
                runtime["mode"] = "maintenance"
                status["mode"] = "maintenance"
                status["maintenance_reason"] = payload.get("reason", "")
                status["scan_stopped"] = True
            elif command == "exit_maintenance":
                runtime["mode"] = "normal"
                status["mode"] = "normal"
                status["maintenance_reason"] = ""
                status["scan_stopped"] = False
            elif command == "set_wifi":
                wifi_cfg.update(
                    {
                        "ssid": payload.get("ssid", ""),
                        "password_set": bool(payload.get("password")),
                    }
                )
                status["wifi"] = wifi_cfg
            elif command == "power_set_state":
                requested_state = str(payload.get("state") or "soft_off_auto")
                power = dict(status.get("power") or {})
                effective_state = requested_state
                if requested_state == "soft_off_auto":
                    effective_state = "soft_off_charging" if power.get("charger_present") else "soft_off_battery"
                power.update({
                    "state": "normal" if requested_state == "normal" else effective_state,
                    "wake_source": "command",
                    "soft_off_reason": "command",
                    "charger_present": bool(power.get("charger_present", False)),
                    "charge_state": str(power.get("charge_state") or "not_charging"),
                })
                status["power"] = power
            elif command == "findme_discover":
                gateway = {
                    "host": "127.0.0.1",
                    "udp_port": int(self._udp_ingest.bound_port if self._udp_ingest else self._udp_port),
                    "gateway_id": self._gateway_id,
                    "gateway_name": "NHOS Gateway",
                    "source": "findme",
                    "state": "discovered",
                    "last_success_ms": int(datetime.now(timezone.utc).timestamp() * 1000),
                    "last_error": "",
                }
                runtime["server"] = {
                    "host": gateway["host"],
                    "udp_port": gateway["udp_port"],
                    "gateway_id": gateway["gateway_id"],
                    "source": "findme",
                }
                runtime["findme"] = gateway
                status["findme"] = gateway
            elif command == "set_transport":
                transport.update(
                    {
                        "mode": "udp",
                    }
                )
                runtime["transport"] = transport
            elif command == "set_matrix_layout":
                rows = payload.get("analog_pins") or []
                cols = payload.get("select_pins") or []
                if isinstance(rows, list) and isinstance(cols, list):
                    status["matrix_shape"] = {"rows": len(rows), "cols": len(cols)}
                    status["matrix_layout"] = {"active_rows": rows, "active_cols": cols}
            elif command == "set_scan_timing":
                scan_timing = dict(runtime.get("scan_timing") or {})
                if payload.get("target_fps") is not None:
                    scan_timing["target_fps"] = int(payload.get("target_fps"))
                if payload.get("settle_us") is not None:
                    scan_timing["settle_us"] = int(payload.get("settle_us"))
                if payload.get("send_every_n_frames") is not None:
                    scan_timing["send_every_n_frames"] = int(payload.get("send_every_n_frames"))
                runtime["scan_timing"] = scan_timing
                # IMU sample rate mirrors the matrix scan rate, matching real firmware behavior.
                imu = dict(runtime.get("imu") or {})
                imu["sample_rate_hz"] = scan_timing.get("target_fps", 60)
                runtime["imu"] = imu
                status["imu"] = imu
            elif command == "set_stream_buffer":
                enabled = bool(payload.get("enabled", True))
                mode = str(payload.get("mode") or "standard")
                depth_frames = 5 if enabled and mode == "extended" else (3 if enabled else 0)
                stream_buffer = dict(runtime.get("stream_buffer") or {})
                stream_buffer.update({
                    "enabled": enabled,
                    "mode": mode,
                    "depth_frames": depth_frames,
                })
                runtime["stream_buffer"] = stream_buffer
                status["stream_buffer"] = dict(stream_buffer)
                scan_health = dict(status.get("scan_health") or {})
                scan_health.update({
                    "queue_enabled": enabled,
                    "queue_depth_frames": depth_frames,
                    "queue_capacity_frames": depth_frames,
                    "queue_occupied_frames": 0,
                    "queue_dropped_frames": int(scan_health.get("queue_dropped_frames", 0) or 0),
                    "queue_max_occupied_frames": int(scan_health.get("queue_max_occupied_frames", 0) or 0),
                })
                status["scan_health"] = scan_health
            elif command == "set_charge_profile":
                _profile_current_ma = {
                    "ultra_slow": 100,
                    "slow": 200,
                    "balanced": 250,
                    "fast": 300,
                    "extreme": 350,
                }
                profile = str(payload.get("profile") or "balanced")
                charge_current_ma = _profile_current_ma.get(profile, 250)
                if profile not in _profile_current_ma:
                    profile = "balanced"
                battery = dict(status.get("battery") or {})
                battery.update({
                    "charger": "integrated",
                    "configured": True,
                    "profile": profile,
                    "charge_current_ma": charge_current_ma,
                    "input_limit_ma": 500,
                    "vbat_reg_mv": 4200,
                    "termination_percent": 10,
                    "precharge_percent": 20,
                    "safety_timer_hours": 6,
                })
                status["battery"] = battery
            elif command == "set_battery_profile":
                battery = dict(status.get("battery") or {})
                battery.update({
                    "configured": True,
                    "capacity_mah": int(payload["capacity_mah"]),
                    "max_charge_current_ma": int(payload["max_charge_current_ma"]),
                    "profile_resolved": True,
                    "battery_profile_required": False,
                    "profile_source": "manual",
                })
                status["battery"] = battery
            elif command == "set_imu":
                enabled = bool(payload.get("enabled", True))
                imu = dict(runtime.get("imu") or {})
                imu.update(
                    {
                        "enabled": enabled,
                        "runtime_enabled": enabled,
                        "state": "ready" if enabled else "disabled",
                        "last_error": "",
                        "sample_rate_hz": runtime.get("scan_timing", {}).get("target_fps", 60),
                    }
                )
                runtime["imu"] = imu
                status["imu"] = imu
            elif command == "set_filter":
                enabled = bool(payload.get("enabled", False))
                median = int(payload.get("median", 3))
                alpha = float(payload.get("alpha", 0.25))
                if median not in (1, 3, 5):
                    median = 3
                alpha = max(0.05, min(0.6, alpha))
                filter_cfg = dict(runtime.get("filter") or {})
                filter_cfg.update({"enabled": enabled, "median": median, "alpha": alpha})
                runtime["filter"] = filter_cfg
                status["filter"] = dict(filter_cfg)
            elif command == "set_log":
                mode = str(payload.get("mode") or "standard")
                max_bytes = int(payload.get("max_bytes") or (24576 if mode == "extended" else 12288))
                logging_cfg.update({
                    "enabled": bool(payload.get("enabled", True)),
                    "mode": mode,
                    "level": str(payload.get("level") or "error"),
                    "max_bytes": max_bytes,
                    "effective_total_bytes": max_bytes * 2,
                })
                runtime["logging"] = logging_cfg
                status["logging"] = logging_cfg
            elif command == "set_indicators":
                profile = board_profile_for_hardware_model(
                    status.get("hardware_model") or runtime.get("hardware_model") or self._devices.get(device_uid, {}).get("hardware_model")
                )
                indicators = dict(runtime.get("indicators") or {})
                external = dict(indicators.get("external_led") or {})
                oled = dict(indicators.get("oled") or {})
                if isinstance(payload.get("external_led"), dict):
                    external.update(payload.get("external_led") or {})
                if isinstance(payload.get("oled"), dict):
                    oled.update(payload.get("oled") or {})
                external.setdefault("mode", "off")
                external.setdefault("preset", "system_status")
                external.setdefault("color", "teal")
                external.setdefault("brightness", 0.35)
                external.setdefault("last_show_ms", 0)
                external.setdefault("last_error", "")
                oled.setdefault("mode", "off")
                oled.setdefault("page", "live_status")
                oled.setdefault("update_hz", 1)
                oled.setdefault("contrast", 128)
                if profile.get("supports_external_led"):
                    external["count"] = 3
                    external["pin"] = 12
                    external["initialized"] = True
                else:
                    external["initialized"] = False
                    external["supported"] = False
                    external.pop("count", None)
                    external.pop("pin", None)
                if not profile.get("supports_oled"):
                    oled["detected"] = False
                    oled["enabled"] = False
                    oled["supported"] = False
                    oled["addr"] = ""
                indicators["external_led"] = external
                indicators["oled"] = oled
                runtime["indicators"] = indicators
                status["indicators"] = {
                    "external_led": {
                        **external,
                        "active_preset": external.get("preset", "system_status") if external.get("mode") == "enabled" and profile.get("supports_external_led") else "off",
                    },
                    "oled": {
                        **oled,
                        "detected": bool(oled.get("detected", False) and profile.get("supports_oled")),
                        "enabled": bool(oled.get("mode") in {"auto", "enabled"} and oled.get("detected", False) and profile.get("supports_oled")),
                        "addr": oled.get("addr", ""),
                        "last_error": oled.get("last_error", ""),
                    },
                }
                status["config"] = {"schema_version": 1, "loaded": True, "last_error": ""}

            runtime["transport"] = transport or runtime.get("transport") or {"mode": "udp"}
            runtime.setdefault("mode", status.get("mode", "normal"))
            runtime.setdefault(
                "logging",
                logging_cfg or {
                    "enabled": True,
                    "capacity": "standard",
                    "serial": "status",
                    "level": "error",
                    "mode": "standard",
                    "max_bytes": 12288,
                    "effective_total_bytes": 24576,
                    "bytes": 0,
                    "path": "/logs/device.log",
                },
            )
            status["runtime"] = runtime
            status["mode"] = runtime.get("mode", status.get("mode", "normal"))
            status["logging"] = runtime.get("logging", status.get("logging", {}))

            self._record_status(device_uid, status)

            result_payload = {
                "ok": True,
                "mock": True,
                "command": command or "unknown",
                "device_uid": device_uid,
                "applied_at": datetime.now(timezone.utc).isoformat(),
            }
            if payload.get("request_id"):
                result_payload["request_id"] = payload.get("request_id")
            if command == "file_list":
                scope = str(payload.get("scope", "user"))
                result_payload["scope"] = scope
                result_payload["items"] = self._mock_files_for_device(device_uid, scope)
                result_payload["storage"] = self._mock_storage_usage(device_uid)
            elif command == "check_update":
                result_payload.update({
                    "status": "ok",
                    "message": "update_checked",
                    "available": True,
                    "version": "v0.5.1",
                    "url": "https://example.com/newhorizons-os-v0.5.1.bin",
                    "size": 1024,
                    "sha256": "0" * 64,
                    "changelog_url": "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/notes/v0.5.1.md",
                    "error": "",
                    "update_state": status.get("update_state", {}),
                })
            elif command == "apply_update":
                result_payload.update({
                    "status": "ok",
                    "message": "update_applied",
                    "applied": True,
                    "reboot_required": True,
                })
            elif command.startswith("app_"):
                result_payload.update(self._mock_app_command(device_uid, command, payload))
            elif command.startswith("calibration_"):
                result_payload.update(self._mock_calibration_command(device_uid, status, command, payload))
            elif command in ("file_write_begin", "file_write_chunk", "file_write_finish"):
                result_payload.update(self._mock_file_write(device_uid, command, payload))
            elif command == "file_read_begin":
                result_payload["path"] = payload.get("path", "")
                result_payload["scope"] = str(payload.get("scope", "user"))
                result_payload["size"] = len(self._mock_read_file(device_uid, str(payload.get("path", "")), str(payload.get("scope", "user"))))
            elif command == "file_read_chunk":
                path = str(payload.get("path", ""))
                offset = int(payload.get("offset", 0))
                length = int(payload.get("length", 1024))
                result_payload["path"] = path
                result_payload["scope"] = str(payload.get("scope", "user"))
                result_payload["offset"] = offset
                result_payload["data"] = self._mock_read_file(device_uid, path, str(payload.get("scope", "user")))[offset:offset + length]
            elif command == "file_delete":
                result_payload.update(self._mock_file_delete(device_uid, payload))
            elif command == "log_tail":
                result_payload["lines"] = ["mock log line 1", "mock log line 2"]
            elif command in ("status", "memory_status"):
                result_payload["status"] = status
            elif command == "storage_status":
                storage = dict(status.get("storage") or self._mock_storage_usage(device_uid))
                result_payload.update(storage)
                result_payload["storage"] = storage
                result_payload["message"] = "storage_status"
            elif command == "findme_discover":
                result_payload.update({
                    "status": "ok",
                    "message": "findme_discovered",
                    "findme": runtime.get("findme", {}),
                    "runtime": runtime,
                })
            elif command == "set_imu":
                result_payload.update({
                    "status": "ok",
                    "message": "imu_updated",
                    "imu": runtime.get("imu", {}),
                    "runtime": {"imu": runtime.get("imu", {})},
                    "applied": True,
                })
            elif command == "set_filter":
                result_payload.update({
                    "status": "ok",
                    "message": "filter_updated",
                    "filter": runtime.get("filter", {}),
                    "runtime": {"filter": runtime.get("filter", {})},
                    "applied": True,
                })
            elif command == "set_stream_buffer":
                result_payload.update({
                    "status": "ok",
                    "message": "stream_buffer_updated",
                    "stream_buffer": status.get("stream_buffer", {}),
                    "scan_health": status.get("scan_health", {}),
                    "runtime": {"stream_buffer": runtime.get("stream_buffer", {})},
                    "applied": True,
                })
            elif command == "set_log":
                result_payload.update({
                    "status": "ok",
                    "message": "log_config_updated",
                    "logging": status.get("logging", {}),
                    "runtime": {"logging": runtime.get("logging", {})},
                    "applied": True,
                })
            elif command == "set_ota_config":
                result_payload.update({
                    "status": "ok",
                    "message": "ota_config_updated",
                    "ota": status.get("ota", {}),
                    "applied": True,
                })
            elif command == "set_charge_profile":
                result_payload.update({
                    "status": "ok",
                    "message": "charge_profile_updated",
                    "battery": status.get("battery", {}),
                    "applied": True,
                })
            elif command == "set_battery_profile":
                result_payload.update({
                    "status": "ok",
                    "message": "battery_profile_updated",
                    "battery": status.get("battery", {}),
                    "applied": True,
                })
            elif command == "battery_status":
                result_payload.update({
                    "status": "ok",
                    "message": "battery_status",
                    "battery": status.get("battery", {}),
                    "battery_gauge": status.get("battery_gauge", {}),
                    "power": status.get("power", {}),
                })
            else:
                result_payload["payload"] = payload

            self._record_result(device_uid, result_payload)
            return {
                "status": "queued",
                "transport": "udp",
                "device_uid": device_uid,
                "payload": payload,
                "mock": True,
            }

    def _seed_mock_state(self) -> None:
        samples = {
            "NH-MOCK-001": {
                "mode": "normal",
                "matrix_shape": {"rows": 4, "cols": 4},
                "p": [3.2, 5.1, 4.8, 2.9, 7.4, 11.2, 10.8, 5.5, 6.3, 12.5, 13.8, 8.4, 2.1, 5.0, 5.3, 2.7],
                "gyro": [0.01, -0.02, 0.03],
                "acc": [0.02, 0.98, 0.08],
                "timestamp_ms": 1716026905000,
                "sn": 16,
            },
            "NH-MOCK-002": {
                "mode": "normal",
                "matrix_shape": {"rows": 4, "cols": 4},
                "p": [1.1, 1.5, 2.2, 2.9, 3.8, 5.5, 6.9, 4.1, 4.0, 7.1, 8.3, 5.0, 2.5, 3.3, 3.7, 2.0],
                "gyro": [0.04, 0.01, -0.01],
                "acc": [0.06, 0.94, 0.12],
                "timestamp_ms": 1716026911000,
                "sn": 16,
            },
            "NH-MOCK-GCU": {
                "mode": "normal",
                "hardware_model": GCU_HARDWARE_MODEL,
                "matrix_shape": {"rows": 15, "cols": 15},
                "p": [2.2] * 225,
                "gyro": [0.02, 0.01, -0.02],
                "acc": [0.01, 0.99, 0.04],
                "timestamp_ms": 1716026922000,
                "sn": 225,
            },
        }

        for device_uid in samples:
            self._mock_apps[device_uid] = self._mock_default_apps()
            self._mock_packages[device_uid] = self._mock_default_packages()
        # One device carries a killed app, so the overrun/revive UI has something
        # real to render against. Killing "rules" rather than inventing a third
        # app keeps the roster to what a v1.0.0 device actually has.
        killed = next(a for a in self._mock_apps["NH-MOCK-002"] if a["name"] == "flow")
        killed.update({"state": "killed", "overruns": 5, "last_us": 2130, "max_us": 2410})

        for device_uid, sample in samples.items():
            self._record_status(
                device_uid,
                self._mock_status_payload(
                    device_uid,
                    mode=sample["mode"],
                    matrix_shape=sample["matrix_shape"],
                    hardware_model=sample.get("hardware_model", V1_HARDWARE_MODEL),
                ),
            )
            self._record_parsed(
                device_uid,
                {
                    "dn": device_uid,
                    "device_name": device_uid,
                    "device_id": device_uid,
                    "frame_id": 1,
                    "sn": sample["sn"],
                    "p": sample["p"],
                    "gyro": sample["gyro"],
                    "acc": sample["acc"],
                    "imu": {
                        "gyro": sample["gyro"],
                        "acc": sample["acc"],
                        "temperature_c": 24.5,
                    },
                    "matrix_shape": sample["matrix_shape"],
                    "timestamp_ms": sample["timestamp_ms"],
                },
                source="mock_seed",
            )
            self._record_result(
                device_uid,
                {
                    "ok": True,
                    "mock": True,
                    "command": "bootstrap",
                    "device_uid": device_uid,
                    "applied_at": datetime.now(timezone.utc).isoformat(),
                },
            )

    @staticmethod
    def _mock_services(mode: str = "normal", scan_running: bool | None = None, udp_running: bool | None = None) -> list[dict[str, Any]]:
        if scan_running is None:
            scan_running = mode == "normal"
        if udp_running is None:
            udp_running = True
        return [
            {
                "id": "matrix_scan",
                "label": "Matrix scan",
                "running": bool(scan_running),
                "status": "active" if scan_running else "stopped",
                "detail": "4x4",
                "actions": ["stop", "restart"] if scan_running else ["start"],
            },
            {
                "id": "udp_stream",
                "label": "UDP stream",
                "running": bool(udp_running),
                "status": "active" if udp_running else "stopped",
                "detail": "sent=0 failed=0",
                "actions": ["stop", "restart"] if udp_running else ["start"],
            },
            {
                "id": "gateway_control",
                "label": "Gateway control",
                "running": True,
                "status": "attached",
                "detail": "newhorizons-standalone",
                "actions": ["restart"],
            },
            {
                "id": "time_sync",
                "label": "Time sync",
                "running": True,
                "status": "running",
                "detail": "",
                "actions": ["stop", "restart"],
            },
            {
                "id": "logging",
                "label": "Logging",
                "running": True,
                "status": "enabled",
                "detail": "default",
                "actions": ["stop"],
            },
        ]

    def _mock_status_payload(
        self,
        device_uid: str,
        mode: str = "normal",
        matrix_shape: dict[str, int] | None = None,
        hardware_model: str = V1_HARDWARE_MODEL,
    ) -> dict[str, Any]:
        shape = matrix_shape or {"rows": 4, "cols": 4}
        profile = board_profile_for_hardware_model(hardware_model)
        indicators = {
            "external_led": {
                "mode": "off",
                "preset": "system_status",
                "color": "teal",
                "brightness": 0.35,
                "last_show_ms": 0,
                "last_error": "",
                "supported": bool(profile.get("supports_external_led")),
            },
            "oled": {
                "mode": "off",
                "page": "live_status",
                "update_hz": 1,
                "contrast": 128,
                "rotation": 0,
                "detected": bool(profile.get("supports_oled")),
                "enabled": False,
                "addr": "0x3C" if profile.get("supports_oled") else "",
                "last_error": "",
                "supported": bool(profile.get("supports_oled")),
            },
        }
        if profile.get("supports_external_led"):
            indicators["external_led"].update({
                "count": int(profile.get("external_led_count", 3)),
                "pin": int(profile.get("external_led_pin", 12)),
                "initialized": True,
                "active_preset": "off",
            })
        else:
            indicators["external_led"]["initialized"] = False
        power = {
            "state": "normal",
            "wake_source": "command" if profile.get("power_ux") == "remote_only" else "timer",
            "soft_off_reason": "",
            "charger_present": False,
            "charge_state": "not_charging",
        }
        return {
            "device_uid": device_uid,
            "device_name": device_uid,
            "mode": mode,
            "protocol": "NHO/Arduino/1",
            "firmware_version": MOCK_FIRMWARE_VERSION,
            "hardware_model": str(profile["hardware_model"]),
            "system": {
                "name": device_uid,
                "hardware_model": str(profile["hardware_model"]),
                "mode": mode,
                "firmware_version": MOCK_FIRMWARE_VERSION,
                "protocol": "NHO/Arduino/1",
            },
            "matrix_shape": shape,
            "calibration": self._mock_calibration_status(device_uid, shape, mode),
            "logging": {
                "enabled": True,
                "capacity": "standard",
                "serial": "status",
                "level": "error",
                "mode": "standard",
                "max_bytes": 12288,
                "effective_total_bytes": 24576,
                "bytes": 0,
                "path": "/logs/device.log",
            },
            "services": self._mock_services(mode=mode),
            "memory": {
                "heap_free": 154624,
                "heap_allocated": 57344,
                "heap_total": 211968,
                "heap_used_percent": 27,
            },
            "battery": {
                "charger": "integrated",
                "state": "not_charging",
                "detail": "not_charging",
                "detected": True,
                "configured": True,
                "profile": "balanced",
                "charge_current_ma": 250,
                "input_limit_ma": 500,
                "vbat_reg_mv": 4200,
                "termination_percent": 10,
                "precharge_percent": 20,
                "safety_timer_hours": 6,
                "stat0": 0,
                "last_error": "",
                "config_error": "",
            },
            "runtime": {
                "mode": mode,
                "transport": {
                    "mode": "udp",
                },
                "server": {
                    "host": "127.0.0.1",
                    "udp_port": 13250,
                    "gateway_id": "newhorizons-standalone",
                    "source": "findme",
                },
                "findme": {
                    "state": "attached",
                    "host": "127.0.0.1",
                    "udp_port": 13250,
                    "gateway_id": "newhorizons-standalone",
                    "gateway_name": "NHOS Gateway",
                    "source": "findme",
                    "last_success_ms": 0,
                    "last_error": "",
                },
                "scan_timing": {"target_fps": 60, "settle_us": 20, "send_every_n_frames": 1},
                "stream_buffer": {"enabled": True, "mode": "standard", "depth_frames": 3},
                "logging": {
                    "enabled": True,
                    "capacity": "standard",
                    "serial": "status",
                    "level": "error",
                    "mode": "standard",
                    "max_bytes": 12288,
                    "effective_total_bytes": 24576,
                    "bytes": 0,
                    "path": "/logs/device.log",
                },
                "imu": {
                    "enabled": True,
                    "runtime_enabled": True,
                    "state": "ready",
                    "last_error": "",
                    "heap_before": 0,
                    "heap_after": 0,
                    "sample_rate_hz": 60,
                },
                "indicators": indicators,
            },
            "imu": {
                "enabled": True,
                "runtime_enabled": True,
                "state": "ready",
                "last_error": "",
                "heap_before": 0,
                "heap_after": 0,
                "sample_rate_hz": 60,
            },
            "wifi": {
                "ssid": "Lab-Mock",
                "password_set": True,
            },
            "findme": {
                "state": "attached",
                "host": "127.0.0.1",
                "udp_port": 13250,
                "gateway_id": "newhorizons-standalone",
                "gateway_name": "NHOS Gateway",
                "source": "findme",
                "last_success_ms": 0,
                "last_error": "",
            },
            "update": {
                "source": "github",
                "manifest_url": "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v10f-latest.json",
            },
            # Shaped like firmware v1.14.0+, which follows an update channel.
            "ota": {
                "auto_apply_on_boot": True,
                "channel": "stable",
                "manifest_url": "",
                "resolved_manifest_url": "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v10f-latest.json",
            },
            "update_state": {
                "phase": "idle",
                "operation": "",
                "total_files": 0,
                "applied_files": 0,
                "current_file": "",
                "last_error": "",
                "last_result": "",
                "reboot_required": False,
            },
            "stream_buffer": {"enabled": True, "mode": "standard", "depth_frames": 3},
            "power": power,
            "indicators": indicators,
            "scan_health": {
                "requested_target_fps": 60,
                "settle_us": 20,
                "send_every_n_frames": 1,
                "queue_enabled": True,
                "queue_depth_frames": 3,
                "queue_capacity_frames": 3,
                "queue_occupied_frames": 0,
                "queue_dropped_frames": 0,
                "queue_max_occupied_frames": 0,
            },
        }

    def _mock_scope_root(self, device_uid: str, scope: str) -> Path:
        root = self._data_root / device_uid
        if scope == "logs":
            return root / "logs"
        if scope == "calibration":
            return root / "calibration"
        return root / "files"

    def _mock_proc_text(self, device_uid: str, path: str) -> str:
        """Synthesise the firmware's /proc views so `--scope proc` is demoable."""
        if path == "apps":
            apps = self._mock_apps.setdefault(device_uid, self._mock_default_apps())
            lines = ["NAME       STATE      BUDGET_US  LAST_US  MAX_US  OVERRUNS"]
            for app in apps:
                lines.append("{:<10} {:<10} {:>9}  {:>7}  {:>6}  {:>8}".format(
                    app["name"], app["state"], app["budget_us"],
                    app["last_us"], app["max_us"], app["overruns"]))
            lines.append("")
            lines.append("EVENTS")
            lines.append("[6 @18700 f18718] flow heel_strike fall")
            return "\n".join(lines) + "\n"
        if path == "tasks":
            return ("NAME          INVOCATIONS  LAST_US  MAX_US  CPU_PERMILLE\n"
                    "scan_stream         18422     4210    6100           412\n"
                    "control              1841       90     220             6\n")
        if path == "services":
            return "NAME       STATE\nwifi       running\ncontrol    running\n"
        return ""

    def _mock_files_for_device(self, device_uid: str, scope: str = "user") -> list[dict[str, Any]]:
        if scope == "proc":
            return [
                {"scope": scope, "path": name, "name": name,
                 "size": len(self._mock_proc_text(device_uid, name))}
                for name in ("apps", "tasks", "services")
            ]
        root = self._mock_scope_root(device_uid, scope)
        if not root.exists():
            if scope == "logs":
                return [{"scope": scope, "path": "device.log", "name": "device.log", "size": 256}]
            if scope == "calibration":
                return [{"scope": scope, "path": "level.json", "name": "level.json", "size": 64}]
            return [{"scope": scope, "path": "sample.csv", "name": "sample.csv", "size": 128}]
        return [
            {
                "scope": scope,
                "path": path.relative_to(root).as_posix(),
                "name": path.name,
                "size": path.stat().st_size,
            }
            for path in sorted(root.rglob("*"))
            if path.is_file()
        ]

    @staticmethod
    def _mock_app_view(apps: list[dict[str, Any]]) -> dict[str, Any]:
        """A moving app_view, shaped like ControlServer::appViewJson().

        Only the "flow" slot draws, and only while it runs, so disabling it in
        the mock empties the preview the way it would on hardware.
        """
        running = any(a["name"] == "flow" and a["state"] == "running" for a in apps)
        if not running:
            return {
                "oled": {"hw": True, "page": "live_status", "on_screen": False, "rows": [None] * 4},
                "status_led": {"rgb": [0, 80, 0], "signal": "online", "owner": "system"},
                "ext_led": {"count": 3, "owner": "system_status"},
            }
        phase = (time.time() % 4.0) / 4.0
        load = round(abs(phase * 2 - 1) * 100, 1)
        strike = phase < 0.25
        value = f"{load:.1f}"
        label = "LOAD"
        text = label + " " * (21 - len(label) - len(value)) + value
        return {
            "oled": {
                "hw": True, "page": "live_status", "on_screen": False,
                "rows": [
                    {"slot": "flow", "kind": "text", "label": label, "text": text},
                    {"slot": "flow", "kind": "bar", "label": "HEEL", "x0": 30, "width": 98,
                     "fill_px": int(load / 100 * 96), "contended": ["flow1"]},
                    None,
                    None,
                ],
            },
            "status_led": {
                "rgb": [255, 0, 0] if strike else [0, 80, 0],
                "signal": "online",
                "owner": "flow" if strike else "system",
                **({"app_request": {"slot": "flow", "rgb": [255, 0, 0], "suppressed": False}} if strike else {}),
            },
            "ext_led": {
                "count": 3, "owner": "app",
                "pixels": [[0, 160, 0] if load > 20 else [0, 0, 0],
                           [160, 160, 0] if load > 50 else [0, 0, 0],
                           [160, 0, 0] if load > 80 else [0, 0, 0]],
            },
        }

    @staticmethod
    def _mock_default_apps() -> list[dict[str, Any]]:
        """The four flow slots a v1.1.0 device compiles in.

        Slots are hosts, not content: a slot exists whether or not a package is
        bound to it. Shapes match AppManager::statusJson() so UI written against
        the mock works unchanged against hardware.
        """
        def slot(name: str, state: str, **overrides: Any) -> dict[str, Any]:
            entry = {
                "name": name, "version": "1.0.0", "state": state,
                "capabilities": 5, "budget_us": 2000, "invocations": 18422,
                "last_us": 0, "max_us": 0, "overruns": 0, "events": 0,
                "state_detail": {
                    "graph": "", "package": "", "source": "", "nodes": 0,
                    "estimated_us": 0, "budget_us": 2000, "emissions": 0,
                    "frames": 0, "degraded": False, "degradations": 0, "outputs": [],
                },
            }
            entry.update(overrides)
            return entry

        return [
            slot("flow", "running", last_us=900, max_us=1180, events=6, state_detail={
                "graph": "heel_strike", "package": "heel_strike",
                "source": "apps/heel_strike.nha", "nodes": 4, "estimated_us": 15,
                "budget_us": 2000, "emissions": 6, "frames": 18422,
                "degraded": False, "degradations": 0,
                "outputs": [{"op": "region_sum", "result": 41.7, "bool": False}],
            }),
            slot("flow1", "installed"),
            slot("flow2", "installed"),
            slot("flow3", "installed"),
        ]

    @staticmethod
    def _mock_default_packages() -> list[dict[str, Any]]:
        return [{
            "id": "heel_strike", "name": "Heel Strike", "version": "1.0.0",
            "author": "wenzi7777", "summary": "Emits heel_strike on the rear half of the mat.",
            "category": "biomechanics", "min_os": "v1.0.0", "sha256": "0" * 64,
            "capabilities": 5, "size": 492, "estimated_us": 15, "slot": 0,
            "state": "active",
        }]

    def _mock_calibration_state(self, device_uid: str) -> dict[str, Any]:
        return self._mock_calibration.setdefault(device_uid, {
            "enabled": False,
            "tare_enabled": False,
            "session": False,
            "tare": False,
            "draft_tare": False,
            "levels": {},
            "draft_levels": {},
        })

    def _mock_calibration_status(self, device_uid: str, shape: dict[str, Any] | None, mode: str) -> dict[str, Any]:
        """The firmware's Calibration::statusJson, for mock devices."""
        state = self._mock_calibration_state(device_uid)
        shape = shape or {"rows": 4, "cols": 4}
        total = max(0, int(shape.get("rows") or 0) * int(shape.get("cols") or 0))

        def tare_summary(captured: bool, source: str) -> dict[str, Any]:
            points = total if captured else 0
            return {"captured_points": points, "total_points": total, "missing_points": total - points,
                    "complete": captured and total > 0, "source": source}

        # Levels map nominal kPa -> the set of sensor indexes captured at it.
        def level_summaries(levels: dict[float, set[int]], source: str) -> list[dict[str, Any]]:
            return [
                {"level": level, "reference": level, "captured_points": len(cells), "total_points": total,
                 "missing_points": max(0, total - len(cells)), "complete": len(cells) >= total > 0, "source": source}
                for level, cells in sorted(levels.items())
            ]

        # Like Calibration::fitAll: a sensor fits with 3+ levels from 3 kPa up.
        def fit_summary(levels: dict[float, set[int]], tare: bool) -> dict[str, Any]:
            fitted = 0
            failed = []
            for index in range(total):
                points = sum(1 for level, cells in levels.items() if level >= 3 and index in cells)
                if tare and points >= 3:
                    fitted += 1
                elif len(failed) < 16:
                    failed.append({"sensor_index": index, "reason": "too_few_points" if tare else "no_tare"})
            missing = total - fitted
            return {"cells_total": total, "cells_fitted": fitted, "complete": total > 0 and fitted == total,
                    "failures": {"no_tare": 0 if tare else missing, "too_few_points": missing if tare else 0,
                                 "singular": 0},
                    "failed": failed}

        tare_complete = bool(state["tare"])
        fit = fit_summary(state["levels"], tare_complete)
        complete = tare_complete and fit["complete"]
        enabled = bool(state["enabled"]) and complete
        if enabled:
            output_mode = "calibrated"
        elif state["tare_enabled"] and tare_complete:
            output_mode = "tared"
        else:
            output_mode = "raw"
        return {
            "enabled": enabled,
            "mode_active": mode != "normal",
            "session_active": bool(state["session"]),
            "complete": complete,
            "tare_complete": tare_complete,
            "tare_enabled": bool(state["tare_enabled"]),
            "output_mode": output_mode,
            "tare": tare_summary(tare_complete, "saved"),
            "draft_tare": tare_summary(bool(state["session"] and state["draft_tare"]), "draft"),
            "levels": level_summaries(state["levels"], "saved"),
            "draft_levels": level_summaries(state["draft_levels"] if state["session"] else {}, "draft"),
            "fit": fit,
            "draft_fit": fit_summary(state["draft_levels"], bool(state["draft_tare"])) if state["session"] else None,
            "fit_settings": {"min_points": 3, "min_level": 3,
                             "readout": [{"adc": 1, "c1": 1, "c2": 0, "clip_mv": 3150},
                                         {"adc": 2, "c1": 1, "c2": 0, "clip_mv": 3100}]},
            "metadata": {
                "rows": int(shape.get("rows") or 0), "cols": int(shape.get("cols") or 0), "point_count": total,
                "max_level": max(state["levels"], default=0), "tare_complete": tare_complete,
            },
        }

    def _mock_calibration_command(
        self, device_uid: str, status: dict[str, Any], command: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """A small stand-in for the firmware's calibration state machine.

        Mirrors the v1.5.1 rules the Desktop relies on: begin is idempotent,
        level captures need the draft baseline first, and the one-tap zero
        works outside maintenance but not during a session.
        """
        state = self._mock_calibration_state(device_uid)
        shape = status.get("matrix_shape") if isinstance(status.get("matrix_shape"), dict) else None
        mode = str(status.get("mode") or "normal")
        total = max(0, int((shape or {}).get("rows") or 4) * int((shape or {}).get("cols") or 4))

        def ok(message: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
            return {"status": "ok", "ok": True, "message": message,
                    "data": data if data is not None else self._mock_calibration_status(device_uid, shape, mode)}

        def fail(error: str) -> dict[str, Any]:
            return {"status": "error", "ok": False, "message": error, "error": error, "data": {}}

        level = round(float(payload.get("level") or 0), 3)
        if command == "calibration_status":
            return ok("calibration_status")
        if command == "calibration_session_begin":
            if state["session"]:
                return ok("calibration_session_already_active")
            state.update(session=True, draft_tare=state["tare"],
                         draft_levels={level: set(cells) for level, cells in state["levels"].items()})
            return ok("calibration_session_started")
        if command == "calibration_session_abort":
            state.update(session=False, draft_tare=False, draft_levels={})
            return ok("calibration_session_aborted")
        if command == "calibration_capture_tare":
            if not state["session"]:
                return fail("calibration_capture_failed")
            state["draft_tare"] = True
            return ok("calibration_tare_captured", {"total_points": total, "session_active": True})
        if command in ("calibration_capture_cell", "calibration_capture_all"):
            if not state["session"] or not state["draft_tare"]:
                return fail("calibration_tare_required" if state["session"] else "calibration_capture_failed")
            cells = state["draft_levels"].setdefault(level, set())
            if command == "calibration_capture_all":
                cells.update(range(total))
            else:
                cells.add(int(payload.get("sensor_index") or 0))
            message = "calibration_all_captured" if command == "calibration_capture_all" else "calibration_cell_captured"
            return ok(message, {"level": level, "total_points": total, "session_active": True})
        if command == "calibration_session_commit":
            if not state["session"]:
                return fail("calibration_session_required")
            draft = self._mock_calibration_status(device_uid, shape, mode)["draft_fit"] or {}
            fits_ok = bool(draft.get("complete"))
            if payload.get("auto_enable") and not (state["draft_tare"] and fits_ok):
                return fail("calibration_incomplete")
            state.update(tare=state["draft_tare"], levels=state["draft_levels"], session=False,
                         draft_tare=False, draft_levels={})
            state["enabled"] = bool(payload.get("auto_enable")) and state["tare"] and fits_ok
            return ok("calibration_committed")
        if command == "calibration_tare_capture":
            if state["session"]:
                return fail("calibration_session_active")
            state.update(tare=True, tare_enabled=True)
            return ok("calibration_tare_captured")
        if command == "calibration_tare_clear":
            if state["session"]:
                return fail("calibration_session_active")
            state["tare_enabled"] = False
            return ok("calibration_tare_cleared")
        if command in ("calibration_enable", "calibration_disable"):
            if command == "calibration_enable" and not self._mock_calibration_status(device_uid, shape, mode)["complete"]:
                return fail("calibration_incomplete")
            state["enabled"] = command == "calibration_enable"
            return ok("calibration_enabled" if state["enabled"] else "calibration_disabled")
        if command == "calibration_clear_profile":
            state.update(enabled=False, tare_enabled=False, session=False, tare=False, draft_tare=False,
                         levels={}, draft_levels={})
            return ok("calibration_profile_cleared")
        if command == "calibration_delete_level":
            target = state["draft_levels"] if state["session"] else state["levels"]
            if level not in target:
                return fail("calibration_level_delete_failed")
            del target[level]
            return ok("calibration_level_deleted")
        if command in ("calibration_dump_tare", "calibration_dump_level"):
            return fail("calibration_tare_not_found" if command == "calibration_dump_tare" else "calibration_level_not_found")
        return fail("unknown_command")

    def _mock_app_command(self, device_uid: str, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        apps = self._mock_apps.setdefault(device_uid, self._mock_default_apps())
        packages = self._mock_packages.setdefault(device_uid, self._mock_default_packages())

        def app_status() -> dict[str, Any]:
            return {
                "dispatches": 18422, "count": len(apps), "budget_us": 2000 * len(apps),
                "last_total_us": 900, "max_total_us": 1180,
                "event_seq": 6, "events_dropped": 0, "apps": apps,
            }

        def registry_status() -> dict[str, Any]:
            return {
                "count": len(packages), "capacity": 8, "slots": 4,
                "used_us": sum(int(p.get("estimated_us") or 0) for p in packages),
                "index_writes": 1, "recovered_from_tmp": False, "rebuilt": False,
                "packages": packages,
            }

        def find_package(app_id: str) -> dict[str, Any] | None:
            return next((p for p in packages if p["id"] == app_id), None)

        if command == "app_list":
            return {"message": "app_list", "data": app_status()}

        if command == "app_list_packages":
            return {"message": "app_list_packages", "data": registry_status()}

        if command == "app_events":
            since = int(payload.get("since_seq") or 0)
            events = [
                {"seq": 5, "ms": 18400, "frame_seq": 18400, "app": "flow",
                 "event": "heel_strike", "detail": "rise"},
                {"seq": 6, "ms": 18700, "frame_seq": 18718, "app": "flow",
                 "event": "heel_strike", "detail": "fall"},
            ]
            return {"message": "app_events",
                    "data": {"seq": 6, "dropped": 0,
                             "events": [e for e in events if e["seq"] > since]}}

        if command == "app_view":
            return {"message": "app_view", "data": self._mock_app_view(apps)}

        if command in ("app_enable", "app_disable", "app_revive"):
            name = str(payload.get("name") or "")
            if not name:
                return {"ok": False, "status": "error", "error": "name_required"}
            app = next((a for a in apps if a["name"] == name), None)
            if app is None:
                return {"ok": False, "status": "error",
                        "error": "app_revive_failed" if command == "app_revive"
                        else "app_state_change_rejected"}
            if command == "app_revive":
                if app["state"] != "killed":
                    return {"ok": False, "status": "error", "error": "app_revive_failed"}
                app["state"] = "running"
                app["overruns"] = 0
                return {"message": "app_revived", "data": app_status()}
            # setEnabled() refuses to silently un-kill an app that blew its budget.
            if app["state"] == "killed":
                return {"ok": False, "status": "error", "error": "app_state_change_rejected"}
            app["state"] = "running" if command == "app_enable" else "installed"
            return {"message": "app_enabled" if command == "app_enable" else "app_disabled",
                    "data": app_status()}

        if command == "app_install":
            path = str(payload.get("path") or "")
            if not path:
                return {"ok": False, "status": "error", "error": "path_required"}
            target = self._mock_resolve_scope_path(device_uid, "user", path)
            if target is None or not target.exists():
                return {"ok": False, "status": "error", "error": "package_not_found"}
            try:
                doc = json.loads(target.read_text(encoding="utf-8"))
                manifest = doc["manifest"]
                app_id = str(manifest["id"])
            except Exception:
                return {"ok": False, "status": "error", "error": "not_a_package"}
            if path != "apps/{}.nha".format(app_id):
                return {"ok": False, "status": "error",
                        "error": "id_path_mismatch:{}".format(app_id)}
            existing = find_package(app_id)
            if existing is not None and not payload.get("replace"):
                return {"ok": False, "status": "error",
                        "error": "already_installed:{}".format(app_id)}
            if existing is None and len(packages) >= 8:
                return {"ok": False, "status": "error", "error": "registry_full"}
            entry = existing or {"slot": -1}
            entry.update({
                "id": app_id, "name": manifest.get("name", app_id),
                "version": manifest.get("version", "0.0.0"),
                "author": manifest.get("author", ""), "summary": manifest.get("summary", ""),
                "category": manifest.get("category", "other"),
                "min_os": manifest.get("min_os", "v1.0.0"),
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "capabilities": 5, "size": target.stat().st_size,
                "estimated_us": 15 * max(1, len(doc.get("nodes") or [])) // 4,
                "state": "active" if entry.get("slot", -1) >= 0 else "installed",
            })
            if existing is None:
                packages.append(entry)
            return {"message": "app_installed",
                    "data": {"id": app_id, "registry": registry_status()}}

        if command == "app_uninstall":
            app_id = str(payload.get("id") or "")
            entry = find_package(app_id)
            if entry is None:
                return {"ok": False, "status": "error",
                        "error": "unknown_package:{}".format(app_id)}
            if entry.get("slot", -1) >= 0:
                apps[entry["slot"]]["state_detail"]["package"] = ""
            packages.remove(entry)
            if not payload.get("keep_file"):
                self._mock_file_delete(device_uid, {"scope": "user",
                                                    "path": "apps/{}.nha".format(app_id)})
            return {"message": "app_uninstalled", "data": registry_status()}

        if command in ("app_activate", "app_deactivate"):
            app_id = str(payload.get("id") or "")
            entry = find_package(app_id) if app_id else None
            if command == "app_activate":
                if entry is None:
                    return {"ok": False, "status": "error",
                            "error": "unknown_package:{}".format(app_id)}
                if entry.get("slot", -1) >= 0:
                    return {"ok": False, "status": "error",
                            "error": "already_active:{}".format(entry["slot"])}
                taken = {p["slot"] for p in packages if p.get("slot", -1) >= 0}
                slot = int(payload.get("slot", -1))
                if slot < 0:
                    slot = next((i for i in range(4) if i not in taken), -1)
                if slot < 0:
                    return {"ok": False, "status": "error", "error": "no_free_slot"}
                if slot >= 4:
                    return {"ok": False, "status": "error",
                            "error": "slot_out_of_range:{}".format(slot)}
                if slot in taken:
                    return {"ok": False, "status": "error", "error": "slot_occupied"}
                entry["slot"] = slot
                entry["state"] = "active"
                apps[slot]["state_detail"]["package"] = app_id
                return {"message": "app_activated", "data": registry_status()}
            slot = int(payload.get("slot", -1))
            if entry is None:
                entry = next((p for p in packages if p.get("slot", -1) == slot), None)
            if entry is None:
                return {"ok": False, "status": "error",
                        "error": "slot_not_active:{}".format(slot)}
            apps[entry["slot"]]["state_detail"]["package"] = ""
            entry["slot"] = -1
            entry["state"] = "installed"
            return {"message": "app_deactivated", "data": registry_status()}

        if command == "app_verify":
            entry = find_package(str(payload.get("id") or ""))
            if entry is None:
                return {"ok": False, "status": "error", "error": "unknown_package"}
            return {"message": "app_verified",
                    "data": {"id": entry["id"], "sha256": entry["sha256"], "match": True}}

        if command == "app_reindex":
            return {"message": "app_reindexed",
                    "data": {"recovered": len(packages), "dropped": 0,
                             "registry": registry_status()}}

        slot0 = apps[0]
        if command == "app_load_flow":
            path = str(payload.get("path") or "apps/flow.json")
            if self._mock_resolve_scope_path(device_uid, "user", path) is None:
                return {"ok": False, "status": "error", "error": "flow_load_failed:file_not_found"}
            slot0["state_detail"] = dict(slot0["state_detail"], source=path,
                                         graph=Path(path).stem)
            return {"message": "flow_graph_loaded", "data": slot0["state_detail"]}

        # app_unload_flow
        slot0["state_detail"] = {"graph": "", "package": "", "source": "", "nodes": 0,
                                 "estimated_us": 0, "budget_us": 2000, "emissions": 0,
                                 "frames": 0, "degraded": False, "degradations": 0,
                                 "outputs": []}
        return {"message": "flow_graph_unloaded", "data": slot0["state_detail"]}

    def _mock_resolve_scope_path(self, device_uid: str, scope: str, raw_path: str) -> Path | None:
        """Resolve a device-relative path inside a mock scope, or None if it escapes."""
        if not raw_path or raw_path.startswith("/") or "\\" in raw_path or ".." in raw_path.split("/"):
            return None
        root = self._mock_scope_root(device_uid, scope).resolve()
        target = (root / raw_path).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return None
        return target

    def _mock_file_write(self, device_uid: str, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Mirror the firmware's three-step upload, actually storing the bytes.

        The device enforces sequential offsets and a final size match; reproducing
        that here is what makes the mock useful -- an upload that "succeeds" but
        leaves no file behind cannot be installed from, and hides real bugs.
        """
        scope = str(payload.get("scope") or "user")
        raw_path = str(payload.get("path") or "")
        key = (device_uid, scope, raw_path)
        if scope not in ("user", "logs", "calibration"):
            return {"ok": False, "status": "error", "error": "read_only_scope"}
        target = self._mock_resolve_scope_path(device_uid, scope, raw_path)
        if target is None:
            return {"ok": False, "status": "error", "error": "invalid_path"}
        # The firmware caps a user-scope path at 24 chars (SPIFFS 31 minus "/files/").
        if scope == "user" and len(raw_path) > 24:
            return {"ok": False, "status": "error", "error": "path_too_long"}

        if command == "file_write_begin":
            self._mock_write_sessions[key] = {"expected": int(payload.get("size") or 0), "buffer": bytearray()}
            return {"message": "file_write_started", "scope": scope, "path": raw_path,
                    "size": int(payload.get("size") or 0)}

        session = self._mock_write_sessions.get(key)
        if session is None:
            return {"ok": False, "status": "error", "error": "file_write_not_started"}

        if command == "file_write_chunk":
            offset = int(payload.get("offset") or 0)
            if offset != len(session["buffer"]):
                return {"ok": False, "status": "error", "error": "file_write_offset_mismatch"}
            try:
                chunk = bytes.fromhex(str(payload.get("data") or ""))
            except ValueError:
                return {"ok": False, "status": "error", "error": "invalid_hex_data"}
            session["buffer"].extend(chunk)
            return {"message": "file_write_chunk_written", "scope": scope, "path": raw_path,
                    "written": len(session["buffer"])}

        # file_write_finish
        self._mock_write_sessions.pop(key, None)
        if len(session["buffer"]) != session["expected"]:
            return {"ok": False, "status": "error", "error": "file_write_incomplete"}
        digest = hashlib.sha256(bytes(session["buffer"])).hexdigest()
        expected = str(payload.get("sha256") or "")
        if expected and expected.lower() != digest:
            # A corrupt file that looks complete is worse than none, because
            # whatever consumes it next will not know.
            return {"ok": False, "status": "error", "error": "file_checksum_mismatch"}
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(bytes(session["buffer"]))
        return {"message": "file_write_finished", "scope": scope, "path": raw_path,
                "size": len(session["buffer"]), "sha256": digest}

    def _mock_file_delete(self, device_uid: str, payload: dict[str, Any]) -> dict[str, Any]:
        scope = str(payload.get("scope") or "user")
        raw_path = str(payload.get("path") or "")
        target = self._mock_resolve_scope_path(device_uid, scope, raw_path)
        if target is None:
            return {"ok": False, "status": "error", "error": "invalid_path"}
        if not target.exists():
            return {"ok": False, "status": "error", "error": "file_delete_failed"}
        target.unlink()
        return {"message": "file_deleted", "scope": scope, "path": raw_path, "applied": True}

    def _mock_storage_usage(self, device_uid: str) -> dict[str, Any]:
        scopes: dict[str, int] = {}
        for scope in ("user", "logs", "calibration"):
            scopes[scope] = sum(int(item.get("size") or 0) for item in self._mock_files_for_device(device_uid, scope))
        total = 8 * 1024 * 1024
        known = sum(scopes.values())
        other = 2 * 1024 * 1024
        used = min(total, known + other)
        return {
            "total_bytes": total,
            "used_bytes": used,
            "free_bytes": max(0, total - used),
            "percent_used": int((used * 100) // total) if total else 0,
            "scopes": scopes,
            "categories": [
                {"scope": scope, "bytes": size}
                for scope, size in scopes.items()
                if size > 0
            ] + [{"scope": "other", "bytes": other}],
            "tmp_bytes": 0,
            "known_bytes": known,
            "other_bytes": other,
        }

    def _mock_read_file(self, device_uid: str, raw_path: str, scope: str = "user") -> str:
        if scope == "proc":
            return self._mock_proc_text(device_uid, raw_path.strip("/"))
        if not raw_path:
            files = self._mock_files_for_device(device_uid)
            raw_path = str(files[0]["path"]) if files else ""
        if not raw_path:
            return ""
        root = self._mock_scope_root(device_uid, scope).resolve()
        target = (root / raw_path).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return ""
        if not target.exists():
            return ""
        return target.read_text(encoding="utf-8")
