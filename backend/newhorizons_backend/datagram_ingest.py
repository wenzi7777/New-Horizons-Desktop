"""Datagrams arriving from devices with no relay in between (direct UDP
mode): sensor packets and heartbeats on the stream port, control replies,
and what a v5 packet says about the device's matrix.

A mixin of NewHorizonsService (service.py): it shares the service's lock and
state and has no __init__ of its own.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
import json
import time

from .arduino_protocol import CONTROL_PORT, is_arduino_heartbeat_packet, is_arduino_stream_packet, packet_device_uid
from .board_profile import board_profile_for_hardware_model, normalize_hardware_model
from .packet_parser import PacketParseError, parse_binary_packet
from .result_chunks import RESULT_CHUNK_TYPE


class DatagramIngestMixin:
    def _handle_udp_datagram(self, payload: bytes, addr: tuple[str, int]) -> None:
        if payload.lstrip().startswith(b"{"):
            self._handle_udp_control_datagram(payload, addr)
            return
        if is_arduino_heartbeat_packet(payload):
            device_uid = self._device_uid_from_payload(packet_device_uid(payload), {})
            if not device_uid:
                return
            now = datetime.now(timezone.utc).isoformat()
            with self._lock:
                # Only register a direct TCP session for real peer addresses.
                # When packets arrive via the gateway relay, addr is a sentinel
                # ("gateway", 0) and must not be used as a TCP control target.
                if addr[0] != "gateway":
                    self._arduino_control_sessions[device_uid] = (addr[0], CONTROL_PORT)
            self._record_status(
                device_uid,
                {
                    "device_uid": device_uid,
                    "device_id": device_uid,
                    "device_name": "NHOS-{}".format(device_uid),
                    "protocol": "NHO/Arduino/1",
                    "transport_path": "arduino_heartbeat",
                    "gateway_connected": True,
                    "last_heartbeat_at": now,
                    "findme": {
                        "state": "attached",
                        "host": addr[0],
                        "udp_port": self._udp_port,
                        "last_success_ms": now,
                        "last_error": "",
                    },
                    "received_at": now,
                },
            )
            return
        is_arduino = is_arduino_stream_packet(payload)
        try:
            parsed = parse_binary_packet(payload, sensor_count=self._v5_extension_sensor_count(payload))
        except PacketParseError:
            return
        device_uid = self._device_uid_from_payload(parsed.get("device_uid") or parsed.get("dn"), parsed)
        if not device_uid:
            return
        parsed["dn"] = device_uid
        parsed["device_uid"] = device_uid
        parsed["device_id"] = device_uid
        if is_arduino:
            self._record_arduino_stream_presence(device_uid, addr)
        self._record_parsed(device_uid, parsed, source="udp")

    def _record_arduino_stream_presence(self, device_uid: str, addr: tuple[str, int]) -> None:
        now = time.monotonic()
        should_emit_status = False
        with self._lock:
            if addr[0] != "gateway":
                self._arduino_control_sessions[device_uid] = (addr[0], CONTROL_PORT)
            last_status_at = float(self._arduino_stream_status_at.get(device_uid) or 0.0)
            if device_uid not in self._devices or now - last_status_at >= self.ARDUINO_STREAM_STATUS_INTERVAL_SEC:
                self._arduino_stream_status_at[device_uid] = now
                should_emit_status = True
        if not should_emit_status:
            return
        self._record_status(
            device_uid,
            {
                "device_uid": device_uid,
                "device_id": device_uid,
                "device_name": "NHOS-{}".format(device_uid),
                "protocol": "NHO/Arduino/1",
                "transport_path": "arduino_udp",
                "gateway_connected": True,
            },
        )

    def _handle_udp_control_datagram(self, payload: bytes, addr: tuple[str, int]) -> None:
        try:
            frame = json.loads(payload.decode("utf-8"))
        except Exception:
            return
        if not isinstance(frame, dict):
            return
        if str(frame.get("type") or "") == RESULT_CHUNK_TYPE:
            # A reply over ~1.2 KB arrives split across datagrams
            # (ControlServer::sendUdpResult); nothing to do until it is whole.
            assembled = self._result_chunks.add(frame)
            if assembled is None:
                return
            frame = {"type": "result", **assembled}
        frame_payload = frame.get("payload") if isinstance(frame.get("payload"), dict) else {}
        device_uid = self._device_uid_from_payload(
            frame.get("device_uid") or frame_payload.get("device_uid") or frame_payload.get("device_id"),
            frame_payload,
        )
        if not device_uid:
            return
        with self._lock:
            self._udp_control_sessions[device_uid] = addr
        message_type = str(frame.get("type") or "")
        data = dict(frame_payload)
        data.setdefault("device_uid", device_uid)
        data.setdefault("received_at", datetime.now(timezone.utc).isoformat())
        data.setdefault("request_id", frame.get("request_id", ""))
        if message_type in ("hello", "status", "update_progress"):
            self._record_status(device_uid, data)
            return
        if message_type == "result":
            self._record_result(device_uid, data)

    @staticmethod
    def _matrix_shape_tuple(value: Any) -> tuple[int, int] | None:
        if not isinstance(value, dict):
            return None
        try:
            rows = int(value.get("rows") or 0)
            cols = int(value.get("cols") or 0)
        except Exception:
            return None
        if rows <= 0 or cols <= 0:
            return None
        return rows, cols

    @classmethod
    def _known_sensor_count_from_device(cls, device: dict[str, Any]) -> int | None:
        status = device.get("last_status") if isinstance(device.get("last_status"), dict) else {}
        for candidate in (status, device):
            layout = candidate.get("matrix_layout") if isinstance(candidate.get("matrix_layout"), dict) else {}
            rows = cls._int_list(layout.get("analog_pins") or layout.get("active_rows"))
            cols = cls._int_list(layout.get("select_pins") or layout.get("active_cols"))
            if rows and cols:
                return len(rows) * len(cols)
            shape = cls._matrix_shape_tuple(candidate.get("matrix_shape"))
            if shape is not None:
                return shape[0] * shape[1]

        hardware_model = str(status.get("hardware_model") or device.get("hardware_model") or "").strip()
        if not hardware_model:
            return None
        profile = board_profile_for_hardware_model(hardware_model)
        if normalize_hardware_model(profile.get("hardware_model")) != normalize_hardware_model(hardware_model):
            return None
        rows = cls._int_list(profile.get("default_analog_pins"))
        cols = cls._int_list(profile.get("default_select_pins"))
        return len(rows) * len(cols) if rows and cols else None

    def _v5_extension_sensor_count(self, payload: bytes) -> int | None:
        if len(payload) < 10 or payload[2] != 5 or not payload[3] & 0x20:
            return None
        device_uid = payload[4:10].hex().upper()
        with self._lock:
            device = dict(self._devices.get(device_uid) or {})
        return self._known_sensor_count_from_device(device)

    def _record_parsed(self, device_uid: str, payload: dict[str, Any], source: str) -> None:
        device_uid = self._device_uid_from_payload(device_uid, payload)
        if not device_uid:
            return
        payload = dict(payload)
        payload["dn"] = device_uid
        payload["device_uid"] = device_uid
        payload["device_id"] = device_uid
        with self._lock:
            should_record = device_uid in self._recording_enabled
        if should_record:
            try:
                self._write_csv_sample(device_uid, payload)
                # After the sample, so the frame clock already has this frame.
                if payload.get("app_events"):
                    self._capture_streamed_app_events(device_uid, payload["app_events"])
            except Exception as exc:
                error = str(exc)
                with self._lock:
                    self._recording_enabled.discard(device_uid)
                    self._csv_paths.pop(device_uid, None)
                    self._recording_errors[device_uid] = error
                    if device_uid in self._devices:
                        self._devices[device_uid]["recording_enabled"] = False
                        self._devices[device_uid]["recording_error"] = error
                self._emit_event({"type": "recording_update", "device_uid": device_uid, "enabled": False, "error": error})
        with self._lock:
            device_udp_fps = self._mark_visualization_received_locked(device_uid)
            payload["device_udp_fps"] = device_udp_fps
            payload["received_at_ms"] = int(time.monotonic() * 1000)
            purged_aliases = self._purge_short_aliases_locked(device_uid)
            self._latest_visualization[device_uid] = payload
            entry = self._normalize_device_entry(device_uid, payload, kind="parsed")
            entry["latest_sample"] = payload
            entry["visualization_source"] = source
            existing = self._devices.get(device_uid, {})
            merged = self._merge_device_entry(existing, entry)
            # Arduino v5 carries battery telemetry on the high-rate stream.
            # Keep a valid sample in last_status as well as visualization so
            # status-oriented Desktop surfaces (such as the launchpad card)
            # can show SoC without waiting for the next control status poll.
            if isinstance(payload.get("battery"), dict):
                latest_status = merged.get("last_status")
                latest_status = dict(latest_status) if isinstance(latest_status, dict) else {}
                existing_battery = latest_status.get("battery")
                latest_status["battery"] = (
                    self._merge_nested_status_dict(existing_battery, payload["battery"])
                    if isinstance(existing_battery, dict)
                    else dict(payload["battery"])
                )
                latest_status["device_uid"] = device_uid
                latest_status.setdefault("device_id", device_uid)
                latest_status["received_at"] = datetime.now(timezone.utc).isoformat()
                merged["last_status"] = latest_status
                self._latest_status[device_uid] = latest_status
            merged["recording_enabled"] = device_uid in self._recording_enabled
            if device_uid in self._recording_errors:
                merged["recording_error"] = self._recording_errors[device_uid]
            if merged.get("mode"):
                # This payload only carries received_at_ms (epoch ms), not
                # the ISO string the other two direct paths use -- stamp
                # with "now" directly instead.
                merged["last_direct_mode_at"] = datetime.now(timezone.utc).isoformat()
            self._devices[device_uid] = merged
            is_new_device = not bool(existing)
            event_item = self._decorate_device_entry(merged)
        self._emit_event({"type": "visualization_update", "device_uid": device_uid, "data": payload})
        if is_new_device:
            self._emit_event({"type": "device_update", "item": event_item})
        if purged_aliases:
            self._emit_event({"type": "device_snapshot", "items": self.list_devices()})
