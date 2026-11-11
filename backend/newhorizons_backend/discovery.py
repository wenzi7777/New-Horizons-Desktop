"""The Backend's own FindMe responder (direct mode: devices stream UDP
straight to this server, no relay).

Which devices it offers itself to (FindmePolicy):
- never one that is attached elsewhere: a discover/probe carrying a
  `current_gateway_id` that is not ours comes from a device an NH Studio /
  Pocket / Gateway already serves, and an offer would steal it;
- never one that is switching to a named relay (`preferred_gateway_id` not
  ours): declined, as the Gateway does;
- a device on the deny list gets accept:false (device_rejected) with a
  cooldown;
- offer policy "all" (the default, as before) offers to every other device;
  "managed" only to the devices listed in `managed`, and stays silent to the
  rest so another relay can take them.

The policy lives in `<data_root>/_newhorizons_findme_policy.json` (edited
from the API); NEWHORIZONS_FINDME_OFFER_POLICY / _MANAGED / _DENY set the
starting values when there is no file yet.
"""
from __future__ import annotations

import json
import os
import re
import socket
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

FINDME_DISCOVER_TYPE = "findme_discover"
FINDME_OFFER_TYPE = "findme_offer"
OFFER_POLICIES = ("all", "managed")
DENIED_COOLDOWN_MS = 30000
_UID_PATTERN = re.compile(r"^[0-9A-F]{4,32}$")


def normalize_uid_list(values: Any) -> list[str]:
    if isinstance(values, str):
        values = values.split(",")
    if not isinstance(values, (list, tuple, set)):
        return []
    result: set[str] = set()
    for value in values:
        uid = str(value or "").strip().upper().replace(":", "")
        if uid and _UID_PATTERN.fullmatch(uid):
            result.add(uid)
    return sorted(result)


@dataclass(frozen=True)
class FindmePolicy:
    offer_policy: str = "all"
    managed: tuple[str, ...] = field(default_factory=tuple)
    denied: tuple[str, ...] = field(default_factory=tuple)
    updated_at_ms: int = 0

    @classmethod
    def from_dict(cls, data: Any) -> "FindmePolicy":
        data = data if isinstance(data, dict) else {}
        offer_policy = str(data.get("offer_policy") or "all").strip().lower()
        if offer_policy not in OFFER_POLICIES:
            raise ValueError("offer_policy_invalid")
        try:
            updated_at_ms = int(data.get("updated_at_ms") or 0)
        except (TypeError, ValueError):
            updated_at_ms = 0
        return cls(
            offer_policy=offer_policy,
            managed=tuple(normalize_uid_list(data.get("managed"))),
            denied=tuple(normalize_uid_list(data.get("denied"))),
            updated_at_ms=updated_at_ms,
        )

    @classmethod
    def from_env(cls) -> "FindmePolicy":
        offer_policy = str(os.getenv("NEWHORIZONS_FINDME_OFFER_POLICY", "all")).strip().lower()
        return cls.from_dict({
            "offer_policy": offer_policy if offer_policy in OFFER_POLICIES else "all",
            "managed": os.getenv("NEWHORIZONS_FINDME_MANAGED", ""),
            "denied": os.getenv("NEWHORIZONS_FINDME_DENY", ""),
        })

    def to_dict(self) -> dict[str, Any]:
        return {
            "offer_policy": self.offer_policy,
            "managed": list(self.managed),
            "denied": list(self.denied),
            "updated_at_ms": self.updated_at_ms,
        }


