from __future__ import annotations

import base64
import json
import os
import threading
import time as _time
from datetime import datetime, timezone
from typing import Any
import time
import urllib.request

from flask import request

try:  # pragma: no cover - depends on optional runtime package.
    from flask_sock import Sock
except Exception:  # pragma: no cover
    Sock = None  # type: ignore[assignment]

from .auth import APP_TOKEN_PREFIX, AuthManager, AuthUser
from .gateway_auth import gateway_expected_token
from .gateway_registry import normalize_relay_client_type
from .service import NewHorizonsService


PACKET_TEXT_PREFIX = "NHPKT1:"
# Gateway self-update channels: stable reads gateway-latest.json (the only
# manifest Gateways older than the channels know), beta reads
# gateway-beta.json. A Gateway names its channel in hello; one that does not
# is on stable.
GATEWAY_MANIFEST_BASE_URL = "https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/main/releases/gateway"
DEFAULT_GATEWAY_MANIFEST_URL = GATEWAY_MANIFEST_BASE_URL + "-latest.json"
GATEWAY_UPDATE_CHANNELS = ("stable", "beta")
_LATEST_GATEWAY_VERSION_CACHE = {"value": "", "expires_at": 0.0}
_LATEST_GATEWAY_VERSION_BY_CHANNEL: dict[str, dict[str, Any]] = {}
_LATEST_GATEWAY_VERSION_LOCK = threading.RLock()
# A Hub follows the same two channels, from its own repo's manifests (the
# same base URL as the Hub firmware's kHubUpdateManifestBase). It learns the
# newest version from hello_ack and treats being behind it as "update
# required", like a Gateway does.
HUB_MANIFEST_BASE_URL = "https://raw.githubusercontent.com/wenzi7777/New-Horizons-Hub/main/releases/hub-gcu-v23d-lts"
_LATEST_HUB_VERSION_BY_CHANNEL: dict[str, dict[str, Any]] = {}


def normalize_gateway_channel(value: Any) -> str:
    channel = str(value or "").strip().lower()
    return channel if channel in GATEWAY_UPDATE_CHANNELS else "stable"


def _gateway_manifest_url(channel: str) -> str:
    if channel == "beta":
        return str(os.getenv("NEWHORIZONS_GATEWAY_BETA_MANIFEST_URL") or GATEWAY_MANIFEST_BASE_URL + "-beta.json").strip()
    return str(os.getenv("NEWHORIZONS_GATEWAY_LATEST_MANIFEST_URL") or DEFAULT_GATEWAY_MANIFEST_URL).strip()


def _hub_manifest_url(channel: str) -> str:
    if channel == "beta":
        return str(os.getenv("NEWHORIZONS_HUB_BETA_MANIFEST_URL") or HUB_MANIFEST_BASE_URL + "-beta.json").strip()
    return str(os.getenv("NEWHORIZONS_HUB_LATEST_MANIFEST_URL") or HUB_MANIFEST_BASE_URL + "-latest.json").strip()


def _manifest_version(manifest_url: str) -> str:
    if not manifest_url:
        return ""
    with urllib.request.urlopen(manifest_url, timeout=5) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        return ""
    # Gateway manifests say "version"; Hub (firmware-style) ones say "latest".
    return str(payload.get("version") or payload.get("latest") or "").strip()


def _latest_gateway_version_from_remote(channel: str = "stable") -> str:
    return _manifest_version(_gateway_manifest_url(channel))


def _cached_version(cache: dict[str, Any], fetch: Any, cache_sec_env: str) -> str:
    """Returns cache's value while fresh, else fetch()es a new one; a failed
    fetch falls back to the last known value. Call with the lock held."""
    now = time.time()
    cached = str(cache.get("value") or "").strip()
    expires_at = float(cache.get("expires_at") or 0.0)
    if cached and now < expires_at:
        return cached
    version = ""
    try:
        version = fetch()
    except Exception:
        version = ""
    if version:
        cache["value"] = version
        cache["expires_at"] = now + max(60, int(os.getenv(cache_sec_env, "300")))
        return version
    return cached

def latest_gateway_version(channel: Any = "stable") -> str:
    channel = normalize_gateway_channel(channel)
    with _LATEST_GATEWAY_VERSION_LOCK:
        # stable keeps its original cache object (tests and older callers
        # patch it); other channels get their own entry.
        cache = (
            _LATEST_GATEWAY_VERSION_CACHE
            if channel == "stable"
            else _LATEST_GATEWAY_VERSION_BY_CHANNEL.setdefault(channel, {"value": "", "expires_at": 0.0})
        )
        return _cached_version(
            cache,
            lambda: _latest_gateway_version_from_remote(channel),
            "NEWHORIZONS_GATEWAY_LATEST_VERSION_CACHE_SEC",
        )


