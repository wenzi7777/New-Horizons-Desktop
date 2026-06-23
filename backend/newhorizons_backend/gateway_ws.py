from __future__ import annotations

import base64
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import request

try:  # pragma: no cover - depends on optional runtime package.
    from flask_sock import Sock
except Exception:  # pragma: no cover
    Sock = None  # type: ignore[assignment]

from .gateway_auth import gateway_expected_token
from .service import NewHorizonsService


PACKET_TEXT_PREFIX = "NHPKT1:"


def latest_gateway_version() -> str:
    override = str(os.getenv("NEWHORIZONS_LATEST_GATEWAY_VERSION") or "").strip()
    if override:
        return override
    manifest_path = Path(__file__).resolve().parents[3] / "New-Horizons-Gateway" / "releases" / "gateway-latest.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        version = str(payload.get("version") or "").strip()
        if version:
            return version
    except Exception:
        pass
    return "v0.3.0"


def _token_from_request() -> str:
    auth_header = str(request.headers.get("Authorization") or "")
    if auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    return str(request.args.get("token") or "").strip()


def _payload_from_message(message: dict[str, Any]) -> dict[str, Any]:
    payload = message.get("payload")
    if isinstance(payload, dict):
        result = dict(payload)
    else:
        result = {key: value for key, value in message.items() if key not in ("type", "payload")}
    if message.get("device_uid") and "device_uid" not in result:
        result["device_uid"] = message.get("device_uid")
    return result


class GatewaySocketSession:
    def __init__(self, service: NewHorizonsService, ws: Any) -> None:
        self.service = service
        self.ws = ws
        self.gateway_id = ""
        self.sender = self.send_command
        self._send_lock = threading.RLock()

    def send_command(self, payload: dict[str, Any]) -> None:
        self._send_json(payload)

    def handle(self) -> None:
        self._send_json(
            {
                "type": "gateway_hello_ack",
                "server_time": datetime.now(timezone.utc).isoformat(),
                "transport_mode": "udp_gateway_wss",
                "latest_gateway_version": latest_gateway_version(),
            }
        )
        try:
            while True:
                raw = self.ws.receive()
                if raw is None:
                    break
                if isinstance(raw, str) and raw.startswith(PACKET_TEXT_PREFIX):
                    try:
                        self.service.record_gateway_packet(base64.b64decode(raw[len(PACKET_TEXT_PREFIX):]))
                    except Exception:
                        self._send_json({"type": "error", "code": "invalid_packet", "message": "Invalid gateway packet"})
                    continue
                if isinstance(raw, (bytes, bytearray)):
                    packet = bytes(raw)
                    if not packet.lstrip().startswith(b"{"):
                        self.service.record_gateway_packet(packet)
                        continue
                self._handle_json(raw)
        finally:
            self.service.unregister_gateway_sender(self.sender)

    def _handle_json(self, raw: Any) -> None:
        try:
            message = self._decode_json_message(raw)
        except Exception:
            self._send_json({"type": "error", "code": "invalid_json", "message": "Invalid gateway JSON"})
            return
        if not isinstance(message, dict):
            self._send_json({"type": "error", "code": "invalid_message", "message": "Gateway message must be an object"})
            return

        msg_type = str(message.get("type") or "").strip()
        if msg_type == "hello":
            self.gateway_id = str(message.get("gateway_id") or "")
            self.service.register_gateway(self.gateway_id, self.sender, message)
            self._send_json(
                {
                    "type": "gateway_hello_ack",
                    "gateway_id": self.gateway_id,
                    "server_time": datetime.now(timezone.utc).isoformat(),
                    "transport_mode": "udp_gateway_wss",
                    "latest_gateway_version": latest_gateway_version(),
                }
            )
            return
        if msg_type == "ping":
            self._send_json({"type": "pong", "server_time": datetime.now(timezone.utc).isoformat()})
            return
        if msg_type == "gateway_status":
            payload = _payload_from_message(message)
            gateway_id = str(message.get("gateway_id") or self.gateway_id or "")
            if gateway_id:
                if not self.gateway_id:
                    self.gateway_id = gateway_id
                self.service.record_gateway_summary(gateway_id, payload)
            return

        if msg_type == "gateway_claim_request":
            gateway_id = str(message.get("gateway_id") or self.gateway_id or "")
            if gateway_id:
                if not self.gateway_id:
                    self.gateway_id = gateway_id
                self.service.register_gateway(gateway_id, self.sender, message)
            try:
                claim = self.service.handle_gateway_claim_request(gateway_id, message)
            except ValueError as exc:
                self._send_json({"type": "gateway_claim_update", "state": "failed", "error": str(exc), "claim_id": message.get("claim_id", ""), "device_uid": message.get("device_uid", "")})
                return
            self._send_json({"type": "gateway_claim_update", **claim})
            return

        if msg_type in ("device_hello", "device_status", "device_update_progress"):
            payload = _payload_from_message(message)
            device_uid = str(message.get("device_uid") or payload.get("device_uid") or "").strip()
            if not device_uid:
                self._send_json({"type": "error", "code": "device_uid_required", "message": "device_uid is required"})
                return
            payload.setdefault("gateway_id", self.gateway_id)
            payload.setdefault("transport_path", "gateway_wss")
            self.service.register_gateway_device(device_uid, self.sender, gateway_id=self.gateway_id)
            self.service.record_gateway_status(device_uid, payload)
            return

        if msg_type == "device_result":
            payload = _payload_from_message(message)
            device_uid = str(message.get("device_uid") or payload.get("device_uid") or "").strip()
            if not device_uid:
                self._send_json({"type": "error", "code": "device_uid_required", "message": "device_uid is required"})
                return
            payload.setdefault("gateway_id", self.gateway_id)
            payload.setdefault("transport_path", "gateway_wss")
            self.service.register_gateway_device(device_uid, self.sender, gateway_id=self.gateway_id)
            self.service.record_gateway_result(device_uid, payload)
            return

        self._send_json({"type": "error", "code": "unknown_gateway_type", "message": "Unknown gateway message type"})

    def _send_json(self, payload: dict[str, Any]) -> None:
        with self._send_lock:
            self.ws.send(json.dumps(payload, separators=(",", ":")))

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


def register_gateway_websocket_routes(app: Any, service: NewHorizonsService, url_prefix: str = "/newhorizons") -> Any | None:
    if Sock is None:
        app.logger.warning("Flask-Sock is not installed; %s/gateway/ws is disabled", _normalize_url_prefix(url_prefix) or "")
        return None
    sock = Sock(app)

    @sock.route(f"{_normalize_url_prefix(url_prefix)}/gateway/ws")
    def newhorizons_gateway_ws(ws: Any) -> None:
        expected_token = gateway_expected_token()
        if expected_token and _token_from_request() != expected_token:
            ws.send(json.dumps({"type": "error", "code": "unauthorized", "message": "unauthorized"}, separators=(",", ":")))
            return
        GatewaySocketSession(service, ws).handle()

    return sock


def _normalize_url_prefix(value: str) -> str:
    normalized = "/" + str(value or "").strip().strip("/")
    return "" if normalized == "/" else normalized
