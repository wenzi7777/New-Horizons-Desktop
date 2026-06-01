from __future__ import annotations

import json
import queue
import threading
from datetime import datetime, timezone
from typing import Any

from flask import request

try:  # pragma: no cover - depends on runtime package.
    from flask_sock import Sock
except Exception:  # pragma: no cover
    Sock = None  # type: ignore[assignment]

from .auth import AuthManager, AuthUser
from .service import NewHorizonsService


class _StreamClient:
    QUEUE_SIZE = 256

    def __init__(self, hub: "StreamHub", ws: Any, user: AuthUser) -> None:
        self.hub = hub
        self.ws = ws
        self.user = user
        self.subscribed_device_uids: set[str] = set()
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=self.QUEUE_SIZE)
        self._closed = threading.Event()
        self._send_thread = threading.Thread(target=self._send_loop, name="newhorizons-stream-ws-send", daemon=True)

    def start(self) -> None:
        self._send_thread.start()

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        while True:
            try:
                self._queue.put_nowait({"type": "_close"})
                return
            except queue.Full:
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    return

    def enqueue(self, event: dict[str, Any]) -> None:
        if self._closed.is_set():
            return
        while True:
            try:
                self._queue.put_nowait(event)
                return
            except queue.Full:
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    return

    def _send_loop(self) -> None:
        while True:
            event = self._queue.get()
            if event.get("type") == "_close":
                return
            try:
                self.ws.send(json.dumps(event, separators=(",", ":")))
            except Exception:
                self._closed.set()
                return


class StreamHub:
    def __init__(self, service: NewHorizonsService) -> None:
        self.service = service
        self._lock = threading.RLock()
        self._clients: set[_StreamClient] = set()
        self.service.add_event_listener(self._handle_service_event)

    def close(self) -> None:
        self.service.remove_event_listener(self._handle_service_event)

    def handle_socket(self, ws: Any, user: AuthUser) -> None:
        client = _StreamClient(self, ws, user)
        with self._lock:
            self._clients.add(client)
        client.start()
        client.enqueue(self._hello_event(user))
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
                self._handle_message(client, message)
        finally:
            for device_uid in list(client.subscribed_device_uids):
                client.enqueue({"type": "stream_ended", "device_uid": device_uid})
            client.close()
            with self._lock:
                self._clients.discard(client)

    def _handle_message(self, client: _StreamClient, message: dict[str, Any]) -> None:
        msg_type = str(message.get("type") or "").strip()
        if msg_type == "ping":
            client.enqueue({"type": "pong", "server_time": datetime.now(timezone.utc).isoformat()})
            return
        if msg_type == "subscribe":
            device_uid = self._normalize_device_uid(message.get("device_uid"))
            if not device_uid:
                client.enqueue({"type": "error", "code": "device_uid_required", "message": "device_uid is required"})
                return
            client.subscribed_device_uids.add(device_uid)
            client.enqueue({"type": "subscribed", "device_uid": device_uid})
            items = self.service.latest_visualization(device_uid)
            if items:
                client.enqueue({"type": "snapshot", "device_uid": device_uid, "data": self._stream_payload(items[0])})
            return
        if msg_type == "unsubscribe":
            device_uid = self._normalize_device_uid(message.get("device_uid"))
            if not device_uid:
                client.enqueue({"type": "error", "code": "device_uid_required", "message": "device_uid is required"})
                return
            if device_uid in client.subscribed_device_uids:
                client.subscribed_device_uids.discard(device_uid)
                client.enqueue({"type": "unsubscribed", "device_uid": device_uid})
                client.enqueue({"type": "stream_ended", "device_uid": device_uid})
            return
        client.enqueue({"type": "error", "code": "unknown_type", "message": "Unknown stream message type"})

    def _handle_service_event(self, event: dict[str, Any]) -> None:
        event_type = str(event.get("type") or "")
        if event_type == "visualization_update":
            device_uid = self._normalize_device_uid(event.get("device_uid"))
            if not device_uid:
                return
            data = event.get("data") if isinstance(event.get("data"), dict) else {}
            stream_event = {"type": "update", "device_uid": device_uid, "data": self._stream_payload(data)}
            with self._lock:
                clients = [client for client in self._clients if device_uid in client.subscribed_device_uids]
            for client in clients:
                client.enqueue(stream_event)
            return
        if event_type == "device_snapshot":
            items = event.get("items") if isinstance(event.get("items"), list) else []
            active = {
                self._normalize_device_uid(item.get("device_uid"))
                for item in items
                if isinstance(item, dict) and self._normalize_device_uid(item.get("device_uid"))
            }
            with self._lock:
                clients = list(self._clients)
            for client in clients:
                removed = [device_uid for device_uid in client.subscribed_device_uids if device_uid not in active]
                for device_uid in removed:
                    client.subscribed_device_uids.discard(device_uid)
                    client.enqueue({"type": "stream_ended", "device_uid": device_uid})

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

    @staticmethod
    def _normalize_device_uid(value: Any) -> str:
        return str(value or "").strip().upper()

    @staticmethod
    def _stream_payload(item: dict[str, Any]) -> dict[str, Any]:
        payload = dict(item)
        device_uid = str(payload.get("device_uid") or payload.get("dn") or "").strip().upper()
        if device_uid:
            payload["device_uid"] = device_uid
            payload["dn"] = device_uid
        payload.pop("device_id", None)
        return payload

    @staticmethod
    def _hello_event(user: AuthUser) -> dict[str, Any]:
        return {
            "type": "hello_ack",
            "server_time": datetime.now(timezone.utc).isoformat(),
            "username": user.username,
            "role": user.role,
            "transport_mode": "udp_stream",
        }


def register_stream_websocket_routes(
    app: Any,
    service: NewHorizonsService,
    auth_manager: AuthManager,
    url_prefix: str = "/newhorizons",
) -> StreamHub | None:
    if Sock is None:
        app.logger.warning("Flask-Sock is not installed; %s/stream/ws is disabled", _normalize_url_prefix(url_prefix) or "")
        return None
    hub = StreamHub(service)
    sock = Sock(app)

    @sock.route(f"{_normalize_url_prefix(url_prefix)}/stream/ws")
    def newhorizons_stream_ws(ws: Any) -> None:
        token = _token_from_request()
        user = auth_manager.authenticate_token(token, str(app.secret_key or ""))
        if user is None:
            ws.send(json.dumps({"type": "error", "code": "unauthorized", "message": "unauthorized"}, separators=(",", ":")))
            return
        hub.handle_socket(ws, user)

    return hub


def _token_from_request() -> str:
    auth_header = str(request.headers.get("Authorization") or "")
    if auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    return str(request.args.get("token") or "").strip()


def _normalize_url_prefix(value: str) -> str:
    normalized = "/" + str(value or "").strip().strip("/")
    return "" if normalized == "/" else normalized
