from __future__ import annotations

import hashlib
import os
import csv
import json
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .app_event_log import append_dropped_marker, append_events, events_lost_since
from .arduino_protocol import CONTROL_PORT, is_arduino_heartbeat_packet, is_arduino_stream_packet, packet_device_uid, send_control_command
from .board_profile import GCU_HARDWARE_MODEL, V1_HARDWARE_MODEL, board_profile_for_hardware_model, normalize_hardware_model
from .packet_parser import PacketParseError, parse_binary_packet
from .result_chunks import RESULT_CHUNK_TYPE, ResultChunkReassembler, normalize_device_result
from .terminal import DEVICE_COMMAND_ALLOWLIST
from .device_commands import CommandCatalogStore
from .discovery import DiscoveryResponder
from .hub_channel_watch import HubChannelWatcher
from .udp_ingest import UDPIngestServer
from .mock_device import MockDeviceMixin
from .update_state import UpdateStateMixin


from .service_constants import (  # noqa: F401  (re-exported for api.py / ws.py)
    DEFAULT_DEVICE_NAME_PREFIX,
    DEFAULT_DEVICE_NAME_PREFIXES,
    DEVICE_BOOTING,
    DEVICE_BOOTING_MESSAGE,
    DEVICE_CONTROL_UNAVAILABLE,
    DEVICE_CONTROL_UNAVAILABLE_MESSAGE,
    GATEWAY_CONTROL_UNAVAILABLE,
    GATEWAY_CONTROL_UNAVAILABLE_MESSAGE,
    LEGACY_DEFAULT_DEVICE_NAME_PREFIXES,
    MOCK_FIRMWARE_VERSION,
    command_error_message,
)