def latest_hub_version(channel: Any = "stable") -> str:
    channel = normalize_gateway_channel(channel)
    with _LATEST_GATEWAY_VERSION_LOCK:
        cache = _LATEST_HUB_VERSION_BY_CHANNEL.setdefault(channel, {"value": "", "expires_at": 0.0})
        return _cached_version(
            cache,
            lambda: _manifest_version(_hub_manifest_url(channel)),
            "NEWHORIZONS_HUB_LATEST_VERSION_CACHE_SEC",
        )


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


# Last wall-clock push per device, so an unsynced device is not re-sent the
# time on every single status message.
_LAST_TIME_PUSH: dict[str, float] = {}
_TIME_PUSH_INTERVAL_S = 600.0


def _clock_is_synced(payload: dict[str, Any]) -> bool | None:
    """True/False if the device reported its clock state, None if unknown."""
    for container in (payload, payload.get("status"), payload.get("data")):
        if not isinstance(container, dict):
            continue
        clock = container.get("clock")
        if isinstance(clock, dict) and "synced" in clock:
            return bool(clock.get("synced"))
    return None


class GatewaySocketSession:
    def __init__(self, service: NewHorizonsService, ws: Any, app_user: AuthUser | None = None) -> None:
        self.service = service
        self.ws = ws
        self.gateway_id = ""
        # The identity this session registered with (its hello), so the relay
        # can be put back as itself if its entry was deleted while online.
        self._hello: dict[str, Any] = {}
        # Set when the relay connected with an app token (NH Studio / NH
        # Pocket): the token, not hello, then says which app this is.
        self.app_user = app_user
        self.sender = self.send_command
        self._send_lock = threading.RLock()
        # Set when this socket is refused for good (a legacy Python Gateway):
        # the receive loop closes it after the error went out.
        self._refused = False

    def send_command(self, payload: dict[str, Any]) -> None:
        self._send_json(payload)

    def handle(self) -> None:
        self._send_json(
            {
                "type": "gateway_hello_ack",
                "server_time": datetime.now(timezone.utc).isoformat(),
                "server_time_ms": int(_time.time() * 1000),
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
                if self._refused:
                    _close_quietly(self.ws)
                    break
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
            hello = self._identified_hello(message)
            if hello is None:
                return
            gateway_id = str(hello.get("gateway_id") or "")
            if not self.service.gateway_takeover_allowed(gateway_id, self.sender, hello):
                # An unauthenticated relay may not take the id of a signed-in
                # NH Studio / Pocket that is online right now.
                self._send_json({"type": "error", "code": "gateway_id_in_use", "message": "This relay id is in use by a signed-in app"})
                return
            self.gateway_id = gateway_id
            self._hello = hello
            self.service.register_gateway(self.gateway_id, self.sender, hello)
            ack = {
                "type": "gateway_hello_ack",
                "gateway_id": self.gateway_id,
                "server_time": datetime.now(timezone.utc).isoformat(),
                "server_time_ms": int(_time.time() * 1000),
                "transport_mode": "udp_gateway_wss",
            }
            client_type = normalize_relay_client_type(hello.get("client_type"))
            ack["client_type"] = client_type
            if self.app_user is not None:
                ack["app_id"] = self.app_user.app_id
            if client_type == "hub":
                # A Hub behind this version locks its settings and new
                # pairings, and updates itself once no device is online.
                ack["latest_hub_version"] = latest_hub_version(message.get("update_channel"))
            elif client_type == "gateway":
                # The newest version on this Gateway's own channel, so a
                # beta is only ever pushed to Gateways that chose beta.
                # (NH Studio / Pocket update themselves from their own
                # stores; a Gateway version means nothing to them.)
                ack["latest_gateway_version"] = latest_gateway_version(message.get("update_channel"))
            self._send_json(ack)
            return
        if msg_type == "hub_version_check":
            # A Hub that stays connected across a release asks again now and
            # then; hello_ack only covers the moment it connected.
            self._send_json(
                {
                    "type": "hub_version",
                    "latest_hub_version": latest_hub_version(message.get("update_channel")),
                }
            )
            return
        if msg_type == "ping":
            # server_time_ms is what a Hub times its clock against (HubClock's
            # backend source): read as late as possible, right before sending.
            now = _time.time()
            self._send_json(
                {
                    "type": "pong",
                    "server_time": datetime.fromtimestamp(now, timezone.utc).isoformat(),
                    "server_time_ms": int(now * 1000),
                }
            )
            return
        if msg_type == "gateway_status":
            payload = _payload_from_message(message)
            # Once hello named this session's relay, a status is always that
            # relay's: a different id in the message must not create (or
            # overwrite) another relay's entry.
            gateway_id = self.gateway_id or str(message.get("gateway_id") or "")
            if gateway_id:
                if not self.gateway_id:
                    hello = self._identified_hello({**message, "gateway_id": gateway_id})
                    if hello is None or not self.service.gateway_takeover_allowed(gateway_id, self.sender, hello):
                        return
                    self.gateway_id = gateway_id
                    self._hello = hello
                self.service.record_gateway_summary(gateway_id, payload, sender=self.sender, identity=self._hello)
            return

        if msg_type == "gateway_claim_request":
            gateway_id = self.gateway_id or str(message.get("gateway_id") or "")
            if gateway_id and not self.gateway_id:
                # A claim before hello registers the relay, with the same
                # identity rules as hello (client_type / authenticated come
                # from the token, never from the message).
                claim_hello = self._identified_hello({**message, "gateway_id": gateway_id})
                if claim_hello is None:
                    return
                if not self.service.gateway_takeover_allowed(gateway_id, self.sender, claim_hello):
                    self._send_json({"type": "gateway_claim_update", "state": "failed", "error": "gateway_id_in_use", "claim_id": message.get("claim_id", ""), "device_uid": message.get("device_uid", "")})
                    return
                self.gateway_id = gateway_id
                self._hello = claim_hello
                self.service.register_gateway(gateway_id, self.sender, claim_hello)
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
            self._maybe_push_time(device_uid, payload)
            return

        if msg_type == "gateway_command_result":
            # Reply to a Backend-initiated gateway_command (Desktop's
            # Manage Hub panel -> service.py::publish_gateway_command()) --
            # see service.py::record_gateway_command_result()'s docstring
            # for why this is just a broadcast, not a device-entry merge.
            gateway_id = self.gateway_id or str(message.get("gateway_id") or "")
            self.service.record_gateway_command_result(gateway_id, message)
            return

        if msg_type == "device_result":
            payload = _payload_from_message(message)
            device_uid = str(message.get("device_uid") or payload.get("device_uid") or "").strip()
            if not device_uid:
                self._send_json({"type": "error", "code": "device_uid_required", "message": "device_uid is required"})
                return
            # A reply through a relay that doesn't serve the device must not
            # stamp that relay onto the device entry either.
            if self.service.register_gateway_reply(device_uid, self.sender, self.gateway_id):
                payload.setdefault("gateway_id", self.gateway_id)
            payload.setdefault("transport_path", "gateway_wss")
            self.service.record_gateway_result(device_uid, payload)
            return

        if msg_type == "device_result_chunk":
            # One page of a reply a Hub relays in pieces; see
            # service.record_gateway_result_chunk().
            payload = _payload_from_message(message)
            device_uid = str(message.get("device_uid") or payload.get("device_uid") or "").strip()
            if not device_uid:
                self._send_json({"type": "error", "code": "device_uid_required", "message": "device_uid is required"})
                return
            # A reply through a relay that doesn't serve the device must not
            # stamp that relay onto the device entry either.
            if self.service.register_gateway_reply(device_uid, self.sender, self.gateway_id):
                payload.setdefault("gateway_id", self.gateway_id)
            payload.setdefault("transport_path", "gateway_wss")
            self.service.record_gateway_result_chunk(device_uid, payload)
            return

        self._send_json({"type": "error", "code": "unknown_gateway_type", "message": "Unknown gateway message type"})

    def _identified_hello(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """hello with the relay's identity settled, or None (refused, the
        socket told why).

        A relay that came with an app token is that app: its client_type
        is the token's, and it gets the token id as gateway_id unless it
        names one. Without a token, "studio" / "pocket" are still accepted
        (like a Gateway, which never had one) unless the server requires
        tokens for apps (NEWHORIZONS_REQUIRE_APP_TOKEN=1). "relay" (NH
        Studio headless) and "hub" never need one: they only relay."""
        hello = dict(message)
        raw_type = str(hello.get("client_type") or "").strip().lower()
        if self.app_user is None and raw_type not in ("hub", "studio", "pocket", "relay"):
            # The Python NH Gateway (no client_type, or "gateway") is retired:
            # NH Studio / headless replaced it, and current firmware ignores
            # its FindMe offers. Refuse it for good rather than relay for it.
            self._send_json(
                {
                    "type": "error",
                    "code": "legacy_gateway_unsupported",
                    "message": "NH Gateway is no longer supported. Install NH Studio (or NH Studio headless) instead.",
                }
            )
            self._refused = True
            return None
        claimed = normalize_relay_client_type(hello.get("client_type"))
        if self.app_user is not None:
            hello["client_type"] = self.app_user.client_type
            hello["app_id"] = self.app_user.app_id
            hello["authenticated"] = True
            hello["account"] = self.app_user.account
            if not str(hello.get("gateway_id") or "").strip():
                hello["gateway_id"] = f"nh-{self.app_user.client_type}-{self.app_user.app_id}"
            return hello
        hello["client_type"] = claimed
        hello["app_id"] = ""
        hello["authenticated"] = False
        hello["account"] = ""
        if claimed in ("studio", "pocket") and _app_token_required():
            self._send_json({"type": "error", "code": "app_token_required", "message": "NH Studio / NH Pocket must connect with an app token"})
            return None
        return hello

    def _maybe_push_time(self, device_uid: str, payload: dict[str, Any]) -> None:
        """Give an unsynced device a wall clock.

        An ESP-NOW/Direct device never associates with an AP, so it can never
        reach NTP: without this it timestamps nothing and every packet carries
        epochValid=false. The push is an ordinary `set_time` control command,
        so it reaches the device over whichever transport already works --
        Gateway UDP or relayed through a Hub -- with no new protocol.

        Called outside the service lock: publish_command() takes that lock
        itself.
        """
        # Only push when the device actively says it is unsynced. Firmware
        # before v1.0.0 has no set_time command and reports no `clock` block
        # at all, so _clock_is_synced() returns None for it -- treating that
        # as "unsynced" would send every pre-v1.0.0 device a doomed command
        # every interval, and a Hub pauses its sensor-data relay for the
        # lifetime of each pending command.
        if _clock_is_synced(payload) is not False:
            return
        now = _time.monotonic()
        if now - _LAST_TIME_PUSH.get(device_uid, 0.0) < _TIME_PUSH_INTERVAL_S:
            return
        _LAST_TIME_PUSH[device_uid] = now
        try:
            self.service.publish_command(
                device_uid,
                {
                    "command": "set_time",
                    "request_id": "clock-sync-{}".format(int(now * 1000)),
                    "epoch_ms": str(int(_time.time() * 1000)),
                    # Sent on its own, nobody clicked anything: no LED ack.
                    "quiet": True,
                },
            )
        except Exception:
            # A device that is booting or briefly unreachable simply gets the
            # time on its next hello; this must never break status handling.
            pass

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


def _app_token_required() -> bool:
    return os.getenv("NEWHORIZONS_REQUIRE_APP_TOKEN", "0") in {"1", "true", "True"}


def register_gateway_websocket_routes(
    app: Any,
    service: NewHorizonsService,
    url_prefix: str = "/newhorizons",
    auth_manager: AuthManager | None = None,
) -> Any | None:
    if Sock is None:
        app.logger.warning("Flask-Sock is not installed; %s/gateway/ws is disabled", _normalize_url_prefix(url_prefix) or "")
        return None
    sock = Sock(app)

    @sock.route(f"{_normalize_url_prefix(url_prefix)}/gateway/ws")
    def newhorizons_gateway_ws(ws: Any) -> None:
        token = _token_from_request()
        app_user: AuthUser | None = None
        manager = auth_manager or app.config.get("NEWHORIZONS_AUTH_MANAGER")
        if token.startswith(APP_TOKEN_PREFIX):
            # An app token is checked whatever else is configured: a wrong
            # or revoked one is refused, never silently downgraded.
            app_user = manager.authenticate_app_token(token) if manager is not None else None
            if app_user is None:
                ws.send(json.dumps({"type": "error", "code": "unauthorized", "message": "unauthorized"}, separators=(",", ":")))
                return
        else:
            expected_token = gateway_expected_token()
            if expected_token and token != expected_token:
                ws.send(json.dumps({"type": "error", "code": "unauthorized", "message": "unauthorized"}, separators=(",", ":")))
                return
        # A revoked token ends this socket too (AuthManager.revoke_app_token).
        untrack = manager.track_app_session(app_user.app_id, lambda: _close_quietly(ws)) if app_user is not None and manager is not None else (lambda: None)
        try:
            GatewaySocketSession(service, ws, app_user=app_user).handle()
        finally:
            untrack()

    return sock


def _close_quietly(ws: Any) -> None:
    try:
        ws.close()
    except Exception:
        pass


def _normalize_url_prefix(value: str) -> str:
    normalized = "/" + str(value or "").strip().strip("/")
    return "" if normalized == "/" else normalized
