from __future__ import annotations

import json
import queue
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any

try:  # pragma: no cover - exercised in integration environments with Flask-Sock installed.
    from flask_sock import Sock
except Exception:  # pragma: no cover - keeps unit tests importable before dependency install.
    Sock = None  # type: ignore[assignment]

from .auth import AuthManager, AuthUser
from .service import NewHorizonsService, command_error_message
from .terminal import validate_device_command_payload


class _WsClient:
    CONTROL_QUEUE_SIZE = 128
    VISUALIZATION_IDLE_POLL_INTERVAL_SEC = 0.05
    VISUALIZATION_DEFAULT_FPS = 60
    VISUALIZATION_MAX_FPS = 60
    MAX_PENDING_VISUALIZATIONS = 64

    def __init__(self, hub: "WebSocketHub", ws: Any, user: AuthUser | None = None) -> None:
        self.hub = hub
        self.ws = ws
        self.user = user
        self.subscribed_visualizations: set[str] = set()
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=self.CONTROL_QUEUE_SIZE)
        self._visualization_lock = threading.Lock()
        self._visualization_pending: dict[str, dict[str, Any]] = {}
        self._visualization_last_sent_at: dict[str, float] = {}
        self._closed = threading.Event()
        self._wake_event = threading.Event()
        self._send_thread = threading.Thread(target=self._send_loop, name="newhorizons-ws-send", daemon=True)

    def start(self) -> None:
        self._send_thread.start()

    def close(self) -> None:
        self._closed.set()
        self.enqueue({"type": "_close"})

    def enqueue(self, event: dict[str, Any]) -> None:
        if self._closed.is_set():
            return
        if self._accepts_event(event):
            self._put_event(event)

    def _accepts_event(self, event: dict[str, Any]) -> bool:
        if event.get("type") != "visualization_update":
            return True
        device_uid = str(event.get("device_uid") or "")
        return bool(device_uid and device_uid in self.subscribed_visualizations)

    def _put_event(self, event: dict[str, Any]) -> None:
        if event.get("type") == "visualization_update":
            self._queue_visualization(event)
            return
        self._queue_control(event)

    def _queue_control(self, event: dict[str, Any]) -> None:
        while True:
            try:
                self._queue.put_nowait(event)
                self._wake_event.set()
                return
            except queue.Full:
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    return

    def _queue_visualization(self, event: dict[str, Any]) -> None:
        device_uid = str(event.get("device_uid") or "")
        if not device_uid:
            return
        with self._visualization_lock:
            if device_uid in self._visualization_pending:
                self.hub.note_coalesced_visualization()
            elif len(self._visualization_pending) >= self.MAX_PENDING_VISUALIZATIONS:
                try:
                    self._visualization_pending.pop(next(iter(self._visualization_pending)))
                    self.hub.note_dropped_visualization()
                except Exception:
                    pass
            self._visualization_pending[device_uid] = event
        self._wake_event.set()

    def _pop_visualization(self) -> dict[str, Any] | None:
        now = time.monotonic()
        with self._visualization_lock:
            if not self._visualization_pending:
                return None
            for key, event in list(self._visualization_pending.items()):
                last_sent_at = float(self._visualization_last_sent_at.get(key) or 0.0)
                interval_sec = self._visualization_interval_sec(event)
                if last_sent_at and now - last_sent_at < interval_sec:
                    continue
                if last_sent_at and now - last_sent_at < interval_sec * 4:
                    self._visualization_last_sent_at[key] = last_sent_at + interval_sec
                else:
                    self._visualization_last_sent_at[key] = now
                return self._visualization_pending.pop(key)
        return None

    def _visualization_wait_timeout(self) -> float:
        now = time.monotonic()
        with self._visualization_lock:
            if not self._visualization_pending:
                return self.VISUALIZATION_IDLE_POLL_INTERVAL_SEC
            next_wait = self.VISUALIZATION_IDLE_POLL_INTERVAL_SEC
            for key, event in self._visualization_pending.items():
                last_sent_at = float(self._visualization_last_sent_at.get(key) or 0.0)
                if not last_sent_at:
                    return 0.0
                due_at = last_sent_at + self._visualization_interval_sec(event)
                next_wait = min(next_wait, max(0.0, due_at - now))
            return next_wait

    @classmethod
    def _visualization_interval_sec(cls, event: dict[str, Any]) -> float:
        return 1.0 / cls._visualization_target_fps(event)

    @classmethod
    def _visualization_target_fps(cls, event: dict[str, Any]) -> float:
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        raw_value = event.get("target_fps") or data.get("target_fps") or cls.VISUALIZATION_DEFAULT_FPS
        try:
            fps = float(raw_value)
        except (TypeError, ValueError):
            fps = float(cls.VISUALIZATION_DEFAULT_FPS)
        fps = max(1.0, fps)
        return min(float(cls.VISUALIZATION_MAX_FPS), fps)

    def _send_loop(self) -> None:
        while not self._closed.is_set():
            try:
                event = self._queue.get_nowait()
            except queue.Empty:
                event = self._pop_visualization()
                if event is None:
                    self._wake_event.wait(self._visualization_wait_timeout())
                    self._wake_event.clear()
                    continue
            if event.get("type") == "_close":
                break
            try:
                self.ws.send(json.dumps(event, separators=(",", ":")))
                if event.get("type") == "visualization_update":
                    self.hub.note_sent_visualization()
            except Exception:
                self._closed.set()
                break


