from __future__ import annotations

import csv
import os
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .app_event_log import append_dropped_marker, append_events, events_lost_since
from .device_commands import (
    HUB_COMMANDS,
    INTERNAL_DEVICE_COMMANDS,
    KNOWN_DEVICE_COMMANDS,
    MAINTENANCE_COMMANDS,
    MODE_COMMANDS,
    NORMAL_COMMANDS,
    SHARED_COMMANDS,
    STATUS_COMMANDS,
    CommandCatalogStore,
)
from .discovery import DiscoveryResponder
from .hub_channel_watch import HubChannelWatcher
from .result_chunks import ResultChunkReassembler
from .service_constants import (  # noqa: F401  (re-exported for api.py / ws.py)
    DEVICE_BOOTING,
    DEVICE_CONTROL_UNAVAILABLE,
    GATEWAY_CONTROL_UNAVAILABLE,
    command_error_message,
)
from .udp_ingest import UDPIngestServer

# NewHorizonsService is split by concern into mixins. They share the
# service's one lock and its state, and none has an __init__ of its own.
from .arduino_response import ArduinoResponseMixin
from .command_gating import CommandGatingMixin
from .datagram_ingest import DatagramIngestMixin
from .device_identity import DeviceIdentityMixin
from .device_labels import DeviceLabelsMixin
from .gateway_registry import GatewayRegistryMixin
from .mock_device import MockDeviceMixin
from .update_state import UpdateStateMixin


class NewHorizonsService(
    MockDeviceMixin,
    UpdateStateMixin,
    CommandGatingMixin,
    GatewayRegistryMixin,
    ArduinoResponseMixin,
    DeviceIdentityMixin,
    DeviceLabelsMixin,
    DatagramIngestMixin,
):
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
    # Which commands exist and which mode they may run in, without a device
    # catalog (device_commands.py). Class attributes too: tests and cls.X read them.
    STATUS_COMMANDS = STATUS_COMMANDS
    SHARED_COMMANDS = SHARED_COMMANDS
    NORMAL_COMMANDS = NORMAL_COMMANDS
    MAINTENANCE_COMMANDS = MAINTENANCE_COMMANDS
    MODE_COMMANDS = MODE_COMMANDS
    HUB_COMMANDS = HUB_COMMANDS
    INTERNAL_DEVICE_COMMANDS = INTERNAL_DEVICE_COMMANDS
    KNOWN_DEVICE_COMMANDS = KNOWN_DEVICE_COMMANDS

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
        # The app-event poller parks only once recording stops; without this
        # it kept polling a device after the service itself was stopped.
        self._app_event_stop.set()
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

    def publish_command(self, device_uid: str, payload: dict[str, Any]) -> dict[str, Any]:
        device_uid = self._resolve_known_device_uid(device_uid)
        payload = self._with_command_expiry(payload)
        # Every command needs a request_id, including the ones the backend
        # sends on its own (the catalog fetch, app_events polling): a reply a
        # Hub relays in pages is joined by request_id, and pages without one
        # were dropped -- so `commands` (~19 KB) never arrived through a Hub.
        if not str(payload.get("request_id") or ""):
            payload["request_id"] = uuid.uuid4().hex
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
        elif str(payload.get("command") or "") == "capabilities" and self._result_failed(payload):
            # A probe a relay could not deliver (another command in flight):
            # let the next ask probe again instead of waiting out the interval.
            self._command_catalogs.forget_probe(device_uid)
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
        # check_update / apply_update replies carry the device's update_state.
        update_result_state = None
        if str(payload.get("command") or "") in ("check_update", "apply_update"):
            nested = inner.get("update_state") if isinstance(inner.get("update_state"), dict) else payload.get("update_state")
            if isinstance(nested, dict):
                update_result_state = nested
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
            elif update_result_state is not None and self._latest_status.get(device_uid):
                # The update card reads the last status first. Without this an
                # Apply through a Hub kept showing the "ready" the previous
                # Check's status left there, so the card never noticed the
                # transfer running and never polled its progress.
                status_payload = dict(self._latest_status[device_uid])
                status_payload["update_state"] = self._merge_update_state(
                    status_payload.get("update_state"), update_result_state)
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
        return str(status.get("firmware_version") or device.get("firmware_version")
                   or self._command_catalogs.firmware(device_uid) or "")

    def _maybe_fetch_command_catalog(self, device_uid: str, payload: dict[str, Any]) -> None:
        if self._mock_mode:
            return
        data = self._result_data(payload)
        if "command_schema_hash" in data:
            self._command_catalogs.invalidate_if_hash_differs(device_uid, data.get("command_schema_hash"))
        firmware = self._device_firmware_version(device_uid, payload)
        self._command_catalogs.note_firmware(device_uid, firmware)
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
            # Not sent (offline, booting): the next status or ask tries again.
            self._command_catalogs.forget_request(device_uid)

    @staticmethod
    def _result_failed(payload: dict[str, Any]) -> bool:
        return payload.get("ok") is False or str(payload.get("status") or "ok").lower() == "error"

    def _probe_firmware_version(self, device_uid: str) -> None:
        try:
            self.publish_command(device_uid, {"command": "capabilities", "quiet": True})
        except RuntimeError:
            self._command_catalogs.forget_probe(device_uid)

    def _record_command_catalog(self, device_uid: str, payload: dict[str, Any]) -> None:
        if self._result_failed(payload):
            # Undelivered (a relay busy with another command, a page timeout):
            # retry on the next status or ask, not after CATALOG_RETRY_SEC.
            self._command_catalogs.forget_request(device_uid)
            return
        firmware = self._device_firmware_version(device_uid, {})
        self._command_catalogs.record(device_uid, firmware, self._result_data(payload))

    def device_command_names(self, device_uid: str) -> set[str] | None:
        """Commands a user may send this device, per its catalog; None without one."""
        return self._command_catalogs.public_names(self._resolve_known_device_uid(device_uid))

    def device_command_catalog(self, device_uid: str) -> dict[str, Any] | None:
        device_uid = self._resolve_known_device_uid(device_uid)
        catalog = self._command_catalogs.get(device_uid)
        if catalog is None:
            # Asked for before any status triggered a fetch (the Terminal page
            # polls no status): fetch now, from the firmware last seen, so the
            # page's next ask finds it. Right after a backend restart a device
            # behind a Hub has no known firmware yet (the Hub's heartbeats do
            # not carry it): ask with a small `capabilities`, whose reply
            # carries the version and goes on to fetch the catalog.
            if self._device_firmware_version(device_uid, {}):
                self._maybe_fetch_command_catalog(device_uid, {})
            elif not self._mock_mode and self._command_catalogs.needs_probe(device_uid):
                threading.Thread(
                    target=self._probe_firmware_version,
                    args=(device_uid,),
                    name="newhorizons-command-catalog",
                    daemon=True,
                ).start()
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