def load_findme_policy(path: Path) -> FindmePolicy:
    try:
        if path.exists():
            return FindmePolicy.from_dict(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return FindmePolicy.from_env()


def save_findme_policy(path: Path, policy: FindmePolicy) -> None:
    from .profile_sync import write_atomic

    write_atomic(path, json.dumps(policy.to_dict(), indent=2, sort_keys=True).encode("utf-8"))


def decide_findme(request: dict[str, Any], *, gateway_id: str, policy: FindmePolicy) -> tuple[bool, str, bool]:
    """(reply?, reason, accept) for one discover request. Pure.

    reply=False: say nothing (the device is someone else's, or not ours to
    manage). Otherwise answer with an offer; accept=False carries `reason`.
    """
    device_uid = str(request.get("device_uid") or "").strip().upper().replace(":", "")
    current_gw = str(request.get("current_gateway_id") or "").strip()
    if current_gw and current_gw != gateway_id:
        return False, "device_attached_elsewhere", False
    preferred_gw = str(request.get("preferred_gateway_id") or "").strip()
    if preferred_gw and preferred_gw != gateway_id:
        return True, "device_switching_gateway", False
    if device_uid in policy.denied:
        return True, "device_rejected", False
    if policy.offer_policy == "managed" and device_uid not in policy.managed:
        return False, "device_not_managed", False
    return True, "", True


class DiscoveryResponder:
    def __init__(
        self,
        host: str,
        port: int,
        *,
        gateway_id: str,
        udp_port: Callable[[], int] | int,
        priority: int = 100,
        gateway_name: str = "NH Gateway",
        policy: Callable[[], FindmePolicy] | None = None,
    ) -> None:
        self._policy = policy or FindmePolicy
        self.host = host
        self.port = int(port)
        self.gateway_id = gateway_id
        self._udp_port = udp_port
        self.priority = int(priority)
        self.gateway_name = gateway_name
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.started = False
        self.bound_port = int(port)
        self.last_error = ""
        self.last_decision: dict[str, object] = {}

    def start(self) -> None:
        if self._thread is not None:
            return
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self.port))
        sock.settimeout(0.5)
        self.bound_port = int(sock.getsockname()[1])
        self._sock = sock
        self._stop.clear()
        self.started = True
        self._thread = threading.Thread(target=self._run, name="newhorizons-discovery", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        sock = self._sock
        self._sock = None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        thread = self._thread
        self._thread = None
        if thread is not None:
            thread.join(timeout=1.0)
        self.started = False

    def _run(self) -> None:
        while not self._stop.is_set():
            sock = self._sock
            if sock is None:
                return
            try:
                data, addr = sock.recvfrom(1024)
            except socket.timeout:
                continue
            except OSError as exc:
                if not self._stop.is_set():
                    self.last_error = str(exc)
                return
            obj = self._decode_request(data)
            if obj is None:
                continue
            reply = self.reply_for(obj)
            if reply is None:
                continue
            try:
                sock.sendto(reply, addr)
            except OSError as exc:
                self.last_error = str(exc)

    def _decode_request(self, data: bytes) -> dict[str, object] | None:
        try:
            decoded = json.loads(data.decode("utf-8"))
        except Exception:
            return None
        if not isinstance(decoded, dict) or decoded.get("type") != FINDME_DISCOVER_TYPE:
            return None
        payload = dict(decoded)
        payload.pop("type", None)
        if not payload.get("device_uid"):
            return None
        return payload

    def reply_for(self, request: dict[str, object]) -> bytes | None:
        """The bytes to send back to one discover request, or None."""
        should_reply, reason, accept = decide_findme(request, gateway_id=self.gateway_id, policy=self._policy())
        self.last_decision = {"device_uid": str(request.get("device_uid") or ""), "reply": should_reply, "accept": accept, "reason": reason}
        if not should_reply:
            return None
        if accept:
            return self._encode_offer(request)
        decline: dict[str, object] = {
            "type": FINDME_OFFER_TYPE,
            "device_uid": str(request.get("device_uid") or ""),
            "gateway_id": self.gateway_id,
            "accept": False,
            "reason": reason,
        }
        if reason == "device_rejected":
            decline["cooldown_ms"] = DENIED_COOLDOWN_MS
        return json.dumps(decline, separators=(",", ":")).encode("utf-8")

    def _encode_offer(self, request: dict[str, object]) -> bytes:
        payload = self._offer_payload(request)
        payload["type"] = FINDME_OFFER_TYPE
        payload["device_uid"] = str(request.get("device_uid") or "")
        return json.dumps(payload, separators=(",", ":")).encode("utf-8")

    def _offer_payload(self, request: dict[str, object]) -> dict[str, object]:
        return {
            "version": 1,
            "gateway_name": self.gateway_name,
            "gateway_id": self.gateway_id,
            "udp_port": self._value(self._udp_port),
            "priority": self.priority,
            "accept": True,
            "upstream_status": "online",
            "ttl_ms": 10000,
            "server_time": int(time.time() * 1000),
        }

    @staticmethod
    def _value(value: Callable[[], int] | int) -> int:
        if callable(value):
            return int(value())
        return int(value)