class WebSocketHub:
    def __init__(self, service: NewHorizonsService) -> None:
        self.service = service
        self._lock = threading.RLock()
        self._clients: set[_WsClient] = set()
        self._dropped_visualization = 0
        self._coalesced_visualization = 0
        self._sent_visualization = 0
        self._sent_visualization_window: deque[float] = deque()
        self.service.add_event_listener(self.broadcast)
        if hasattr(self.service, "set_websocket_stats_provider"):
            self.service.set_websocket_stats_provider(self.stats)

    def stats(self) -> dict[str, Any]:
        with self._lock:
            now = time.monotonic()
            self._purge_sent_window_locked(now)
            return {
                "clients": len(self._clients),
                "dropped_visualization": self._dropped_visualization,
                "ws_coalesced_frames": self._coalesced_visualization,
                "ws_sent_frames": self._sent_visualization,
                "ws_sent_fps": len(self._sent_visualization_window),
            }

    def note_dropped_visualization(self) -> None:
        with self._lock:
            self._dropped_visualization += 1

    def note_coalesced_visualization(self) -> None:
        with self._lock:
            self._coalesced_visualization += 1

    def note_sent_visualization(self) -> None:
        with self._lock:
            now = time.monotonic()
            self._sent_visualization += 1
            self._sent_visualization_window.append(now)
            self._purge_sent_window_locked(now)

    def _purge_sent_window_locked(self, now: float) -> None:
        cutoff = now - 1.0
        while self._sent_visualization_window and self._sent_visualization_window[0] < cutoff:
            self._sent_visualization_window.popleft()

    def broadcast(self, event: dict[str, Any]) -> None:
        event = self._with_visualization_target(event)
        with self._lock:
            clients = list(self._clients)
        for client in clients:
            client.enqueue(event)

    def _with_visualization_target(self, event: dict[str, Any]) -> dict[str, Any]:
        if event.get("type") != "visualization_update":
            return event
        device_uid = str(event.get("device_uid") or "")
        target_fps = self.service.visualization_target_fps(device_uid)
        data = dict(event.get("data") or {})
        data["target_fps"] = target_fps
        next_event = dict(event)
        next_event["target_fps"] = target_fps
        next_event["data"] = data
        return next_event

    def handle_socket(self, ws: Any, user: AuthUser | None) -> None:
        client = _WsClient(self, ws, user)
        with self._lock:
            self._clients.add(client)
        client.start()
        client.enqueue(
            {
                "type": "hello_ack",
                "server_time": datetime.now(timezone.utc).isoformat(),
                "transport_mode": "udp",
            }
        )
        client.enqueue({"type": "device_snapshot", "items": self.service.list_devices()})
        if self._role_allowed(client, "admin"):
            client.enqueue({"type": "gateway_snapshot", "items": self.service.gateway_snapshot()})
        try:
            while True:
                raw = ws.receive()
                if raw is None:
                    break
                try:
                    message = self._decode_json_message(raw)
                except Exception:
                    client.enqueue({"type": "error", "code": "invalid_json", "message": "Invalid JSON message"})
                    continue
                if isinstance(message, dict):
                    self._handle_message(client, message)
        finally:
            client.close()
            with self._lock:
                self._clients.discard(client)

    def _handle_message(self, client: _WsClient, message: dict[str, Any]) -> None:
        msg_type = str(message.get("type") or "").strip()
        if msg_type == "hello":
            client.enqueue(
                {
                    "type": "hello_ack",
                    "server_time": datetime.now(timezone.utc).isoformat(),
                    "transport_mode": "udp",
                }
            )
            return
        if msg_type == "ping":
            client.enqueue({"type": "pong", "server_time": datetime.now(timezone.utc).isoformat()})
            return
        if msg_type == "subscribe_devices":
            client.enqueue({"type": "device_snapshot", "items": self.service.list_devices()})
            return
        if msg_type == "subscribe_gateways":
            if not self._role_allowed(client, "admin"):
                client.enqueue({"type": "error", "code": "forbidden", "message": "forbidden"})
                return
            client.enqueue({"type": "gateway_snapshot", "items": self.service.gateway_snapshot()})
            return
        if msg_type == "subscribe_visualization":
            device_uid = str(message.get("device_uid") or "").strip()
            if device_uid:
                client.subscribed_visualizations.add(device_uid)
            items = self.service.latest_visualization(device_uid or None)
            client.enqueue({"type": "visualization_snapshot", "items": self._snapshot_with_targets(items)})
            return
        if msg_type == "unsubscribe_visualization":
            device_uid = str(message.get("device_uid") or "").strip()
            if device_uid:
                client.subscribed_visualizations.discard(device_uid)
            return
        if msg_type == "command":
            if not self._role_allowed(client, "admin"):
                client.enqueue({"type": "error", "code": "forbidden", "message": "forbidden"})
                return
            self._handle_command(client, message)
            return
        if msg_type == "recording_set":
            if not self._role_allowed(client, "admin"):
                client.enqueue({"type": "error", "code": "forbidden", "message": "forbidden"})
                return
            self._handle_recording_set(client, message)
            return
        client.enqueue({"type": "error", "code": "unknown_type", "message": "Unknown WebSocket message type"})

    @staticmethod
    def _role_allowed(client: _WsClient, *roles: str) -> bool:
        return bool(client.user is not None and client.user.role in roles)

    def _snapshot_with_targets(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for item in items:
            device_uid = str(item.get("device_uid") or item.get("dn") or "")
            target_fps = self.service.visualization_target_fps(device_uid)
            next_item = dict(item)
            next_item["target_fps"] = target_fps
            result.append(next_item)
        return result

    @staticmethod
    def _decode_json_message(raw: Any) -> dict[str, Any]:
        if isinstance(raw, (bytes, bytearray)):
            text = bytes(raw).decode("utf-8")
        else:
            text = str(raw)
        decoded = json.loads(text)
        if not isinstance(decoded, dict):
            raise ValueError("invalid_message")
        return decoded

    def _handle_command(self, client: _WsClient, message: dict[str, Any]) -> None:
        device_uid = str(message.get("device_uid") or "").strip()
        raw_payload = message.get("payload")
        if not device_uid:
            client.enqueue({"type": "error", "code": "device_uid_required", "message": "device_uid is required"})
            return
        if not isinstance(raw_payload, dict):
            client.enqueue({"type": "error", "code": "payload_required", "message": "payload is required"})
            return
        try:
            payload = validate_device_command_payload(raw_payload)
        except ValueError as exc:
            client.enqueue({"type": "error", "code": "invalid_command", "message": str(exc)})
            return
        request_id = str(message.get("request_id") or payload.get("request_id") or "")
        if request_id:
            payload["request_id"] = request_id
        try:
            queued = self.service.publish_command(device_uid, payload)
        except RuntimeError as exc:
            code = str(exc)
            client.enqueue({
                "type": "error",
                "code": code,
                "message": command_error_message(code),
                "device_uid": device_uid,
                "request_id": request_id,
            })
            return
        client.enqueue(
            {
                "type": "command_queued",
                "device_uid": device_uid,
                "request_id": queued.get("request_id") or request_id,
                "transport": queued,
            }
        )

    def _handle_recording_set(self, client: _WsClient, message: dict[str, Any]) -> None:
        device_uid = str(message.get("device_uid") or "").strip()
        if not device_uid:
            client.enqueue({"type": "error", "code": "device_uid_required", "message": "device_uid is required"})
            return
        enabled = bool(message.get("enabled"))
        result = self.service.set_recording_enabled(device_uid, enabled)
        client.enqueue({"type": "recording_update", **result})


def register_websocket_routes(
    app: Any,
    service: NewHorizonsService,
    auth_manager: AuthManager | None = None,
    url_prefix: str = "/newhorizons",
) -> WebSocketHub | None:
    if Sock is None:
        app.logger.warning("Flask-Sock is not installed; %s/ws is disabled", _normalize_url_prefix(url_prefix) or "")
        return None
    hub = WebSocketHub(service)
    sock = Sock(app)

    @sock.route(f"{_normalize_url_prefix(url_prefix)}/ws")
    def newhorizons_ws(ws: Any) -> None:
        user = auth_manager.current_user() if auth_manager is not None else None
        if auth_manager is not None and user is None:
            ws.send(json.dumps({"type": "error", "code": "unauthorized", "message": "unauthorized"}, separators=(",", ":")))
            return
        hub.handle_socket(ws, user)

    return hub


def _normalize_url_prefix(value: str) -> str:
    normalized = "/" + str(value or "").strip().strip("/")
    return "" if normalized == "/" else normalized
