from __future__ import annotations

import json
import socket
import threading
import time
from typing import Callable

FINDME_DISCOVER_TYPE = "findme_discover"
FINDME_OFFER_TYPE = "findme_offer"


class DiscoveryResponder:
    def __init__(
        self,
        host: str,
        port: int,
        *,
        gateway_id: str,
        udp_port: Callable[[], int] | int,
        priority: int = 100,
        gateway_name: str = "New Horizons Gateway",
    ) -> None:
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
            try:
                sock.sendto(self._encode_offer(obj), addr)
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
