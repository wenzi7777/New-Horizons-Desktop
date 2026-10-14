"""Talking to a device directly, without a relay: sending a command over UDP
or TCP (port 22345), and turning the firmware's reply into the result
envelope the rest of the backend records -- flattening status sub-blocks,
merging matrix layout and scan timing replies, recognising an apply_update
that started even though the connection dropped.

A mixin of NewHorizonsService (service.py): it shares the service's lock and
state and has no __init__ of its own.
"""
from __future__ import annotations

from typing import Any
import json

from .arduino_protocol import CONTROL_PORT, send_control_command
from .service_constants import DEVICE_CONTROL_UNAVAILABLE


class ArduinoResponseMixin:
    def _send_udp_command(self, device_uid: str, payload: dict[str, Any], addr: tuple[str, int]) -> dict[str, Any]:
        if self._udp_ingest is None:
            raise RuntimeError("udp_control_not_started")
        request_id = str(payload.get("request_id") or "")
        packet = json.dumps(
            {
                "type": "command",
                "device_uid": device_uid,
                "request_id": request_id,
                "payload": payload,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        for _idx in range(3):
            self._udp_ingest.send_datagram(packet, addr)
        return {
            "status": "queued",
            "transport": "udp",
            "device_uid": device_uid,
            "payload": payload,
            "request_id": request_id,
            "peer": "{}:{}".format(addr[0], addr[1]),
        }

    def _send_arduino_command(
        self,
        host: str,
        payload: dict[str, Any],
        *,
        port: int = CONTROL_PORT,
        device_uid: str = "",
    ) -> dict[str, Any]:
        return send_control_command(host, payload, port=port, timeout=self._arduino_command_timeout(payload))

    @staticmethod
    def _arduino_command_timeout(payload: dict[str, Any]) -> float:
        # Calibration captures block the device for duration_ms before it
        # replies; a fixed 2 s socket timeout would read a successful 3 s
        # capture as a dropped connection.
        command = str(payload.get("command") or "")
        default_ms = 0
        if command in ("calibration_capture_tare", "calibration_capture_cell", "calibration_capture_all"):
            default_ms = 3000
        elif command == "calibration_tare_capture":
            default_ms = 1000
        try:
            duration_ms = float(payload.get("duration_ms", default_ms) or 0)
        except (TypeError, ValueError):
            duration_ms = default_ms
        if duration_ms <= 0:
            return 2.0
        return max(2.0, duration_ms / 1000.0 + 3.0)

    def _mark_arduino_disconnected(self, device_uid: str, error: str) -> None:
        self._record_status(
            device_uid,
            {
                "device_uid": device_uid,
                "protocol": "NHO/Arduino/1",
                "gateway_connected": False,
                "live_seen": False,
                "transport_path": "arduino_tcp",
                "findme": {
                    "state": "disconnected",
                    "last_error": error,
                },
            },
        )

    def _record_arduino_response(self, device_uid: str, request: dict[str, Any], response: dict[str, Any]) -> None:
        if not isinstance(response, dict):
            response = {"ok": False, "error": "invalid_arduino_response"}
        data = response.get("data") if isinstance(response.get("data"), dict) else {}
        command = str(response.get("cmd") or response.get("command") or request.get("command") or "")
        ok = bool(response.get("ok", response.get("status") == "ok"))
        payload: dict[str, Any] = {
            "device_uid": device_uid,
            "device_id": device_uid,
            "request_id": request.get("request_id", ""),
            "command": command,
            "status": "ok" if ok else "error",
            "message": response.get("message") or response.get("error") or command,
            "protocol": data.get("protocol") or response.get("protocol") or "NHO/Arduino/1",
            "transport_path": "arduino_tcp",
            "gateway_connected": True,
        }
        payload.update(data)
        if command == "memory_status":
            payload["memory"] = dict(data)
        elif command == "scan_health":
            payload["scan_health"] = dict(data)
        elif command == "storage_status":
            payload["storage"] = dict(data)
        elif command == "set_matrix_layout" and ok:
            self._merge_arduino_matrix_layout_payload(payload, request, data)
        elif command == "set_scan_timing" and ok:
            self._merge_arduino_scan_timing_payload(payload, request, data)
        elif command == "set_stream_buffer" and ok:
            stream_buffer_data = data.get("stream_buffer") if isinstance(data.get("stream_buffer"), dict) else {}
            payload["stream_buffer"] = dict(stream_buffer_data) if stream_buffer_data else {
                "enabled": bool(request.get("enabled", True)),
                "mode": str(request.get("mode") or "standard"),
                "depth_frames": 5 if str(request.get("mode") or "standard") == "extended" else (3 if bool(request.get("enabled", True)) else 0),
            }
            runtime_data = data.get("runtime") if isinstance(data.get("runtime"), dict) else {}
            if isinstance(runtime_data.get("stream_buffer"), dict):
                payload["runtime"] = dict(runtime_data)
        elif command == "set_imu" and ok:
            imu_data = data.get("imu") if isinstance(data.get("imu"), dict) else {}
            payload["imu"] = dict(imu_data) if imu_data else {
                "enabled": bool(request.get("enabled", True)),
            }
        elif command == "set_filter" and ok:
            filter_data = data.get("filter") if isinstance(data.get("filter"), dict) else {}
            payload["filter"] = dict(filter_data) if filter_data else {
                "enabled": bool(request.get("enabled", False)),
                "median": int(request.get("median", 3)),
                "alpha": float(request.get("alpha", 0.25)),
            }
        elif command == "set_log" and ok:
            logging_data = data.get("log_status") if isinstance(data.get("log_status"), dict) else {}
            if not logging_data:
                logging_data = data.get("logging") if isinstance(data.get("logging"), dict) else {}
            payload["logging"] = logging_data or {
                "enabled": bool(request.get("enabled", True)),
                "level": request.get("level", "error"),
                "mode": request.get("mode", "standard"),
                "max_bytes": int(request.get("max_bytes", 12288) or 12288),
                "effective_total_bytes": int(request.get("max_bytes", 12288) or 12288) * 2,
            }
        elif command == "set_ota_config" and ok:
            ota_data = data.get("ota") if isinstance(data.get("ota"), dict) else {}
            payload["ota"] = ota_data or {
                "auto_apply_on_boot": bool(request.get("auto_apply_on_boot", False)),
                "manifest_url": request.get("manifest_url", ""),
            }
        elif command == "enter_maintenance" and ok:
            runtime_data = data.get("runtime") if isinstance(data.get("runtime"), dict) else {}
            payload["mode"] = "maintenance"
            payload["scan_stopped"] = True
            payload["maintenance_reason"] = request.get("reason", "")
            payload["runtime"] = {**runtime_data, "mode": "maintenance"}
        elif command == "exit_maintenance" and ok:
            runtime_data = data.get("runtime") if isinstance(data.get("runtime"), dict) else {}
            payload["mode"] = "normal"
            payload["scan_stopped"] = False
            payload["maintenance_reason"] = ""
            payload["runtime"] = {**runtime_data, "mode": "normal"}
        elif command == "check_update" and ok:
            payload["update_state"] = {
                "phase": "ready" if payload.get("available") else ("error" if payload.get("error") else "current"),
                "operation": "check_update",
                "available": bool(payload.get("available", False)),
                "version": payload.get("version", ""),
                "url": payload.get("url", ""),
                "size": payload.get("size", 0),
                "sha256": payload.get("sha256", ""),
                "changelog_url": payload.get("changelog_url", ""),
                "last_error": payload.get("error", ""),
                "last_result": payload.get("message", "update_checked"),
                "manifest_url": request.get("manifest_url", ""),
            }
        elif command == "apply_update" and ok:
            state = data.get("update_state") if isinstance(data.get("update_state"), dict) else {}
            payload["update_state"] = state or {
                "phase": "downloading",
                "operation": "apply_update",
                "current_file": "firmware",
                "last_error": "",
                "last_result": "starting",
                "reboot_required": True,
            }
        elif command == "set_indicators" and ok:
            indicators_data = data.get("indicators") if isinstance(data.get("indicators"), dict) else {}
            payload["indicators"] = indicators_data or {
                key: request[key]
                for key in ("external_led", "oled")
                if isinstance(request.get(key), dict)
            }
        elif command == "set_action_button" and ok:
            action_button_data = data.get("action_button") if isinstance(data.get("action_button"), dict) else {}
            payload["action_button"] = action_button_data or {
                "short_press": request.get("short_press", "none"),
                "long_press": request.get("long_press", "soft_off"),
            }
        elif command in {"set_charge_profile", "set_battery_profile", "resync_battery_gauge", "battery_status"} and ok:
            battery_data = data.get("battery") if isinstance(data.get("battery"), dict) else {}
            if battery_data:
                payload["battery"] = battery_data
            if command == "battery_status":
                for key in ("battery_gauge", "power"):
                    if isinstance(data.get(key), dict):
                        payload[key] = data[key]
            elif not battery_data and command != "resync_battery_gauge":
                payload["battery"] = {
                    "charger": "integrated",
                    "configured": True,
                    "profile": request.get("profile", "compatible"),
                }
            if command == "set_battery_profile":
                payload.setdefault("battery", {})
                payload["battery"].update({
                    "capacity_mah": request.get("capacity_mah"),
                    "max_charge_current_ma": request.get("max_charge_current_ma"),
                    "profile_resolved": True,
                    "battery_profile_required": False,
                    "profile_source": "manual",
                })
        elif command == "power_set_state" and ok:
            power_data = data.get("power") if isinstance(data.get("power"), dict) else {}
            requested_state = str(request.get("state") or "soft_off_auto")
            fallback_state = "normal" if requested_state == "normal" else requested_state
            payload["power"] = power_data or {
                "state": fallback_state,
                "wake_source": "command",
                "soft_off_reason": "command",
                "charger_present": False,
                "charge_state": "not_charging",
            }
        status_like = command in self.STATUS_COMMANDS or command in {
            "set_matrix_layout",
            "set_scan_timing",
            "set_stream_buffer",
            "set_charge_profile",
            "set_battery_profile",
            "resync_battery_gauge",
            "battery_status",
            "power_set_state",
            "set_imu",
            "set_filter",
            "set_action_button",
            "set_indicators",
            "set_log",
            "set_ota_config",
            "enter_maintenance",
            "exit_maintenance",
            "check_update",
            "apply_update",
        } or command == "query"
        if status_like:
            with self._lock:
                existing = dict(self._devices.get(device_uid, {}))
            existing_status = existing.get("last_status") if isinstance(existing.get("last_status"), dict) else {}
            for key, value in existing_status.items():
                if key in {"request_id", "command", "status", "message", "received_at"}:
                    continue
                payload.setdefault(key, value)
            for key in ("device_name", "mode", "firmware_version", "hardware_model", "matrix_shape", "findme"):
                if payload.get(key) in (None, ""):
                    payload[key] = existing_status.get(key) or existing.get(key)
            existing_runtime = existing_status.get("runtime") if isinstance(existing_status.get("runtime"), dict) else existing.get("runtime")
            if "runtime" not in payload and isinstance(existing_runtime, dict):
                payload["runtime"] = existing_runtime
        if response.get("error"):
            payload["error"] = response.get("error")
        if status_like and ok:
            self._record_status(device_uid, payload)
        self._record_result(device_uid, payload)

    def _legacy_apply_update_started(self, device_uid: str, request: dict[str, Any], exc: Exception) -> bool:
        command = str(request.get("command") or "")
        if command != "apply_update":
            return False
        text = str(exc).strip().lower()
        if not isinstance(exc, TimeoutError) and "timed out" not in text and "timeout" not in text:
            return False
        self._record_arduino_response(
            device_uid,
            request,
            {
                "ok": True,
                "cmd": "apply_update",
                "message": "update_started",
                "data": {
                    "update_state": {
                        "phase": "downloading",
                        "operation": "apply_update",
                        "current_file": "firmware",
                        "last_error": "",
                        "last_result": "starting",
                        "reboot_required": True,
                    },
                },
                "error": "",
            },
        )
        return True

    @staticmethod
    def _int_list(value: Any) -> list[int]:
        if not isinstance(value, list):
            return []
        result: list[int] = []
        for item in value:
            try:
                result.append(int(item))
            except (TypeError, ValueError):
                continue
        return result

    @classmethod
    def _scan_health_from_flat_payload(cls, data: dict[str, Any]) -> dict[str, Any]:
        keys = {
            "scan_active",
            "requested_target_fps",
            "settle_us",
            "send_every_n_frames",
            "point_count",
            "produced_frames",
            "consumed_frames",
            "dropped_frames",
        }
        return {key: data[key] for key in keys if key in data}

    @classmethod
    def _merge_arduino_matrix_layout_payload(cls, payload: dict[str, Any], request: dict[str, Any], data: dict[str, Any]) -> None:
        layout = data.get("matrix_layout") if isinstance(data.get("matrix_layout"), dict) else {}
        rows = cls._int_list(layout.get("analog_pins") or layout.get("active_rows") or request.get("analog_pins"))
        cols = cls._int_list(layout.get("select_pins") or layout.get("active_cols") or request.get("select_pins"))
        if rows and cols:
            payload["matrix_shape"] = data.get("matrix_shape") if isinstance(data.get("matrix_shape"), dict) else {"rows": len(rows), "cols": len(cols)}
            payload["matrix_layout"] = {
                "analog_pins": rows,
                "select_pins": cols,
                "active_rows": rows,
                "active_cols": cols,
            }
        if not isinstance(payload.get("scan_health"), dict):
            scan_health = data.get("scan_health") if isinstance(data.get("scan_health"), dict) else cls._scan_health_from_flat_payload(data)
            if scan_health:
                payload["scan_health"] = scan_health

    @classmethod
    def _merge_arduino_scan_timing_payload(cls, payload: dict[str, Any], request: dict[str, Any], data: dict[str, Any]) -> None:
        runtime = dict(payload.get("runtime") or {})
        scan_timing = dict(runtime.get("scan_timing") or {})
        incoming_runtime = data.get("runtime") if isinstance(data.get("runtime"), dict) else {}
        incoming_timing = incoming_runtime.get("scan_timing") if isinstance(incoming_runtime.get("scan_timing"), dict) else {}
        scan_timing.update(incoming_timing)
        for key in ("target_fps", "settle_us", "send_every_n_frames"):
            if key in request and key not in scan_timing:
                try:
                    scan_timing[key] = int(request[key])
                except (TypeError, ValueError):
                    pass
        if scan_timing:
            runtime["scan_timing"] = scan_timing
            payload["runtime"] = runtime
        if not isinstance(payload.get("scan_health"), dict):
            scan_health = data.get("scan_health") if isinstance(data.get("scan_health"), dict) else cls._scan_health_from_flat_payload(data)
            if scan_health:
                payload["scan_health"] = scan_health

    @classmethod
    def _is_command_unavailable_error(cls, exc: RuntimeError) -> bool:
        return str(exc) in cls.COMMAND_UNAVAILABLE_ERRORS or str(exc) == DEVICE_CONTROL_UNAVAILABLE