class NewHorizonsService(MockDeviceMixin, UpdateStateMixin):
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
    # A Gateway/Hub heartbeat only relays its own cached view of a device's
    # mode, on its own independent cadence -- it can never be fresher than
    # the device's own direct status/result reports. Without this, the two
    # independently-cadenced writers (direct vs. relayed) kept re-asserting
    # their own value for the same device and the merged mode (and the
    # Desktop UI) flickered continuously between them. ~3x the ~5s cadence
    # both direct heartbeats and Gateway/Hub summaries use in practice.
    DIRECT_MODE_FRESH_SEC = 15
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
        "sensor_sample",
        # The battery card's slice of status (firmware v1.14.0+), polled
        # instead of the ~18 KB status while a gauge resync runs.
        "battery_status",
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
        "reboot_wifi_setup",
        "set_transport",
        # v1.0.0 kernel layer. The firmware gates none of these on maintenance
        # mode, so they belong here rather than in MAINTENANCE_COMMANDS.
        "task_list",
        "service_list",
        "service_restart",
        "dmesg",
        "crash_log",
        "crash_clear",
        "health",
        "capabilities",
        "config_schema",
        "config_get",
        "config_set",
        "set_time",
        "clock_sync",
        "clock_status",
        "set_clock_config",
        "set_power_profile",
        "app_list",
        "app_enable",
        "app_disable",
        "app_revive",
        "app_load_flow",
        "app_unload_flow",
        "app_events",
        "app_list_packages",
        "app_verify",
        # v1.7.0: what the apps' OLED rows, status LED and strip show now.
        "app_view",
        # v1.15.0: the device's own command table (device_commands.py).
        "commands",
    }
    NORMAL_COMMANDS = SHARED_COMMANDS | {
        "enter_maintenance",
        "set_matrix_layout",
        "set_scan_timing",
        "set_stream_buffer",
        "set_charge_profile",
        "set_battery_profile",
        "resync_battery_gauge",
        "power_set_state",
        "set_action_button",
        "set_indicators",
        "set_imu",
        "set_filter",
        "set_raw_adc",
        "calibration_status",
        "calibration_enable",
        "calibration_disable",
        "calibration_dump_tare",
        "calibration_dump_level",
        "calibration_dump_fit",
        # Zeroing pauses the scan itself (firmware v1.5.1+); older firmware
        # answers maintenance_required and the Desktop falls back.
        "calibration_tare_capture",
        "calibration_tare_clear",
    }
    MAINTENANCE_COMMANDS = NORMAL_COMMANDS | {
        "exit_maintenance",
        "calibration_clear_profile",
        "calibration_delete_level",
        "calibration_session_begin",
        "calibration_session_abort",
        "calibration_session_commit",
        "calibration_capture_tare",
        "calibration_capture_cell",
        "calibration_capture_all",
        "calibration_set_fit",
        "calibration_set_reference",
        "file_write_begin",
        "file_write_chunk",
        "file_write_finish",
        "file_delete",
        "app_install",
        "app_uninstall",
        "app_activate",
        "app_deactivate",
        "app_reindex",
    }
    MODE_COMMANDS = {
        "normal": NORMAL_COMMANDS,
        "maintenance": MAINTENANCE_COMMANDS,
        "safe_maintenance": MAINTENANCE_COMMANDS,
        "safemaintenance": MAINTENANCE_COMMANDS,
    }
    # Commands that target a Hub/Gateway process itself (via
    # publish_gateway_command()) rather than a downstream device_uid. Small
    # and flat on purpose -- unlike device commands, Hubs have no "mode"
    # concept to gate against.
    HUB_COMMANDS = {"set_config", "factory_reset", "clock_sync", "check_update", "apply_update", "set_update_channel"}

    # Failures a relay (Hub or Gateway) reports on a device's behalf when the
    # device never answered. They arrive as ordinary "result"s, but they are
    # not evidence the device is alive -- counting them as such kept a
    # powered-off Hub device "online" for as long as any page kept polling it.
    RELAY_FAILURE_CODES = {
        "command_delivery_timeout",
        "result_page_timeout",
        "device_not_connected_to_hub",
        "device_command_already_in_flight",
        "hub_command_roster_full",
        "command_too_large",
        "gateway_send_failed",
    }

    # Device commands the backend issues on its own behalf (hub migration, WiFi
    # provisioning). They are deliberately absent from the terminal allowlist --
    # users do not type them -- but they are real commands, so the existence
    # check has to know about them.
    INTERNAL_DEVICE_COMMANDS = {"set_transport", "set_wifi"}
    KNOWN_DEVICE_COMMANDS = DEVICE_COMMAND_ALLOWLIST | INTERNAL_DEVICE_COMMANDS

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
        # Mock-mode file uploads in progress, keyed by (device_uid, scope, path).
        # The mock used to ack writes without storing anything, so an "uploaded"
        # file never appeared in file_list and nothing could be installed from it.
        self._mock_write_sessions: dict[tuple[str, str, str], dict[str, Any]] = {}
        # Mock app roster per device, so the Apps UI is developable without hardware.
        self._mock_apps: dict[str, list[dict[str, Any]]] = {}
        self._mock_calibration: dict[str, dict[str, Any]] = {}
        self._mock_packages: dict[str, list[dict[str, Any]]] = {}
        self._recording_enabled: set[str] = set()
        self._recording_errors: dict[str, str] = {}
        # Highest app-event sequence already written to a sidecar, per device.
        self._app_event_seq: dict[str, int] = {}
        self._app_event_thread: threading.Thread | None = None
        self._app_event_stop = threading.Event()
        # What each device (firmware v1.15.0+) says it accepts; see
        # device_commands.py. Absent -> the static tables above apply.
        self._command_catalogs = CommandCatalogStore()
        self._pending_commands: dict[str, dict[str, dict[str, Any]]] = {}
        self._event_listeners: list[Callable[[dict[str, Any]], None]] = []
        self._ws_stats_provider: Callable[[], dict[str, Any]] | None = None
        self._gateway_senders: dict[str, Callable[[dict[str, Any]], None]] = {}
        self._gateway_session_senders: dict[str, Callable[[dict[str, Any]], None]] = {}
        self._gateway_device_ids: dict[str, str] = {}
        self._udp_control_sessions: dict[str, tuple[str, int]] = {}
        # Replies that arrive in pieces: Hub pages and direct-UDP chunks.
        self._result_chunks = ResultChunkReassembler()
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
        self._hub_environments_path = self._data_root / "_newhorizons_hub_environments.json"
        self._nicknames = self._load_nicknames()
        self._device_groups = self._load_device_groups()
        self._hub_channel_watcher = HubChannelWatcher(path=self._hub_environments_path)
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
                self._app_event_seq.pop(device_uid, None)
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
        if enabled:
            self._ensure_app_event_poller()
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
            device_name.startswith(DEFAULT_DEVICE_NAME_PREFIXES)
            and len(device_uid) == 12
            and device_uid.endswith(device_name.rsplit("-", 1)[-1].strip().upper())
            and not device_name.endswith(device_uid)
        ):
            return "{}{}".format(DEFAULT_DEVICE_NAME_PREFIX, device_uid)
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

    def list_hub_environments(self) -> list[dict[str, Any]]:
        # Enriches each environment with its members' self-reported
        # channels and whether any two *online* members currently share
        # one -- see hub_channel_watch.py's header comment for why this is
        # detection-only (no channel assignment is attempted).
        with self._lock:
            environments = self._hub_channel_watcher.list_environments()
            result: list[dict[str, Any]] = []
            for env in environments:
                hub_ids = env.get("hub_ids") or []
                hubs: list[dict[str, Any]] = []
                channel_members: dict[int, list[str]] = {}
                for gateway_id in hub_ids:
                    channel = self._hub_channel_watcher.channel_for(gateway_id)
                    online = str(self._gateways.get(gateway_id, {}).get("status") or "") == "online"
                    hubs.append({"gateway_id": gateway_id, "channel": channel, "online": online})
                    if online and channel:
                        channel_members.setdefault(channel, []).append(gateway_id)
                conflicting_channels = sorted(ch for ch, members in channel_members.items() if len(members) > 1)
                result.append({
                    **env,
                    "hubs": hubs,
                    "conflict": bool(conflicting_channels),
                    "conflicting_channels": conflicting_channels,
                })
            return result

    def create_hub_environment(self, name: str) -> dict[str, Any]:
        return self._hub_channel_watcher.create_environment(name)

    def delete_hub_environment(self, environment_id: str) -> bool:
        deleted = self._hub_channel_watcher.delete_environment(environment_id)
        if deleted:
            self._resync_hub_environment_fields_locked()
        return deleted

    def set_hub_environment(self, gateway_id: str, environment_id: str | None) -> None:
        self._hub_channel_watcher.set_hub_environment(gateway_id, environment_id)
        self._resync_hub_environment_fields_locked()

    def _resync_hub_environment_fields_locked(self) -> None:
        # Keeps gateway_snapshot()'s "channel_environment_id" field in sync
        # for any Hub that's currently connected -- admin-facing UI reads
        # gateway state from there, not from a separate environments call.
        updated: list[dict[str, Any]] = []
        with self._lock:
            for gateway_id, entry in self._gateways.items():
                environment_id = self._hub_channel_watcher.hub_environment(gateway_id) or ""
                if entry.get("channel_environment_id") != environment_id:
                    entry["channel_environment_id"] = environment_id
                    updated.append(dict(entry))
        for item in updated:
            self._emit_event({"type": "gateway_update", "item": item})

    def report_hub_channel(self, gateway_id: str, channel: int) -> None:
        self._hub_channel_watcher.report_channel(gateway_id, channel)

    def list_hub_lan_devices(self, gateway_id: str) -> list[dict[str, Any]]:
        # Real-hardware finding (see the plan's Step 5b section): a Hub
        # trying to discover nearby devices via its own local UDP
        # findme_probe broadcast got nothing back on a network with client
        # isolation between WiFi STA clients -- but every device already
        # reports its presence to this Backend via its own (device-
        # initiated, unaffected by that isolation) attach flow. So instead
        # of the Hub scanning the LAN itself, it asks the Backend for the
        # same device list `/api/devices` already exposes, filtered to
        # devices not already on this Hub's own gateway_id.
        gateway_id = str(gateway_id or "").strip()
        with self._lock:
            items = [self._decorate_device_entry(self._devices[key]) for key in sorted(self._devices.keys())]
        result: list[dict[str, Any]] = []
        for item in items:
            device_uid = str(item.get("device_uid") or "").strip()
            if not device_uid:
                continue
            # "Already on this Hub" only counts while the device is
            # actually routed through it (transport_path=="gateway_wss").
            # gateway_id alone isn't enough to exclude on: it's left over
            # from the last gateway_wss attach and doesn't get cleared
            # when a device later switches to a direct transport (arduino_udp/
            # udp) -- found on real hardware testing "取消" then rescanning,
            # which would otherwise wrongly hide the very device the scan
            # is supposed to surface.
            if (
                gateway_id
                and str(item.get("gateway_id") or "") == gateway_id
                and str(item.get("transport_path") or "") == "gateway_wss"
            ):
                continue
            result.append({
                "device_uid": device_uid,
                "device_name": str(item.get("display_name") or item.get("device_name") or ""),
                "transport_path": str(item.get("transport_path") or ""),
                "gateway_id": str(item.get("gateway_id") or ""),
                "mode": str(item.get("mode") or ""),
            })
        return result

    def migrate_device_to_hub(self, device_uid: str, hub_mac: str) -> dict[str, Any]:
        # Counterpart to list_hub_lan_devices(): relays the migration
        # commands through this Backend's already-working command-dispatch
        # path (publish_command(), the same one the REST device-command
        # API uses) instead of having the Hub send them directly to the
        # device over WiFi/UDP -- that direction is the one found blocked
        # on real hardware.
        device_uid = self._resolve_known_device_uid(device_uid)
        hub_mac = str(hub_mac or "").strip()
        if not hub_mac:
            raise ValueError("hub_mac_required")
        self.publish_command(device_uid, {
            "command": "set_transport",
            "request_id": uuid.uuid4().hex,
            "mode": "espnow",
            "hub_mac": hub_mac,
        })
        # Give the device a moment to apply + persist the transport change
        # before telling it to reboot into it -- mirrors the same
        # set_transport-then-delay-then-reboot sequencing the Hub's own
        # (now-removed) direct UDP migration code used.
        time.sleep(0.2)
        self.publish_command(device_uid, {
            "command": "reboot",
            "request_id": uuid.uuid4().hex,
        })
        return {"status": "queued", "device_uid": device_uid}

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

    def publish_gateway_command(self, gateway_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        # Counterpart to publish_command() above, but targets a Hub/Gateway
        # process itself rather than a downstream device_uid -- much
        # simpler since there's exactly one transport (the Hub/Gateway's
        # own WS session, already tracked in _gateway_session_senders for
        # gateway_claim_update/etc.) and no per-mode command gating.
        gateway_id = str(gateway_id or "").strip()
        if not gateway_id:
            raise ValueError("gateway_id_required")
        command = str(payload.get("command") or "")
        if command not in self.HUB_COMMANDS:
            raise ValueError("unknown_command")
        request_id = str(payload.get("request_id") or uuid.uuid4().hex)
        payload = dict(payload)
        payload["request_id"] = request_id
        with self._lock:
            sender = self._gateway_session_senders.get(gateway_id)
            if sender is None:
                raise RuntimeError(GATEWAY_CONTROL_UNAVAILABLE)
            message = {
                "type": "gateway_command",
                "request_id": request_id,
                "payload": payload,
            }
            try:
                sender(message)
            except Exception:
                self._gateway_session_senders.pop(gateway_id, None)
                raise RuntimeError(GATEWAY_CONTROL_UNAVAILABLE)
        return {
            "status": "queued",
            "transport": "gateway_wss",
            "gateway_id": gateway_id,
            "payload": payload,
            "request_id": request_id,
        }

    def record_gateway_command_result(self, gateway_id: str, payload: dict[str, Any]) -> None:
        # Inbound gateway_command_result -- much simpler than
        # _record_result() below since there's no device entry to merge
        # into, just a broadcast so the Desktop UI waiting on this
        # request_id can resolve it. ws.py's generic event listener
        # forwards any _emit_event() call to every connected browser
        # verbatim, so no new subscription plumbing is needed here.
        if not isinstance(payload, dict):
            return
        request_id = str(payload.get("request_id") or "")
        self._emit_event(
            {
                "type": "gateway_command_result",
                "gateway_id": str(gateway_id or ""),
                "request_id": request_id,
                "result": payload.get("result") if isinstance(payload.get("result"), dict) else {},
            }
        )

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

    def register_gateway(self, gateway_id: str, sender: Callable[[dict[str, Any]], None], payload: dict[str, Any] | None = None) -> str:
        gateway_id = str(gateway_id or "").strip() or "gateway-{}".format(id(sender))
        payload = dict(payload or {})
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._gateway_session_senders[gateway_id] = sender
            existing = dict(self._gateways.get(gateway_id, {}))
            # Sticky -- only the initial `hello` carries this (see
            # HubUplinkClient.cpp's hello construction); a real Gateway's
            # hello never sends it, so absence defaults to "gateway" for
            # backward compatibility. Previously there was no wire-level
            # self-identification at all, so every entry (Hub included)
            # silently defaulted to the Gateway name below.
            client_type = payload.get("client_type") or existing.get("client_type") or "gateway"
            default_name = "NHOS Hub" if client_type == "hub" else "NHOS Gateway"
            existing.update({
                "gateway_id": gateway_id,
                "gateway_name": payload.get("gateway_name") or payload.get("name") or existing.get("gateway_name") or default_name,
                "client_type": client_type,
                "mac": payload.get("mac", existing.get("mac", "")),
                "ip": payload.get("ip", existing.get("ip", "")),
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
                "channel_environment_id": self._hub_channel_watcher.hub_environment(gateway_id) or "",
                "channel": self._hub_channel_watcher.channel_for(gateway_id),
                "paired_devices": payload.get("paired_devices", existing.get("paired_devices", [])),
                # Hub only: its wall clock, which it serves to paired devices.
                "clock": payload.get("clock", existing.get("clock")),
                # Hub only: its firmware update state (OtaManager status).
                "update": payload.get("update", existing.get("update")),
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
        # New Horizons Hub only (a Gateway never sends this) -- piggybacked
        # on this same heartbeat rather than a separate request/response,
        # see hub_channel_watch.py's header comment.
        self._hub_channel_watcher.report_channel(gateway_id, payload.get("channel") or 0)
        self.register_gateway(
            gateway_id,
            self._gateway_session_senders.get(gateway_id, lambda _payload: None),
            {
                "gateway_name": payload.get("gateway_name"),
                "version": payload.get("version", ""),
                "mac": payload.get("mac", ""),
                "ip": payload.get("ip", ""),
                "enabled": bool(payload.get("enabled", True)),
                "target_mode": payload.get("target_mode"),
                "server_url": payload.get("server_url"),
                "local_ports": local_ports,
                "upstream": payload.get("upstream", {}),
                "denied_devices": denied,
                "udp_forwarded": forwarded,
                "udp_dropped": dropped,
                "last_error": payload.get("last_error", ""),
                "paired_devices": payload.get("paired_devices", []),
                "clock": payload.get("clock"),
                "update": payload.get("update"),
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
            # Which kind of client is currently relaying this device --
            # "hub" (New Horizons Hub, ESP-NOW) or "gateway" (New Horizons
            # Gateway software). Resolved from the serving gateway_id's own
            # entry rather than anything the device itself reports, since a
            # device has no notion of what's relaying it.
            "client_type": self._gateways.get(gateway_id, {}).get("client_type", ""),
            "gateway_connected": bool(connected),
            "last_gateway_seen_at": seen_at,
            "gateway_state": gateway_state,
            # A Hub is not a FindMe gateway: its snapshot would say "attached"
            # while the device's own status says "idle", and the two writers
            # took turns (the FindMe card flickered every few seconds). The
            # Hub's view of the device lives in gateway_state instead.
            "findme": None
            if self._gateways.get(gateway_id, {}).get("client_type") == "hub"
            else {k: v for k, v in findme_state.items() if v not in (None, "")},
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
        # A Gateway/Hub heartbeat only relays its own cached view of this
        # device's mode, on its own independent cadence -- it is never
        # fresher than the device's own direct status/result reports. If we
        # already have a recent-enough direct-sourced mode, keep it instead
        # of taking whatever this relayed snapshot says (regardless of
        # which of normal/maintenance/safe_maintenance/safemaintenance
        # either side is asserting) -- otherwise the two independently-
        # cadenced writers keep re-asserting their own value for the same
        # device and the merged mode (and the Desktop UI) flickers
        # continuously between them. See _has_fresh_direct_mode_locked().
        if mode and self._has_fresh_direct_mode_locked(existing, seen_at):
            mode = existing.get("mode")
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
        elif existing and (
            not existing.get("gateway_id")
            or not gateway_id
            or existing.get("gateway_id") == gateway_id
        ):
            # A disconnected/stale report only updates the display if it
            # comes from the current owner (existing.gateway_id ==
            # gateway_id), if there's no recorded owner yet to protect
            # (existing.gateway_id empty -- e.g. a device only seen so far
            # via a direct result/findme path that never set gateway_id),
            # or if it's an explicit "no owner" clear (gateway_id=="", used
            # by delete_gateway()/unregister_gateway_sender() when the
            # owning gateway/hub itself just went away). What this blocks
            # is specifically a *different*, still-registered gateway/hub
            # overwriting a live owner's entry with its own stale view --
            # that used to also be let through whenever the display wasn't
            # already "disconnected", which let a stale, long-departed
            # gateway/hub keep re-flipping the display back to itself on
            # every heartbeat.
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
                # Clear its reported channel immediately -- an offline Hub
                # can't be holding a live collision against anyone.
                self._hub_channel_watcher.clear_channel(gateway_id)
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

    def record_gateway_result_chunk(self, device_uid: str, payload: dict[str, Any]) -> None:
        """One page of a reply a Hub relays in pieces.

        The Hub forwards each page of the device's paged reply as it arrives
        (`page` is the device's own result_chunk envelope). Once every page
        is in, the joined reply is recorded like any single-frame result.
        """
        page = payload.get("page") if isinstance(payload.get("page"), dict) else {}
        assembled = self._result_chunks.add({
            "device_uid": device_uid,
            "request_id": payload.get("request_id"),
            "chunk": page.get("chunk"),
            "chunks": page.get("chunks"),
            "data": page.get("data"),
        })
        if assembled is None:
            return
        result = normalize_device_result(assembled["payload"], fallback_command=str(payload.get("command") or ""))
        result["device_uid"] = device_uid
        result["request_id"] = assembled["request_id"]
        for key in ("gateway_id", "transport_path"):
            if payload.get(key):
                result[key] = payload[key]
        self._record_result(device_uid, result)

    def record_gateway_packet(self, payload: bytes) -> None:
        self._handle_udp_datagram(payload, ("gateway", 0))

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
            if merged.get("mode"):
                merged["last_direct_mode_at"] = payload.get("received_at")
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

    # -- app event capture --------------------------------------------------
    #
    # This is the one place the backend sends commands on its own initiative.
    # It earns that because it already owns the recording's lifecycle: the
    # frontend cannot be the one polling, since closing the tab would silently
    # stop capturing events half way through a session.
    APP_EVENT_POLL_SEC = 0.5

    def _ensure_app_event_poller(self) -> None:
        if self._mock_mode:
            return
        if self._app_event_thread is not None and self._app_event_thread.is_alive():
            return
        self._app_event_stop.clear()
        self._app_event_thread = threading.Thread(
            target=self._app_event_loop, name="newhorizons-app-events", daemon=True
        )
        self._app_event_thread.start()

    def _app_event_loop(self) -> None:
        while not self._app_event_stop.wait(self.APP_EVENT_POLL_SEC):
            with self._lock:
                recording = sorted(self._recording_enabled)
            if not recording:
                # Nothing to capture; the thread parks itself rather than
                # polling devices nobody is recording.
                return
            for device_uid in recording:
                since = self._app_event_seq.get(device_uid, 0)
                try:
                    # quiet: polled, so the device skips its LED ack (v1.7.2+).
                    self.publish_command(device_uid, {"command": "app_events", "since_seq": since,
                                                      "quiet": True})
                except RuntimeError:
                    # Offline, booting, or the firmware predates app_events.
                    # Not an error worth surfacing on every tick.
                    continue

    def _capture_app_events(self, device_uid: str, payload: dict[str, Any]) -> None:
        """Write an app_events result into the recording's sidecar."""
        with self._lock:
            if device_uid not in self._recording_enabled:
                return
            sample_path = self._csv_paths.get(device_uid)
        if sample_path is None:
            return

        data = payload.get("data")
        if not isinstance(data, dict):
            return
        events = data.get("events")
        if not isinstance(events, list):
            return

        try:
            device_seq = int(data.get("seq") or 0)
        except (TypeError, ValueError):
            device_seq = 0
        previous = self._app_event_seq.get(device_uid, 0)
        if previous and device_seq < previous:
            # The device restarted and its sequence began again. Keeping the old
            # high-water mark would filter out every new event from now on.
            previous = 0
            self._app_event_seq[device_uid] = 0

        try:
            written = append_events(sample_path, events)
            # Not data["dropped"]: that is cumulative since boot and would mark
            # a loss on every poll once the ring had wrapped even once.
            lost = events_lost_since(previous, device_seq, events)
            if lost:
                append_dropped_marker(sample_path, previous, lost)
        except OSError:
            # A failed sidecar write must never interrupt the sample recording,
            # which is the thing actually being measured.
            return

        highest = 0
        for event in events:
            if isinstance(event, dict):
                try:
                    highest = max(highest, int(event.get("seq") or 0))
                except (TypeError, ValueError):
                    continue
        if highest:
            self._app_event_seq[device_uid] = highest
        elif device_seq > previous:
            # Nothing returned but the device moved on (first poll, or all of it
            # rolled off): advance, or the same loss is counted again next poll.
            self._app_event_seq[device_uid] = device_seq

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
        if str(payload.get("command") or "") == "app_events":
            self._capture_app_events(device_uid, payload)
        if str(payload.get("command") or "") == "commands":
            self._record_command_catalog(device_uid, payload)
        self._mark_relayed_update_started(payload)
        is_status_snapshot = self._is_status_snapshot_result(payload)
        calibration_status = self._calibration_status_from_result(payload)
        inner = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        entry_payload = dict(payload)
        if is_status_snapshot and inner:
            # Gateway-relayed Arduino control results retain the firmware's
            # full status under `data`. Use its identity fields when the
            # result envelope omits them, rather than transiently falling
            # back to the bare UID in the device list.
            for key in (
                "device_name", "mode", "firmware_version", "hardware_model",
                "matrix_shape", "findme", "runtime", "logging", "system",
            ):
                if entry_payload.get(key) in (None, "") and key in inner:
                    entry_payload[key] = inner[key]
        entry = self._normalize_device_entry(device_uid, entry_payload, kind="result")
        with self._lock:
            purged_aliases = self._purge_short_aliases_locked(device_uid)
            previous_mode = self._known_mode_from_status_locked(device_uid)
            self._latest_result[device_uid] = payload
            existing = self._devices.get(device_uid, {})
            merged = self._merge_device_entry(existing, entry)
            merged["last_result"] = payload
            if is_status_snapshot:
                # Firmware wraps all status fields under a "data" key
                # (e.g. {"ok":true,"cmd":"status","data":{"wifi":{...},...}}).
                # The frontend reads flat fields (status.wifi, status.battery …),
                # matching the heartbeat/stream path.  Hoist the inner "data"
                # dict to the top level so both paths produce the same shape.
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
            elif calibration_status is not None and self._latest_status.get(device_uid):
                # calibration_* replies carry the whole calibration status;
                # without this the device snapshot kept the state from the
                # last `status` poll, and the page reverted to it.
                status_payload = dict(self._latest_status[device_uid])
                status_payload["calibration"] = calibration_status
                self._latest_status[device_uid] = status_payload
                merged["last_status"] = status_payload
            self._clear_incompatible_visualization_locked(device_uid, merged)
            if merged.get("mode"):
                merged["last_direct_mode_at"] = payload.get("received_at")
            self._devices[device_uid] = merged
            if is_status_snapshot:
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
        if is_status_snapshot or str(payload.get("command") or "") == "capabilities":
            self._maybe_fetch_command_catalog(device_uid, payload)

    # -- device command catalogs (firmware v1.15.0+) -------------------------
    #
    # The second place the backend sends a command on its own: one `commands`
    # per device and firmware version, the first time a status shows it.

    @staticmethod
    def _result_data(payload: dict[str, Any]) -> dict[str, Any]:
        # Relayed results keep the firmware's data under "data"; the direct
        # TCP path (_record_arduino_response) flattens it into the envelope.
        data = payload.get("data")
        return data if isinstance(data, dict) else payload

    def _device_firmware_version(self, device_uid: str, payload: dict[str, Any]) -> str:
        data = self._result_data(payload)
        for source in (data, payload):
            version = str(source.get("firmware_version") or "")
            if version:
                return version
        with self._lock:
            status = self._latest_status.get(device_uid) or {}
            device = self._devices.get(device_uid) or {}
        return str(status.get("firmware_version") or device.get("firmware_version") or "")

    def _maybe_fetch_command_catalog(self, device_uid: str, payload: dict[str, Any]) -> None:
        if self._mock_mode:
            return
        data = self._result_data(payload)
        if "command_schema_hash" in data:
            self._command_catalogs.invalidate_if_hash_differs(device_uid, data.get("command_schema_hash"))
        firmware = self._device_firmware_version(device_uid, payload)
        if not self._command_catalogs.needs_fetch(device_uid, firmware):
            return
        self._command_catalogs.mark_requested(device_uid, firmware)
        # Not inline: on the direct TCP path this runs inside publish_command.
        threading.Thread(
            target=self._fetch_command_catalog,
            args=(device_uid,),
            name="newhorizons-command-catalog",
            daemon=True,
        ).start()

    def _fetch_command_catalog(self, device_uid: str) -> None:
        try:
            # quiet: the user did not ask for this, so no LED ack.
            self.publish_command(device_uid, {"command": "commands", "quiet": True})
        except RuntimeError:
            # Offline or booting; the next status after CATALOG_RETRY_SEC asks again.
            pass

    def _record_command_catalog(self, device_uid: str, payload: dict[str, Any]) -> None:
        if payload.get("ok") is False or str(payload.get("status") or "ok").lower() == "error":
            return
        firmware = self._device_firmware_version(device_uid, {})
        self._command_catalogs.record(device_uid, firmware, self._result_data(payload))

    def device_command_names(self, device_uid: str) -> set[str] | None:
        """Commands a user may send this device, per its catalog; None without one."""
        return self._command_catalogs.public_names(self._resolve_known_device_uid(device_uid))

    def device_command_catalog(self, device_uid: str) -> dict[str, Any] | None:
        catalog = self._command_catalogs.get(self._resolve_known_device_uid(device_uid))
        if catalog is None:
            return None
        result = catalog.as_json()
        result["commands"] = [item for item in result["commands"] if not item.get("internal")]
        return result

    CALIBRATION_STATUS_KEYS = (
        "enabled", "mode_active", "session_active", "complete", "tare_complete",
        "tare_enabled", "output_mode",
        "tare", "draft_tare", "levels", "draft_levels", "fit", "draft_fit", "fit_settings", "metadata",
    )

    @classmethod
    def _calibration_status_from_result(cls, payload: dict[str, Any]) -> dict[str, Any] | None:
        """The calibration status a calibration_* reply carries, if any.

        Most calibration commands answer with the firmware's full calibration
        statusJson (under `data` on the gateway path, flattened on the TCP
        path); the capture and dump commands answer with other shapes and are
        left out by the key check.
        """
        if not str(payload.get("command") or "").startswith("calibration_"):
            return None
        if str(payload.get("status") or "").lower() == "error" or payload.get("ok") is False:
            return None
        source = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        if not all(key in source for key in ("enabled", "session_active", "tare_complete", "levels")):
            return None
        return {key: source[key] for key in cls.CALIBRATION_STATUS_KEYS if key in source}

    @staticmethod
    def _is_status_snapshot_result(payload: dict[str, Any]) -> bool:
        # Delivery/transport failures often reuse command="status" (the
        # original request). They must not replace last_status with an
        # error envelope (empty of wifi/battery/firmware_version).
        message = str(payload.get("message") or "")
        if message in (
            "command_delivery_timeout",
            "command_expired",
            "device_not_connected_to_gateway",
            "switch_command_delivery_timeout",
        ):
            return False
        status = str(payload.get("status") or "").lower()
        if status == "error" or payload.get("ok") is False:
            return False
        command = str(payload.get("command") or "")
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
        device_epoch_ms = payload.get("device_epoch_ms")
        if isinstance(device_epoch_ms, int):
            return device_epoch_ms
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

    @staticmethod
    def _csv_time_ref(payload: dict[str, Any]) -> str:
        """Which clock timestamp_ms came from: the device's own synced clock
        ("device"), or -- before the device had a wall clock -- when the
        backend received the frame ("received"), which carries network and
        relay delay. Mirrors _csv_timestamp_ms()'s choice."""
        return "device" if isinstance(payload.get("device_epoch_ms"), int) else "received"

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
                    # Appended rather than inserted: a positional reader written
                    # against an older export keeps working. This is the device's
                    # own frame.seq, and app events carry the same number, so the
                    # sample file and the .events.csv sidecar join on it.
                    + ["frame_seq"]
                    # Appended for the same reason: see _csv_time_ref().
                    + ["time_ref"]
                )
            writer.writerow(
                [timestamp]
                + pressures
                + (list(raw_adc) if include_raw else [])
                + list(mag[:3])
                + list(gyro[:3])
                + list(acc[:3])
                + [int(payload.get("frame_id") or 0)]
                + [self._csv_time_ref(payload)]
            )

    @classmethod
    def _payload_is_live(cls, payload: dict[str, Any], kind: str) -> bool:
        """Whether this payload proves the device itself just answered."""
        if "live_seen" in payload:
            return bool(payload.get("live_seen"))
        if kind not in ("status", "result", "parsed"):
            return False
        if kind == "result":
            codes = {str(payload.get(key) or "") for key in ("message", "error")}
            if codes & cls.RELAY_FAILURE_CODES:
                return False
        return True

    def _normalize_device_entry(self, device_uid: str, payload: dict[str, Any], kind: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        received_at = str(payload.get("received_at") or now)
        system = payload.get("system") if isinstance(payload.get("system"), dict) else {}
        update_state = payload.get("update_state")
        if update_state is None and kind == "result":
            update_state = self._update_state_from_result(payload)
        # A payload that does not name the device -- a stream frame, most
        # command results -- leaves the name alone. Falling back to the UID
        # here renamed the device on every such payload, and the next status
        # named it back: a readout polling once a second made every device
        # list flip between "NHOS-<UID>" and "<UID>". None is skipped by
        # _merge_device_entry; a device never named is shown by its UID in
        # _decorate_device_entry.
        reported_name = str(payload.get("device_name") or system.get("name") or "")
        device_name = self._canonical_device_name(reported_name, device_uid) if reported_name else None
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
            "last_live_seen_at": received_at if self._payload_is_live(payload, kind) else None,
            "last_kind": kind,
            "last_status": self._latest_status.get(device_uid),
            "last_result": self._latest_result.get(device_uid),
            "recording_enabled": device_uid in self._recording_enabled,
            "recording_error": self._recording_errors.get(device_uid, ""),
        }

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

    # Blocks written by more than one source -- a relay's presence snapshot
    # and the device's own status -- each carrying a different subset of
    # keys (only the device knows its UDP port and heartbeat interval, only
    # the Gateway its claim). Replacing the whole block made those fields
    # appear and vanish on alternate updates, so they are merged key by key.
    # (The relay's snapshot drops its blank values before it gets here; the
    # device's own blanks are authoritative and do clear a field.)
    MERGED_DEVICE_BLOCKS = ("findme", "gateway_state")

    @classmethod
    def _merge_device_entry(cls, existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
        merged = dict(existing)
        existing_mode = str(merged.get("mode") or "")
        incoming_mode = str(incoming.get("mode") or "")
        for key, value in incoming.items():
            if value is not None:
                if key == "update_state":
                    value = cls._merge_update_state(merged.get("update_state"), value, existing_mode, incoming_mode)
                elif key in cls.MERGED_DEVICE_BLOCKS and isinstance(value, dict) and isinstance(merged.get(key), dict):
                    value = {**merged[key], **value}
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




















_SERVICE: NewHorizonsService | None = None


def get_service(autostart: bool = False, mock_mode: bool | None = None) -> NewHorizonsService:
    global _SERVICE
    if _SERVICE is None:
        _SERVICE = NewHorizonsService(autostart=autostart, mock_mode=mock_mode)
    elif autostart:
        _SERVICE.start()
    return _SERVICE
