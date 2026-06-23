from __future__ import annotations

import os
import csv
import json
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .arduino_protocol import CONTROL_PORT, is_arduino_heartbeat_packet, is_arduino_stream_packet, packet_device_uid, send_control_command
from .board_profile import GCU_HARDWARE_MODEL, V1_HARDWARE_MODEL, board_profile_for_hardware_model
from .packet_parser import PacketParseError, parse_binary_packet
from .discovery import DiscoveryResponder
from .udp_ingest import UDPIngestServer


DEVICE_CONTROL_UNAVAILABLE = "device_control_unavailable"
DEVICE_CONTROL_UNAVAILABLE_MESSAGE = "Device control is reconnecting; try again in a few seconds."
DEVICE_BOOTING = "device_booting"
DEVICE_BOOTING_MESSAGE = "Device is rebooting; control will resume when it comes back online."


def command_error_message(code: str) -> str:
    if code == DEVICE_BOOTING:
        return DEVICE_BOOTING_MESSAGE
    if code == DEVICE_CONTROL_UNAVAILABLE:
        return DEVICE_CONTROL_UNAVAILABLE_MESSAGE
    return code


class NewHorizonsService:
    COMMAND_TTL_MS = 15000
    BOOT_GRACE_SEC = 90.0
    ARDUINO_STREAM_STATUS_INTERVAL_SEC = 5.0
    # The gateway now debounces device liveness within ~16s (its control_stale_sec),
    # so the desktop no longer needs long windows on top of it. The findme grace only
    # rides out a single transient disconnected snapshot, and the watchdog is the
    # backstop that clears gateway_connected once last_live_seen_at goes stale.
    FINDME_DISCONNECT_GRACE_SEC = 5.0
    STALE_DEVICE_CHECK_INTERVAL_SEC = 5
    STALE_DEVICE_TIMEOUT_SEC = 12
    COMMAND_UNAVAILABLE_ERRORS = {
        "control_transport_not_started",
        "udp_control_not_started",
        "device_not_connected",
        "gateway_send_failed",
    }
    STATUS_COMMANDS = {"status", "query", "memory_status", "scan_health", "storage_status"}
    SHARED_COMMANDS = {
        "status",
        "query",
        "memory_status",
        "scan_health",
        "storage_status",
        "findme_discover",
        "findme_switch_gateway",
        "set_wifi",
        "log_tail",
        "log_clear",
        "file_list",
        "file_read_begin",
        "file_read_chunk",
        "set_log",
        "set_ota_config",
        "check_update",
        "apply_update",
        "reboot",
    }
    NORMAL_COMMANDS = SHARED_COMMANDS | {
        "enter_maintenance",
        "set_matrix_layout",
        "set_scan_timing",
        "set_stream_buffer",
        "set_charge_profile",
        "power_set_state",
        "set_indicators",
        "set_imu",
        "set_filter",
        "calibration_status",
        "calibration_enable",
        "calibration_disable",
        "calibration_dump_tare",
        "calibration_dump_level",
    }
    MAINTENANCE_COMMANDS = NORMAL_COMMANDS | {
        "exit_maintenance",
        "calibration_clear_profile",
        "calibration_delete_level",
        "calibration_session_begin",
        "calibration_session_abort",
        "calibration_session_commit",
        "calibration_capture_tare",
        "calibration_tare_capture",
        "calibration_capture_cell",
        "calibration_capture_all",
        "file_write_begin",
        "file_write_chunk",
        "file_write_finish",
        "file_delete",
    }
    MODE_COMMANDS = {
        "normal": NORMAL_COMMANDS,
        "maintenance": MAINTENANCE_COMMANDS,
        "safe_maintenance": MAINTENANCE_COMMANDS,
        "safemaintenance": MAINTENANCE_COMMANDS,
    }

    def __init__(self, autostart: bool = False, mock_mode: bool | None = None) -> None:
        self._lock = threading.RLock()
        self._mock_mode = mock_mode if mock_mode is not None else os.getenv("NEWHORIZONS_MOCK_MODE", "0") == "1"
        self._udp_host = os.getenv("NEWHORIZONS_UDP_HOST", "0.0.0.0")
        self._udp_port = int(os.getenv("NEWHORIZONS_UDP_PORT", "13250"))
        self._discovery_enabled = os.getenv("NEWHORIZONS_DISCOVERY_ENABLED", "1") not in {"0", "false", "False"}
        self._discovery_host = os.getenv("NEWHORIZONS_DISCOVERY_HOST", "0.0.0.0")
        self._discovery_port = int(os.getenv("NEWHORIZONS_DISCOVERY_PORT", "22346"))
        self._gateway_id = os.getenv("NEWHORIZONS_GATEWAY_ID", "newhorizons-standalone")
        self._discovery_priority = int(os.getenv("NEWHORIZONS_DISCOVERY_PRIORITY", "100"))
        self._transport_error = ""
        self._udp_ingest: UDPIngestServer | None = None
        self._discovery: DiscoveryResponder | None = None
        self._devices: dict[str, dict[str, Any]] = {}
        self._device_id_to_uid: dict[str, str] = {}
        self._latest_visualization: dict[str, dict[str, Any]] = {}
        self._visualization_rx_times: deque[float] = deque()
        self._visualization_rx_times_by_device: dict[str, deque[float]] = {}
        self._visualization_rx_frames = 0
        self._latest_status: dict[str, dict[str, Any]] = {}
        self._latest_result: dict[str, dict[str, Any]] = {}
        self._csv_paths: dict[str, Path] = {}
        self._recording_enabled: set[str] = set()
        self._recording_errors: dict[str, str] = {}
        self._pending_commands: dict[str, dict[str, dict[str, Any]]] = {}
        self._event_listeners: list[Callable[[dict[str, Any]], None]] = []
        self._ws_stats_provider: Callable[[], dict[str, Any]] | None = None
        self._gateway_senders: dict[str, Callable[[dict[str, Any]], None]] = {}
        self._gateway_session_senders: dict[str, Callable[[dict[str, Any]], None]] = {}
        self._gateway_device_ids: dict[str, str] = {}
        self._udp_control_sessions: dict[str, tuple[str, int]] = {}
        self._arduino_control_sessions: dict[str, tuple[str, int]] = {}
        self._arduino_stream_status_at: dict[str, float] = {}
        self._gateways: dict[str, dict[str, Any]] = {}
        self._gateway_claims: dict[str, dict[str, Any]] = {}
        self._boot_transitions: dict[str, dict[str, Any]] = {}
        self._stale_timer: threading.Timer | None = None
        self._stopped = True
        self._profiles_root = Path(os.getenv("NEWHORIZONS_PROFILES_DIR", ""))
        project_root = Path(__file__).resolve().parents[2]
        default_data_root = project_root / "mock_data" / "mqtt_store" if self._mock_mode else project_root / "data" / "mqtt_store"
        configured_data_root = os.getenv("NEWHORIZONS_DATA_ROOT")
        self._data_root = Path(configured_data_root) if configured_data_root else default_data_root
        self._nicknames_path = self._data_root / "_newhorizons_device_nicknames.json"
        self._device_groups_path = self._data_root / "_newhorizons_device_groups.json"
        self._nicknames = self._load_nicknames()
        self._device_groups = self._load_device_groups()
        if self._mock_mode:
            self._seed_mock_state()
        if autostart:
            self.start()

    @property
    def mock_mode(self) -> bool:
        return self._mock_mode

    def set_websocket_stats_provider(self, provider: Callable[[], dict[str, Any]] | None) -> None:
        with self._lock:
            self._ws_stats_provider = provider

    def start(self) -> None:
        with self._lock:
            if self._mock_mode:
                return
            if self._udp_ingest is not None:
                return
            try:
                self._udp_ingest = UDPIngestServer(self._udp_host, self._udp_port, on_datagram=self._handle_udp_datagram)
                self._udp_ingest.start()
                if self._discovery_enabled:
                    self._discovery = DiscoveryResponder(
                        self._discovery_host,
                        self._discovery_port,
                        gateway_id=self._gateway_id,
                        udp_port=lambda: self._udp_ingest.bound_port if self._udp_ingest else self._udp_port,
                        priority=self._discovery_priority,
                    )
                    self._discovery.start()
                self._transport_error = ""
                self._stopped = False
            except Exception as exc:
                if self._discovery is not None:
                    self._discovery.stop()
                if self._udp_ingest is not None:
                    self._udp_ingest.stop()
                self._discovery = None
                self._udp_ingest = None
                self._transport_error = str(exc)
        self._schedule_stale_check()

    def stop(self) -> None:
        with self._lock:
            self._stopped = True
            stale_timer = self._stale_timer
            self._stale_timer = None
            udp_ingest = self._udp_ingest
            discovery = self._discovery
            self._udp_ingest = None
            self._discovery = None
        if stale_timer is not None:
            stale_timer.cancel()
        if discovery is not None:
            discovery.stop()
        if udp_ingest is not None:
            udp_ingest.stop()

    def _schedule_stale_check(self) -> None:
        with self._lock:
            if self._stopped or self._stale_timer is not None:
                return
            timer = threading.Timer(self.STALE_DEVICE_CHECK_INTERVAL_SEC, self._check_stale_devices)
            timer.daemon = True
            self._stale_timer = timer
        timer.start()

    def _check_stale_devices(self) -> None:
        now = time.time()
        events: list[dict[str, Any]] = []
        with self._lock:
            # Clear our reference to the timer that just fired so _schedule_stale_check
            # can arm the next one; stop() may have flipped _stopped concurrently.
            self._stale_timer = None
            if self._stopped:
                return
            for uid in list(self._devices.keys()):
                entry = self._devices.get(uid)
                if entry is None:
                    continue
                if entry.get("gateway_connected") is not True:
                    continue
                # Use the time the device was *genuinely online* (last_live_seen_at),
                # not last_seen_at: the gateway keeps mentioning a disconnected
                # device in every snapshot (until its own 90s stale window), which
                # would refresh last_seen_at every ~5s and mean this watchdog could
                # never trip — a powered-off / soft-off device would stay online.
                live_at = str(entry.get("last_live_seen_at") or entry.get("received_at") or "")
                if not live_at:
                    continue
                parsed = self._parse_iso_datetime(live_at)
                if parsed is None:
                    continue
                if now - parsed.timestamp() <= self.STALE_DEVICE_TIMEOUT_SEC:
                    continue
                entry["gateway_connected"] = False
                # Keep the embedded gateway_state in sync so the frontend's
                # `gatewayState.connected === true` check (device.ts) does not
                # override the top-level flag we just cleared — otherwise a
                # gateway-relayed device would never appear offline.
                gateway_state = entry.get("gateway_state")
                if isinstance(gateway_state, dict):
                    gateway_state = dict(gateway_state)
                    gateway_state["connected"] = False
                    entry["gateway_state"] = gateway_state
                event_item = self._decorate_device_entry(entry)
                self._devices[uid] = entry
                events.append({"type": "device_update", "item": event_item})
        for event in events:
            self._emit_event(event)
        self._schedule_stale_check()

    def health(self) -> dict[str, Any]:
        with self._lock:
            return {
                "status": "ok",
                "transport_mode": "udp",
                "udp_started": bool(self._udp_ingest and self._udp_ingest.started),
                "discovery_started": bool(self._discovery and self._discovery.started),
                "transport_error": self._transport_error,
                "mock_mode": self._mock_mode,
                "server": {
                    "udp_host": self._udp_host,
                    "udp_port": self._udp_ingest.bound_port if self._udp_ingest else self._udp_port,
                    "discovery_host": self._discovery_host,
                    "discovery_port": self._discovery.bound_port if self._discovery else self._discovery_port,
                    "gateway_id": self._gateway_id,
                },
                "gateway_devices": len(self._gateway_senders),
                "gateways": len(self._gateways),
                "devices_seen": len(self._devices),
                "visualization": self.visualization_stats(),
                "websocket": self._websocket_stats_locked(),
            }

    def _websocket_stats_locked(self) -> dict[str, Any]:
        if self._ws_stats_provider is None:
            return {
                "clients": 0,
                "dropped_visualization": 0,
                "ws_coalesced_frames": 0,
                "ws_sent_frames": 0,
                "ws_sent_fps": 0,
            }
        try:
            return self._ws_stats_provider()
        except Exception as exc:
            return {"error": str(exc)}

    def list_devices(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self._decorate_device_entry(self._devices[key]) for key in sorted(self._devices.keys())]

    def get_device(self, device_uid: str) -> dict[str, Any] | None:
        device_uid = self._resolve_known_device_uid(device_uid)
        with self._lock:
            entry = self._devices.get(device_uid)
            return self._decorate_device_entry(entry) if entry is not None else None

    def latest_visualization(self, device_uid: str | None = None) -> list[dict[str, Any]]:
        device_uid = self._resolve_known_device_uid(device_uid) if device_uid else None
        with self._lock:
            if device_uid:
                item = self._latest_visualization.get(device_uid)
                return [item] if item is not None else []
            return [self._latest_visualization[key] for key in sorted(self._latest_visualization.keys())]

    def visualization_target_fps(self, device_uid: str | None) -> int:
        device_uid = self._resolve_known_device_uid(device_uid) if device_uid else ""
        with self._lock:
            candidates = [
                self._latest_status.get(device_uid, {}),
                self._latest_result.get(device_uid, {}),
                self._devices.get(device_uid, {}),
            ]
        for candidate in candidates:
            value = self._extract_target_fps(candidate)
            if value is not None:
                return value
        return 60

    def visualization_stats(self) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            self._purge_visualization_rx_window_locked(now)
            return {
                "udp_received_fps": len(self._visualization_rx_times),
                "udp_received_frames": self._visualization_rx_frames,
            }

    def _mark_visualization_received_locked(self, device_uid: str) -> int:
        now = time.monotonic()
        self._visualization_rx_frames += 1
        self._visualization_rx_times.append(now)
        device_window = self._visualization_rx_times_by_device.setdefault(device_uid, deque())
        device_window.append(now)
        self._purge_visualization_rx_window_locked(now)
        return len(self._visualization_rx_times_by_device.get(device_uid, ()))

    def _purge_visualization_rx_window_locked(self, now: float) -> None:
        cutoff = now - 1.0
        while self._visualization_rx_times and self._visualization_rx_times[0] < cutoff:
            self._visualization_rx_times.popleft()
        for device_uid in list(self._visualization_rx_times_by_device.keys()):
            window = self._visualization_rx_times_by_device[device_uid]
            while window and window[0] < cutoff:
                window.popleft()
            if not window:
                self._visualization_rx_times_by_device.pop(device_uid, None)

    @staticmethod
    def _extract_target_fps(payload: dict[str, Any]) -> int | None:
        paths = (
            ("runtime", "scan_timing", "target_fps"),
            ("scan_timing", "target_fps"),
            ("last_status", "runtime", "scan_timing", "target_fps"),
            ("last_result", "runtime", "scan_timing", "target_fps"),
        )
        for path in paths:
            value: Any = payload
            for key in path:
                if not isinstance(value, dict):
                    value = None
                    break
                value = value.get(key)
            try:
                fps = int(value)
            except Exception:
                continue
            if fps > 0:
                return fps
        return None

    def gateway_snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(self._gateways[key]) for key in sorted(self._gateways.keys())]

    def add_event_listener(self, listener: Callable[[dict[str, Any]], None]) -> None:
        with self._lock:
            if listener not in self._event_listeners:
                self._event_listeners.append(listener)

    def remove_event_listener(self, listener: Callable[[dict[str, Any]], None]) -> None:
        with self._lock:
            if listener in self._event_listeners:
                self._event_listeners.remove(listener)

    def set_recording_enabled(self, device_uid: str, enabled: bool) -> dict[str, Any]:
        device_uid = self._resolve_known_device_uid(device_uid)
        if not device_uid:
            raise ValueError("device_uid_required")
        with self._lock:
            if enabled:
                self._recording_enabled.add(device_uid)
                self._recording_errors.pop(device_uid, None)
            else:
                self._recording_enabled.discard(device_uid)
                self._csv_paths.pop(device_uid, None)
                self._recording_errors.pop(device_uid, None)
            if device_uid in self._devices:
                self._devices[device_uid]["recording_enabled"] = enabled
                self._devices[device_uid].pop("recording_error", None)
            result = {
                "device_uid": device_uid,
                "enabled": enabled,
            }
        self._emit_event({"type": "recording_update", **result})
        return result

    def recording_enabled(self, device_uid: str) -> bool:
        device_uid = self._resolve_known_device_uid(device_uid)
        with self._lock:
            return device_uid in self._recording_enabled

    @staticmethod
    def _normalize_uid(value: Any) -> str:
        raw = str(value or "").strip().upper()
        collapsed = raw.replace(":", "").replace("-", "").replace(" ", "")
        if collapsed and all(ch in "0123456789ABCDEF" for ch in collapsed):
            return collapsed
        return raw

    @classmethod
    def _is_full_hex_uid(cls, value: Any) -> bool:
        normalized = cls._normalize_uid(value)
        return len(normalized) == 12 and all(ch in "0123456789ABCDEF" for ch in normalized)

    def _resolve_known_device_uid(self, value: Any) -> str:
        normalized = self._normalize_uid(value)
        if not normalized:
            return ""
        with self._lock:
            mapped = self._device_id_to_uid.get(normalized)
            if mapped:
                return mapped
            if normalized in self._devices:
                return normalized
            if not self._is_full_hex_uid(normalized):
                matches = [
                    device_uid
                    for device_uid in self._devices
                    if self._is_full_hex_uid(device_uid) and device_uid.endswith(normalized)
                ]
                if len(matches) == 1:
                    return matches[0]
        return normalized

    def _device_uid_from_payload(self, fallback: Any, payload: dict[str, Any]) -> str:
        system = payload.get("system") if isinstance(payload.get("system"), dict) else {}
        candidates = (
            payload.get("device_uid"),
            payload.get("device_id"),
            payload.get("dn"),
            payload.get("id"),
            system.get("device_uid"),
            system.get("device_id"),
            system.get("id"),
            fallback,
        )
        for candidate in candidates:
            normalized = self._normalize_uid(candidate)
            if self._is_full_hex_uid(normalized):
                return normalized
        for candidate in candidates:
            normalized = self._normalize_uid(candidate)
            if normalized:
                return normalized
        return ""

    @staticmethod
    def _canonical_device_name(device_name: str, device_uid: str) -> str:
        if (
            device_name.startswith("New Horizons OS-")
            and len(device_uid) == 12
            and device_uid.endswith(device_name.rsplit("-", 1)[-1].strip().upper())
            and not device_name.endswith(device_uid)
        ):
            return "New Horizons OS-{}".format(device_uid)
        return device_name

    def _purge_short_aliases_locked(self, device_uid: str) -> bool:
        if not self._is_full_hex_uid(device_uid):
            return False
        aliases = [
            key
            for key in set(self._devices) | set(self._latest_status) | set(self._latest_result) | set(self._latest_visualization)
            if key != device_uid and key and len(key) < len(device_uid) and device_uid.endswith(str(key).upper())
        ]
        if not aliases:
            return False
        for alias in aliases:
            self._devices.pop(alias, None)
            self._latest_status.pop(alias, None)
            self._latest_result.pop(alias, None)
            self._latest_visualization.pop(alias, None)
            self._csv_paths.pop(alias, None)
            self._pending_commands.pop(alias, None)
            self._recording_errors.pop(alias, None)
            self._recording_enabled.discard(alias)
            self._device_id_to_uid[self._normalize_uid(alias)] = device_uid
        return True

    def _emit_event(self, event: dict[str, Any]) -> None:
        with self._lock:
            listeners = list(self._event_listeners)
        for listener in listeners:
            try:
                listener(dict(event))
            except Exception:
                continue

    def files_root(self) -> Path:
        return self._data_root

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

    def publish_command(self, device_uid: str, payload: dict[str, Any]) -> dict[str, Any]:
        device_uid = self._resolve_known_device_uid(device_uid)
        payload = self._with_command_expiry(payload)
        with self._lock:
            mode_error = self._boot_command_mode_error_locked(device_uid, payload)
        if mode_error:
            raise RuntimeError(mode_error)
        if self._mock_mode:
            return self._publish_mock_command(device_uid, payload)
        with self._lock:
            gateway_sender = self._gateway_senders.get(device_uid)
            udp_addr = self._udp_control_sessions.get(device_uid)
            arduino_addr = self._arduino_control_sessions.get(device_uid)
            if gateway_sender is None and udp_addr is None and arduino_addr is None:
                if self._active_boot_transition_locked(device_uid):
                    raise RuntimeError(DEVICE_BOOTING)
                raise RuntimeError(DEVICE_CONTROL_UNAVAILABLE)
            self._remember_pending_command(device_uid, payload)
            if arduino_addr is not None:
                try:
                    response = self._send_arduino_command(arduino_addr[0], payload, port=arduino_addr[1], device_uid=device_uid)
                except Exception as exc:
                    if self._legacy_apply_update_started(device_uid, payload, exc):
                        return {
                            "status": "queued",
                            "transport": "arduino_tcp",
                            "device_uid": device_uid,
                            "payload": payload,
                            "request_id": str(payload.get("request_id") or ""),
                            "peer": "{}:{}".format(arduino_addr[0], arduino_addr[1]),
                        }
                    self._arduino_control_sessions.pop(device_uid, None)
                    self._mark_arduino_disconnected(device_uid, "arduino_control_failed")
                    if gateway_sender is None and udp_addr is None:
                        self._forget_pending_command(device_uid, payload)
                        raise RuntimeError(DEVICE_CONTROL_UNAVAILABLE) from exc
                else:
                    self._record_arduino_response(device_uid, payload, response)
                    return {
                        "status": "queued",
                        "transport": "arduino_tcp",
                        "device_uid": device_uid,
                        "payload": payload,
                        "request_id": str(payload.get("request_id") or ""),
                        "peer": "{}:{}".format(arduino_addr[0], arduino_addr[1]),
                    }
            if gateway_sender is not None:
                request_id = str(payload.get("request_id") or "")
                message = {
                    "type": "command",
                    "device_uid": device_uid,
                    "request_id": request_id,
                    "payload": payload,
                }
                try:
                    gateway_sender(message)
                except Exception:
                    self._gateway_senders.pop(device_uid, None)
                    self._gateway_device_ids.pop(device_uid, None)
                    self._forget_pending_command(device_uid, payload)
                    raise RuntimeError(DEVICE_CONTROL_UNAVAILABLE)
                return {
                    "status": "queued",
                    "transport": "gateway_wss",
                    "device_uid": device_uid,
                    "payload": payload,
                    "request_id": request_id,
                }
            if udp_addr is not None:
                if self._udp_ingest is None:
                    self._forget_pending_command(device_uid, payload)
                    raise RuntimeError(DEVICE_CONTROL_UNAVAILABLE)
                try:
                    return self._send_udp_command(device_uid, payload, udp_addr)
                except Exception as exc:
                    self._udp_control_sessions.pop(device_uid, None)
                    self._forget_pending_command(device_uid, payload)
                    if isinstance(exc, RuntimeError) and self._is_command_unavailable_error(exc):
                        raise RuntimeError(DEVICE_CONTROL_UNAVAILABLE) from exc
                    raise RuntimeError(DEVICE_CONTROL_UNAVAILABLE) from exc
            self._forget_pending_command(device_uid, payload)
            raise RuntimeError(DEVICE_CONTROL_UNAVAILABLE)

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
        return send_control_command(host, payload, port=port)

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
        elif command == "set_charge_profile" and ok:
            battery_data = data.get("battery") if isinstance(data.get("battery"), dict) else {}
            payload["battery"] = battery_data or {
                "charger": "integrated",
                "configured": True,
                "profile": request.get("profile", "compatible"),
            }
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
            "power_set_state",
            "set_imu",
            "set_filter",
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

    def register_gateway(self, gateway_id: str, sender: Callable[[dict[str, Any]], None], payload: dict[str, Any] | None = None) -> str:
        gateway_id = str(gateway_id or "").strip() or "gateway-{}".format(id(sender))
        payload = dict(payload or {})
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._gateway_session_senders[gateway_id] = sender
            existing = dict(self._gateways.get(gateway_id, {}))
            existing.update({
                "gateway_id": gateway_id,
                "gateway_name": payload.get("gateway_name") or payload.get("name") or existing.get("gateway_name") or "New Horizons Gateway",
                "version": payload.get("version") or existing.get("version", ""),
                "enabled": bool(payload.get("enabled", existing.get("enabled", True))),
                "status": "online",
                "last_seen": now,
                "connected_at": payload.get("connected_at") or existing.get("connected_at") or now,
                "upstream_path": "gateway_wss",
                "target_mode": payload.get("target_mode", existing.get("target_mode", "")),
                "server_url": payload.get("server_url", existing.get("server_url", "")),
                "local_ports": payload.get("local_ports", existing.get("local_ports", {})),
                "upstream": payload.get("upstream", existing.get("upstream", {})),
                "serving_devices": sorted([uid for uid, gid in self._gateway_device_ids.items() if gid == gateway_id]),
                "serving_device_count": len([uid for uid, gid in self._gateway_device_ids.items() if gid == gateway_id]),
                "denied_devices": payload.get("denied_devices", existing.get("denied_devices", [])),
                "denied_count": len(payload.get("denied_devices", existing.get("denied_devices", [])) or []),
                "udp_forwarded": int(payload.get("udp_forwarded", existing.get("udp_forwarded", 0)) or 0),
                "udp_dropped": int(payload.get("udp_dropped", existing.get("udp_dropped", 0)) or 0),
                "last_error": payload.get("last_error", existing.get("last_error", "")),
                "claims": [dict(item) for item in self._gateway_claims.values() if item.get("gateway_id") == gateway_id],
            })
            self._gateways[gateway_id] = existing
            event_item = dict(existing)
        self._emit_event({"type": "gateway_update", "item": event_item})
        return gateway_id

    def record_gateway_summary(self, gateway_id: str, payload: dict[str, Any]) -> None:
        payload = dict(payload or {})
        now = datetime.now(timezone.utc).isoformat()
        state = payload.get("state") if isinstance(payload.get("state"), dict) else {}
        devices = state.get("devices") if isinstance(state.get("devices"), list) else []
        denied = state.get("denied_devices") if isinstance(state.get("denied_devices"), list) else []
        claims = state.get("claims") if isinstance(state.get("claims"), list) else []
        local_ports = {
            "udp": payload.get("listen_udp_port"),
            "findme": payload.get("listen_discovery_port"),
        }
        forwarded = 0
        dropped = 0
        for device in devices:
            if not isinstance(device, dict):
                continue
            forwarded += int(device.get("udp_forwarded", 0) or 0)
            dropped += int(device.get("udp_dropped", 0) or 0)
        claim_events: list[dict[str, Any]] = []
        device_events: list[dict[str, Any]] = []
        with self._lock:
            sender = self._gateway_session_senders.get(gateway_id)
            for device in devices:
                if not isinstance(device, dict):
                    continue
                device_uid = self._resolve_known_device_uid(device.get("device_uid") or device.get("uid") or "")
                if not device_uid:
                    continue
                connected = bool(device.get("connected")) or str(device.get("findme_state") or "").lower() == "attached"
                if connected and sender is not None:
                    self._gateway_senders[device_uid] = sender
                    self._gateway_device_ids[device_uid] = gateway_id
                elif not connected and self._gateway_device_ids.get(device_uid) == gateway_id:
                    self._gateway_senders.pop(device_uid, None)
                    self._gateway_device_ids.pop(device_uid, None)
                event_item = self._record_gateway_device_presence_locked(device_uid, gateway_id, device, connected, now, allow_disconnect_grace=True)
                if event_item is not None:
                    device_events.append(event_item)
            for item in claims:
                if not isinstance(item, dict):
                    continue
                claim_id = str(item.get("claim_id") or "").strip()
                if not claim_id:
                    continue
                claim = dict(item)
                claim["gateway_id"] = gateway_id
                previous = self._gateway_claims.get(claim_id, {})
                self._gateway_claims[claim_id] = claim
                if previous.get("state") != claim.get("state") or previous.get("last_error") != claim.get("last_error"):
                    claim_events.append({"type": "gateway_claim_update", **claim})
        self.register_gateway(
            gateway_id,
            self._gateway_session_senders.get(gateway_id, lambda _payload: None),
            {
                "gateway_name": payload.get("gateway_name"),
                "version": payload.get("version", ""),
                "enabled": bool(payload.get("enabled", True)),
                "target_mode": payload.get("target_mode"),
                "server_url": payload.get("server_url"),
                "local_ports": local_ports,
                "upstream": payload.get("upstream", {}),
                "denied_devices": denied,
                "udp_forwarded": forwarded,
                "udp_dropped": dropped,
                "last_error": payload.get("last_error", ""),
            },
        )
        for event_item in device_events:
            self._emit_event({"type": "device_update", "item": event_item})
        for event in claim_events:
            self._emit_event(event)

    def register_gateway_device(self, device_uid: str, sender: Callable[[dict[str, Any]], None], gateway_id: str = "") -> str:
        device_uid = self._resolve_known_device_uid(device_uid)
        if not device_uid:
            return ""
        with self._lock:
            self._gateway_senders[device_uid] = sender
            if gateway_id:
                self._gateway_device_ids[device_uid] = gateway_id
                device_event = self._record_gateway_device_presence_locked(
                    device_uid,
                    gateway_id,
                    {"device_uid": device_uid, "connected": True},
                    True,
                    datetime.now(timezone.utc).isoformat(),
                )
                if gateway_id in self._gateways:
                    gateway = dict(self._gateways[gateway_id])
                    gateway["serving_devices"] = sorted([uid for uid, gid in self._gateway_device_ids.items() if gid == gateway_id])
                    gateway["serving_device_count"] = len(gateway["serving_devices"])
                    self._gateways[gateway_id] = gateway
                    gateway_event = dict(gateway)
                else:
                    gateway_event = None
            else:
                gateway_event = None
                device_event = None
        if device_event is not None:
            self._emit_event({"type": "device_update", "item": device_event})
        if gateway_event is not None:
            self._emit_event({"type": "gateway_update", "item": gateway_event})
        return device_uid

    def _record_gateway_device_presence_locked(
        self,
        device_uid: str,
        gateway_id: str,
        device: dict[str, Any],
        connected: bool,
        seen_at: str,
        allow_disconnect_grace: bool = False,
    ) -> dict[str, Any] | None:
        existing = dict(self._devices.get(device_uid, {}))
        actually_connected = connected
        if not connected and allow_disconnect_grace and self._should_preserve_recent_findme_attachment(existing, seen_at):
            connected = True
            device = dict(device)
            existing_findme = existing.get("findme") if isinstance(existing.get("findme"), dict) else {}
            device["connected"] = True
            device["findme_state"] = "attached"
            device.setdefault("addr", existing_findme.get("host", ""))
            device.setdefault("gateway_name", existing_findme.get("gateway_name", ""))
            device.setdefault("udp_port", existing_findme.get("udp_port", ""))
        device_name = str(device.get("device_name") or device.get("name") or existing.get("device_name") or device_uid)
        device_name = self._canonical_device_name(device_name, device_uid)
        gateway_state = {
            "gateway_id": gateway_id,
            "connected": bool(connected),
            "findme_state": str(device.get("findme_state") or ""),
            "updated_at": seen_at,
        }
        findme_state = {
            "state": str(device.get("findme_state") or ("attached" if connected else "disconnected")),
            "gateway_id": gateway_id,
            "gateway_name": device.get("gateway_name", ""),
            "host": device.get("last_findme_addr") or device.get("addr") or "",
            "udp_port": device.get("udp_port", ""),
            "claim_id": device.get("claim_id", ""),
            "last_success_ms": device.get("last_findme_at", ""),
            "last_heartbeat_at": device.get("last_heartbeat_at", ""),
            "last_error": device.get("findme_reason", ""),
        }
        boot_transition = None if connected else self._active_boot_transition_locked(device_uid)
        incoming = {
            "device_uid": device_uid,
            "device_name": device_name,
            "nickname": self._nicknames.get(device_uid, ""),
            "display_name": self._nicknames.get(device_uid, "") or device_name,
            "gateway_id": gateway_id,
            "gateway_connected": bool(connected),
            "last_gateway_seen_at": seen_at,
            "gateway_state": gateway_state,
            "findme": findme_state,
            "protocol": device.get("protocol"),
            "firmware_version": device.get("firmware_version"),
            "hardware_model": device.get("hardware_model"),
            "transport_path": device.get("transport_path"),
            "last_heartbeat_at": device.get("last_heartbeat_at"),
            "recording_enabled": device_uid in self._recording_enabled,
            "recording_error": self._recording_errors.get(device_uid, ""),
        }
        runtime = device.get("runtime") if isinstance(device.get("runtime"), dict) else {}
        mode = device.get("mode") or runtime.get("mode")
        # Don't let a stale gateway snapshot silently downgrade a maintenance mode
        # that the backend already knows about from an authoritative device result.
        # _known_mode_from_status_locked reads _latest_status under the same lock.
        if mode == "normal":
            known_mode = self._known_mode_from_status_locked(device_uid)
            if known_mode == "maintenance":
                mode = "maintenance"
        if boot_transition is not None:
            incoming["mode"] = "booting"
            incoming["booting"] = True
            incoming["boot_target_mode"] = boot_transition.get("target_mode", "")
            incoming["boot_command"] = boot_transition.get("command", "")
            incoming["boot_expires_at_monotonic"] = boot_transition.get("expires_at", 0)
            mode = "booting"
        if mode:
            incoming["mode"] = mode
        incoming["last_seen_at"] = seen_at
        # `last_live_seen_at` tracks when the device was *genuinely* online.
        # The findme disconnect grace may keep `gateway_connected` (and thus
        # connected) reported as True to ride out a transient snapshot, but
        # that grace must NOT advance the live-seen clock — otherwise the
        # gateway's repeated disconnected snapshots would keep last_live_seen_at
        # fresh forever, the grace would never expire, and a powered-off /
        # soft-off device would stay "online" with an ever-advancing "last seen".
        # So live-seen only advances on an actually-connected snapshot.
        if actually_connected:
            incoming["last_live_seen_at"] = seen_at
            incoming["last_kind"] = "gateway"
        elif existing and (existing.get("gateway_connected") is not False or existing.get("gateway_id") == gateway_id):
            incoming["last_kind"] = existing.get("last_kind") or "gateway"
        else:
            return None
        merged = self._merge_device_entry(existing, incoming)
        self._devices[device_uid] = merged
        return self._decorate_device_entry(merged)

    @classmethod
    def _should_preserve_recent_findme_attachment(cls, existing: dict[str, Any], seen_at: str) -> bool:
        findme = existing.get("findme") if isinstance(existing.get("findme"), dict) else {}
        if str(findme.get("state") or "").strip().lower() != "attached":
            return False
        # Measure how long ago the device was *genuinely online*, not how long
        # ago the gateway last mentioned it. `last_seen_at` is refreshed every
        # gateway snapshot even while the gateway reports the device as
        # disconnected (the gateway keeps mentioning the device for its own
        # 90s stale window), so using it would make this grace window never
        # expire — a powered-off / soft-off device would stay "online" forever.
        # `last_live_seen_at` is only refreshed while the device is connected,
        # so the grace correctly rides out a single transient disconnect
        # snapshot and then lets the device go offline.
        last_live = str(existing.get("last_live_seen_at") or existing.get("last_seen_at") or "")
        if not last_live:
            return False
        seen_dt = cls._parse_iso_datetime(seen_at)
        last_live_dt = cls._parse_iso_datetime(last_live)
        if seen_dt is None or last_live_dt is None:
            return False
        age = (seen_dt - last_live_dt).total_seconds()
        return 0 <= age <= cls.FINDME_DISCONNECT_GRACE_SEC

    @staticmethod
    def _parse_iso_datetime(value: str) -> datetime | None:
        text = str(value or "").strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed

    def unregister_gateway_sender(self, sender: Callable[[dict[str, Any]], None]) -> None:
        gateway_updates: list[dict[str, Any]] = []
        device_updates: list[dict[str, Any]] = []
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            stale = [
                (device_uid, self._gateway_device_ids.get(device_uid, ""))
                for device_uid, existing in self._gateway_senders.items()
                if existing is sender or existing == sender
            ]
            for device_uid, gateway_id in stale:
                self._gateway_senders.pop(device_uid, None)
                self._gateway_device_ids.pop(device_uid, None)
                event_item = self._record_gateway_device_presence_locked(
                    device_uid,
                    gateway_id,
                    {"device_uid": device_uid, "connected": False},
                    False,
                    now,
                )
                if event_item is not None:
                    device_updates.append(event_item)
            stale_gateways = [gateway_id for gateway_id, existing in self._gateway_session_senders.items() if existing is sender or existing == sender]
            for gateway_id in stale_gateways:
                self._gateway_session_senders.pop(gateway_id, None)
                gateway = dict(self._gateways.get(gateway_id, {"gateway_id": gateway_id}))
                gateway["status"] = "offline"
                gateway["last_seen"] = now
                gateway["serving_devices"] = sorted([uid for uid, gid in self._gateway_device_ids.items() if gid == gateway_id])
                gateway["serving_device_count"] = len(gateway["serving_devices"])
                self._gateways[gateway_id] = gateway
                gateway_updates.append(dict(gateway))
        for device in device_updates:
            self._emit_event({"type": "device_update", "item": device})
        for gateway in gateway_updates:
            self._emit_event({"type": "gateway_update", "item": gateway})

    def delete_gateway(self, gateway_id: str) -> bool:
        gateway_id = str(gateway_id or "").strip()
        if not gateway_id:
            return False
        device_updates: list[dict[str, Any]] = []
        with self._lock:
            if gateway_id not in self._gateways:
                return False
            now = datetime.now(timezone.utc).isoformat()
            self._gateways.pop(gateway_id, None)
            self._gateway_session_senders.pop(gateway_id, None)
            claim_ids = [claim_id for claim_id, claim in self._gateway_claims.items() if claim.get("gateway_id") == gateway_id]
            for claim_id in claim_ids:
                self._gateway_claims.pop(claim_id, None)
            device_uids = [device_uid for device_uid, mapped_gateway_id in self._gateway_device_ids.items() if mapped_gateway_id == gateway_id]
            for device_uid in device_uids:
                self._gateway_senders.pop(device_uid, None)
                self._gateway_device_ids.pop(device_uid, None)
                event_item = self._record_gateway_device_presence_locked(
                    device_uid,
                    "",
                    {"device_uid": device_uid, "connected": False, "findme_state": "disconnected"},
                    False,
                    now,
                )
                if event_item is not None:
                    device_updates.append(event_item)
            snapshot = [dict(self._gateways[key]) for key in sorted(self._gateways.keys())]
        for device in device_updates:
            self._emit_event({"type": "device_update", "item": device})
        self._emit_event({"type": "gateway_snapshot", "items": snapshot})
        return True

    def handle_gateway_claim_request(self, gateway_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        gateway_id = str(gateway_id or "").strip()
        payload = dict(payload or {})
        device_uid = self._resolve_known_device_uid(payload.get("device_uid") or "")
        claim_id = str(payload.get("claim_id") or "").strip()
        ttl_ms = int(payload.get("ttl_ms") or 30000)
        if not gateway_id:
            raise ValueError("gateway_id_required")
        if not device_uid:
            raise ValueError("device_uid_required")
        if not claim_id:
            raise ValueError("claim_id_required")
        now = datetime.now(timezone.utc).isoformat()
        claim = {
            "gateway_id": gateway_id,
            "device_uid": device_uid,
            "claim_id": claim_id,
            "ttl_ms": ttl_ms,
            "state": "requested",
            "requested_at": now,
            "updated_at": now,
            "last_error": "",
        }
        with self._lock:
            self._gateway_claims[claim_id] = claim
            target_sender = self._gateway_session_senders.get(gateway_id)
            device_sender = self._gateway_senders.get(device_uid)
        if device_sender is None:
            claim["state"] = "waiting_for_device"
            claim["last_error"] = "device_not_connected"
            self._update_gateway_claim(claim, target_sender)
            return dict(claim)
        command_payload = {
            "command": "findme_switch_gateway",
            "request_id": "findme-claim-{}".format(claim_id),
            "preferred_gateway_id": gateway_id,
            "claim_id": claim_id,
            "ttl_ms": ttl_ms,
        }
        try:
            self.publish_command(device_uid, command_payload)
            claim["state"] = "switch_command_queued"
        except RuntimeError as exc:
            claim["state"] = "failed"
            claim["last_error"] = str(exc)
        self._update_gateway_claim(claim, target_sender)
        return dict(claim)

    def _update_gateway_claim(self, claim: dict[str, Any], sender: Callable[[dict[str, Any]], None] | None = None) -> None:
        claim = dict(claim)
        claim["updated_at"] = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._gateway_claims[str(claim.get("claim_id") or "")] = claim
        event = {"type": "gateway_claim_update", **claim}
        if sender is not None:
            try:
                sender(event)
            except Exception:
                pass
        self._emit_event(event)

    def record_gateway_status(self, device_uid: str, payload: dict[str, Any]) -> None:
        self._record_status(device_uid, payload)

    def record_gateway_result(self, device_uid: str, payload: dict[str, Any]) -> None:
        self._record_result(device_uid, payload)

    def record_gateway_packet(self, payload: bytes) -> None:
        self._handle_udp_datagram(payload, ("gateway", 0))

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
                    "auto_apply_on_boot": bool(payload.get("auto_apply_on_boot", False)),
                    "manifest_url": str(payload.get("manifest_url") or ota_cfg.get("manifest_url") or ""),
                })
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
                    "gateway_name": "New Horizons Gateway",
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
            elif command == "set_imu":
                enabled = bool(payload.get("enabled", True))
                imu = dict(runtime.get("imu") or {})
                imu.update(
                    {
                        "enabled": enabled,
                        "runtime_enabled": enabled,
                        "state": "ready" if enabled else "disabled",
                        "last_error": "",
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
                external.setdefault("preset", "stream_health")
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
                        "active_preset": external.get("preset", "stream_health") if external.get("mode") == "enabled" and profile.get("supports_external_led") else "off",
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
            elif command == "file_write_begin":
                result_payload.update({
                    "message": "file_write_started",
                    "scope": str(payload.get("scope", "user")),
                    "path": payload.get("path", ""),
                    "size": int(payload.get("size", 0)),
                })
            elif command == "file_write_chunk":
                result_payload.update({
                    "message": "file_write_chunk_written",
                    "scope": str(payload.get("scope", "user")),
                    "path": payload.get("path", ""),
                    "written": int(payload.get("offset", 0)) + len(str(payload.get("data", ""))) // 2,
                })
            elif command == "file_write_finish":
                result_payload.update({
                    "message": "file_write_finished",
                    "scope": str(payload.get("scope", "user")),
                    "path": payload.get("path", ""),
                })
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
                result_payload.update({
                    "message": "file_deleted",
                    "scope": str(payload.get("scope", "user")),
                    "path": payload.get("path", ""),
                    "applied": True,
                })
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
                    "device_name": "New Horizons OS-{}".format(device_uid),
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
            parsed = parse_binary_packet(payload)
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
                "device_name": "New Horizons OS-{}".format(device_uid),
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

    def _record_status(self, device_uid: str, payload: Any) -> None:
        if not isinstance(payload, dict):
            return
        payload = dict(payload)
        device_uid = self._device_uid_from_payload(device_uid, payload)
        if not device_uid:
            return
        payload["device_uid"] = device_uid
        if self._is_full_hex_uid(device_uid):
            payload["device_id"] = device_uid
        payload.setdefault("received_at", datetime.now(timezone.utc).isoformat())
        self._remember_device_id_mapping(device_uid, payload)
        with self._lock:
            existing_for_merge = self._devices.get(device_uid, {})
            existing_status = existing_for_merge.get("last_status") if isinstance(existing_for_merge.get("last_status"), dict) else {}
        payload = self._merge_status_payload(existing_status, payload)
        entry = self._normalize_device_entry(device_uid, payload, kind="status")
        with self._lock:
            purged_aliases = self._purge_short_aliases_locked(device_uid)
            previous_mode = self._known_mode_from_status_locked(device_uid)
            self._latest_status[device_uid] = payload
            existing = self._devices.get(device_uid, {})
            merged = self._merge_device_entry(existing, entry)
            merged["last_status"] = payload
            self._clear_incompatible_visualization_locked(device_uid, merged)
            self._devices[device_uid] = merged
            self._clear_boot_pending_if_mode_changed_locked(device_uid, previous_mode, self._mode_from_payload(payload))
            event_item = self._decorate_device_entry(merged)
        self._emit_event({"type": "device_update", "item": event_item})
        if purged_aliases:
            self._emit_event({"type": "device_snapshot", "items": self.list_devices()})
        synthetic_result = self._pending_result_from_status(device_uid, payload)
        if synthetic_result is not None:
            self._record_result(device_uid, synthetic_result)

    @classmethod
    def _merge_status_payload(cls, existing_status: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
        if not existing_status:
            return cls._finalize_apply_update_for_firmware_version(incoming)
        skip_existing = {"request_id", "command", "status", "message", "received_at"}
        merged: dict[str, Any] = {
            key: value
            for key, value in existing_status.items()
            if key not in skip_existing
        }
        for key, value in incoming.items():
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key] = cls._merge_nested_status_dict(merged[key], value)
            else:
                merged[key] = value
        return cls._finalize_apply_update_for_firmware_version(merged)

    @classmethod
    def _merge_nested_status_dict(cls, existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
        merged = dict(existing)
        for key, value in incoming.items():
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key] = cls._merge_nested_status_dict(merged[key], value)
            else:
                merged[key] = value
        return merged

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

    def _clear_incompatible_visualization_locked(self, device_uid: str, merged: dict[str, Any]) -> None:
        matrix_shape = self._matrix_shape_tuple(merged.get("matrix_shape"))
        if matrix_shape is None:
            return
        latest = self._latest_visualization.get(device_uid)
        if not isinstance(latest, dict):
            return
        points = latest.get("p")
        if not isinstance(points, list):
            return
        expected_points = matrix_shape[0] * matrix_shape[1]
        if len(points) == expected_points:
            return
        self._latest_visualization.pop(device_uid, None)
        merged.pop("latest_sample", None)

    def _record_result(self, device_uid: str, payload: Any) -> None:
        if not isinstance(payload, dict):
            return
        payload = dict(payload)
        device_uid = self._device_uid_from_payload(device_uid, payload)
        if not device_uid:
            return
        payload["device_uid"] = device_uid
        if self._is_full_hex_uid(device_uid):
            payload["device_id"] = device_uid
        payload.setdefault("received_at", datetime.now(timezone.utc).isoformat())
        self._remember_device_id_mapping(device_uid, payload)
        request_id = str(payload.get("request_id") or "")
        if request_id:
            self._forget_pending_command(device_uid, {"request_id": request_id})
        entry = self._normalize_device_entry(device_uid, payload, kind="result")
        with self._lock:
            purged_aliases = self._purge_short_aliases_locked(device_uid)
            previous_mode = self._known_mode_from_status_locked(device_uid)
            self._latest_result[device_uid] = payload
            existing = self._devices.get(device_uid, {})
            merged = self._merge_device_entry(existing, entry)
            merged["last_result"] = payload
            if self._is_status_snapshot_result(payload):
                # Firmware wraps all status fields under a "data" key
                # (e.g. {"ok":true,"cmd":"status","data":{"wifi":{...},...}}).
                # The frontend reads flat fields (status.wifi, status.battery …),
                # matching the heartbeat/stream path.  Hoist the inner "data"
                # dict to the top level so both paths produce the same shape.
                inner = payload.get("data") if isinstance(payload.get("data"), dict) else {}
                if inner:
                    status_payload: dict[str, Any] = dict(inner)
                    for k in ("device_uid", "device_id", "received_at",
                              "received_at_ms", "command", "request_id",
                              "status", "message", "transport_path",
                              "gateway_id", "gateway_connected", "mode",
                              "protocol", "firmware_version"):
                        if k in payload:
                            status_payload[k] = payload[k]
                else:
                    status_payload = dict(payload)
                maintenance_mode = self._maintenance_mode_from_result(payload)
                if maintenance_mode is not None:
                    status_payload["mode"] = maintenance_mode
                    runtime_data = status_payload.get("runtime") if isinstance(status_payload.get("runtime"), dict) else {}
                    status_payload["runtime"] = {**runtime_data, "mode": maintenance_mode}
                    status_payload["scan_stopped"] = maintenance_mode != "normal"
                existing_status = self._latest_status.get(device_uid) or {}
                status_payload = self._merge_status_payload(existing_status, status_payload)
                self._latest_status[device_uid] = status_payload
                merged["last_status"] = status_payload
                if maintenance_mode is not None:
                    merged["mode"] = maintenance_mode
            self._clear_incompatible_visualization_locked(device_uid, merged)
            self._devices[device_uid] = merged
            if self._is_status_snapshot_result(payload):
                self._clear_boot_pending_if_mode_changed_locked(device_uid, previous_mode, self._mode_from_payload(payload))
            event_item = self._decorate_device_entry(merged)
        self._emit_event(
            {
                "type": "command_result",
                "device_uid": device_uid,
                "request_id": request_id,
                "result": payload,
            }
        )
        self._emit_event({"type": "device_update", "item": event_item})
        if purged_aliases:
            self._emit_event({"type": "device_snapshot", "items": self.list_devices()})

    @staticmethod
    def _is_status_snapshot_result(payload: dict[str, Any]) -> bool:
        command = str(payload.get("command") or "")
        message = str(payload.get("message") or "")
        return command in ("status", "query", "memory_status", "scan_health", "storage_status", "set_log", "set_ota_config", "check_update", "enter_maintenance", "exit_maintenance") or message in (
            "status",
            "memory_status",
            "scan_health",
            "storage_status",
            "log_config_updated",
            "ota_config_updated",
            "update_checked",
            "stream_buffer_updated",
            "maintenance_entered",
            "maintenance_exited",
        )

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
            if existing.get("device_name") and entry.get("device_name") == device_uid:
                entry["device_name"] = None
                entry["display_name"] = None
            merged = self._merge_device_entry(existing, entry)
            merged["recording_enabled"] = device_uid in self._recording_enabled
            if device_uid in self._recording_errors:
                merged["recording_error"] = self._recording_errors[device_uid]
            self._devices[device_uid] = merged
            is_new_device = not bool(existing)
            event_item = self._decorate_device_entry(merged)
        self._emit_event({"type": "visualization_update", "device_uid": device_uid, "data": payload})
        if is_new_device:
            self._emit_event({"type": "device_update", "item": event_item})
        if purged_aliases:
            self._emit_event({"type": "device_snapshot", "items": self.list_devices()})

    def _remember_device_id_mapping(self, device_uid: str, payload: dict[str, Any]) -> None:
        candidates = []
        for key in ("device_id", "id"):
            if payload.get(key):
                candidates.append(str(payload.get(key)))
        system = payload.get("system") if isinstance(payload.get("system"), dict) else {}
        for key in ("device_id", "id"):
            if system.get(key):
                candidates.append(str(system.get(key)))
        with self._lock:
            for value in candidates:
                normalized = self._normalize_device_id(value)
                if normalized:
                    self._device_id_to_uid[normalized] = device_uid

    @staticmethod
    def _normalize_device_id(value: str) -> str:
        normalized = NewHorizonsService._normalize_uid(value)
        if normalized.startswith("0X"):
            return "0x" + normalized[2:]
        return normalized

    @staticmethod
    def _csv_timestamp_ms(payload: dict[str, Any], fallback: datetime) -> int:
        received_at = payload.get("received_at")
        if isinstance(received_at, str) and received_at.strip():
            text = received_at.strip()
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            try:
                parsed = datetime.fromisoformat(text)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return int(parsed.timestamp() * 1000)
            except ValueError:
                pass
        return int(fallback.timestamp() * 1000)

    def _write_csv_sample(self, device_uid: str, payload: dict[str, Any]) -> None:
        pressures = payload.get("p")
        if not isinstance(pressures, list):
            return
        now = datetime.now(timezone.utc)
        path = self._csv_paths.get(device_uid)
        if path is None:
            path = self._data_root / device_uid / now.strftime("%Y%m%d") / "{}.csv".format(now.strftime("%H%M%S"))
            self._csv_paths[device_uid] = path
        path.parent.mkdir(parents=True, exist_ok=True)
        is_new = not path.exists()
        imu = payload.get("imu") if isinstance(payload.get("imu"), dict) else {}
        gyro = payload.get("gyro") or imu.get("gyro") or [0, 0, 0]
        acc = payload.get("acc") or imu.get("acc") or [0, 0, 0]
        mag = payload.get("mag") or imu.get("mag") or [0, 0, 0]
        raw_adc = payload.get("raw_adc")
        include_raw = isinstance(raw_adc, list) and len(raw_adc) == len(pressures)
        timestamp = self._csv_timestamp_ms(payload, now)
        with path.open("a", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            if is_new:
                writer.writerow(
                    ["timestamp_ms"]
                    + ["P{}".format(index + 1) for index in range(len(pressures))]
                    + (["RawADC_{}".format(index + 1) for index in range(len(pressures))] if include_raw else [])
                    + ["Mag_x", "Mag_y", "Mag_z", "Gyro_x", "Gyro_y", "Gyro_z", "Acc_x", "Acc_y", "Acc_z"]
                )
            writer.writerow(
                [timestamp]
                + pressures
                + (list(raw_adc) if include_raw else [])
                + list(mag[:3])
                + list(gyro[:3])
                + list(acc[:3])
            )

    def _normalize_device_entry(self, device_uid: str, payload: dict[str, Any], kind: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        received_at = str(payload.get("received_at") or now)
        system = payload.get("system") if isinstance(payload.get("system"), dict) else {}
        update_state = payload.get("update_state")
        if update_state is None and kind == "result":
            update_state = self._update_state_from_result(payload)
        device_name = str(payload.get("device_name") or system.get("name") or device_uid)
        device_name = self._canonical_device_name(device_name, device_uid)
        has_system_versions = any(key in payload for key in ("hardware_model", "firmware_version", "protocol"))
        system_summary = None
        if kind == "status" or system or has_system_versions:
            system_summary = self._system_summary(device_uid, payload, received_at)
        return {
            "device_uid": device_uid,
            "device_name": device_name,
            "nickname": self._nicknames.get(device_uid, ""),
            "display_name": self._nicknames.get(device_uid, "") or device_name,
            "channel": payload.get("channel") or payload.get("runtime", {}).get("channel"),
            "mode": payload.get("mode") or payload.get("runtime", {}).get("mode"),
            "transport_mode": payload.get("runtime", {}).get("transport", {}).get("mode"),
            "transport_path": payload.get("transport_path"),
            "gateway_connected": payload.get("gateway_connected"),
            "protocol": payload.get("protocol"),
            "firmware_version": payload.get("firmware_version"),
            "hardware_model": payload.get("hardware_model"),
            "matrix_shape": payload.get("matrix_shape"),
            "findme": payload.get("findme"),
            "last_heartbeat_at": payload.get("last_heartbeat_at"),
            "runtime": payload.get("runtime"),
            "logging": payload.get("logging") or payload.get("runtime", {}).get("logging"),
            "services": payload.get("services"),
            "update_state": update_state,
            "system_summary": system_summary,
            "scan_stopped": payload.get("scan_stopped"),
            "last_seen_at": received_at,
            "last_live_seen_at": received_at if payload.get("live_seen", kind in ("status", "result", "parsed")) else None,
            "last_kind": kind,
            "last_status": self._latest_status.get(device_uid),
            "last_result": self._latest_result.get(device_uid),
            "recording_enabled": device_uid in self._recording_enabled,
            "recording_error": self._recording_errors.get(device_uid, ""),
        }

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

    def _boot_command_mode_error_locked(self, device_uid: str, payload: dict[str, Any]) -> str:
        status = self._latest_status.get(device_uid) or {}
        return self._boot_command_mode_error_for_status(status, payload)

    @classmethod
    def _boot_command_mode_error_for_status(cls, status: dict[str, Any], payload: dict[str, Any]) -> str:
        command = str(payload.get("command") or payload.get("cmd") or "").strip()
        current_mode = cls._mode_from_payload(status)
        known_commands = set()
        for commands in cls.MODE_COMMANDS.values():
            known_commands.update(commands)
        if command not in known_commands:
            return "unknown_command" if command else ""
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

    @classmethod
    def _merge_device_entry(cls, existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
        merged = dict(existing)
        existing_mode = str(merged.get("mode") or "")
        incoming_mode = str(incoming.get("mode") or "")
        for key, value in incoming.items():
            if value is not None:
                if key == "update_state":
                    value = cls._merge_update_state(merged.get("update_state"), value, existing_mode, incoming_mode)
                merged[key] = value
        return cls._finalize_apply_update_for_firmware_version(merged)

    def _decorate_device_entry(self, entry: dict[str, Any]) -> dict[str, Any]:
        result = dict(entry)
        transition = self._active_boot_transition_locked(str(result.get("device_uid") or ""))
        if transition is not None:
            result["booting"] = True
            result["boot_target_mode"] = transition.get("target_mode", "")
            result["boot_command"] = transition.get("command", "")
            result["mode"] = "booting"
        else:
            result.pop("booting", None)
            result.pop("boot_target_mode", None)
            result.pop("boot_command", None)
        nickname = self._nicknames.get(str(result.get("device_uid") or ""), "")
        device_group = self._device_groups.get(str(result.get("device_uid") or ""), "")
        device_name = str(result.get("device_name") or result.get("device_uid") or "")
        result["nickname"] = nickname
        result["display_name"] = nickname or device_name
        result["device_group"] = device_group
        result["recording_enabled"] = str(result.get("device_uid") or "") in self._recording_enabled
        result["recording_error"] = self._recording_errors.get(str(result.get("device_uid") or ""), "")
        return result

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
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(dict(sorted(values.items())), indent=2, sort_keys=True), encoding="utf-8")

    @staticmethod
    def _system_summary(device_uid: str, payload: dict[str, Any], received_at: str) -> dict[str, Any]:
        runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
        system = payload.get("system") if isinstance(payload.get("system"), dict) else {}
        matrix = payload.get("matrix_shape") if isinstance(payload.get("matrix_shape"), dict) else {}
        battery = payload.get("battery") if isinstance(payload.get("battery"), dict) else {}
        mode = payload.get("mode") or runtime.get("mode") or system.get("mode") or "unknown"
        firmware_version = system.get("firmware_version") or runtime.get("firmware_version") or payload.get("firmware_version") or "unknown"
        protocol = payload.get("protocol") or runtime.get("protocol") or system.get("protocol") or "NHO/Arduino/1"
        return {
            "device_uid": device_uid,
            "mode": mode,
            "firmware_version": firmware_version,
            "protocol": protocol,
            "hardware_model": system.get("hardware_model") or payload.get("hardware_model") or "unknown",
            "updated_at": received_at,
            "matrix_shape": matrix,
            "battery": battery,
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
                "preset": "stream_health",
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
            indicators["external_led"].update({"count": 3, "pin": 12, "initialized": True, "active_preset": "off"})
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
            "firmware_version": "v0.5.0",
            "hardware_model": str(profile["hardware_model"]),
            "system": {
                "name": device_uid,
                "hardware_model": str(profile["hardware_model"]),
                "mode": mode,
                "firmware_version": "v0.5.0",
                "protocol": "NHO/Arduino/1",
            },
            "matrix_shape": shape,
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
                    "gateway_name": "New Horizons Gateway",
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
                "gateway_name": "New Horizons Gateway",
                "source": "findme",
                "last_success_ms": 0,
                "last_error": "",
            },
            "update": {
                "source": "github",
                "manifest_url": "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-latest.json",
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

    def _mock_files_for_device(self, device_uid: str, scope: str = "user") -> list[dict[str, Any]]:
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


_SERVICE: NewHorizonsService | None = None


def get_service(autostart: bool = False, mock_mode: bool | None = None) -> NewHorizonsService:
    global _SERVICE
    if _SERVICE is None:
        _SERVICE = NewHorizonsService(autostart=autostart, mock_mode=mock_mode)
    elif autostart:
        _SERVICE.start()
    return _SERVICE
