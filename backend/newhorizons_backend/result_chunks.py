"""Reassembly of device command results that arrive in pieces.

A device reply too big for one transport unit is sent as ``result_chunk``
pieces, each carrying a slice of the reply's JSON text in ``data``:

- over UDP the firmware splits it into datagrams (``sendUdpResult``). The
  Gateway reassembles those itself; the Backend sees them only when a device
  talks to it directly, without a Gateway.
- over ESP-NOW the device pages it (``EspNowResultPager``), and the Hub
  forwards each page as a ``device_result_chunk`` message.

Both shapes reduce to (request_id, chunk, chunks, data), joined here.
Ported from New-Horizons-Gateway/newhorizons_gateway/result_chunks.py.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable

RESULT_CHUNK_TYPE = "result_chunk"


class ResultChunkReassembler:
    """Collects ``result_chunk`` slices by request_id until all have arrived."""

    def __init__(self, *, ttl_sec: float = 30.0, now: Callable[[], float] | None = None) -> None:
        self._ttl = max(1.0, float(ttl_sec))
        self._now = now or time.monotonic
        self._buffers: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def pending_count(self) -> int:
        with self._lock:
            return len(self._buffers)

    def _purge(self) -> None:
        cutoff = self._now() - self._ttl
        for request_id in [rid for rid, buf in self._buffers.items() if buf["ts"] < cutoff]:
            self._buffers.pop(request_id, None)

    def add(self, frame: dict[str, Any]) -> dict[str, Any] | None:
        """Feed one slice.

        ``frame`` needs ``request_id``, ``chunk``, ``chunks`` and ``data``.
        Returns ``{"device_uid", "request_id", "payload"}`` with the parsed
        reply once every slice for the request_id is in, otherwise None.
        A repeated slice is harmless; a reply that does not parse is dropped.
        """
        request_id = str(frame.get("request_id") or "")
        if not request_id:
            return None
        try:
            index = int(frame.get("chunk"))
            total = int(frame.get("chunks"))
        except (TypeError, ValueError):
            return None
        if total <= 0 or index < 0 or index >= total:
            return None
        data = frame.get("data")
        if not isinstance(data, str):
            return None
        device_uid = str(frame.get("device_uid") or "")

        with self._lock:
            self._purge()
            buf = self._buffers.get(request_id)
            if buf is None or buf["total"] != total:
                buf = {"parts": {}, "total": total, "device_uid": device_uid, "ts": self._now()}
                self._buffers[request_id] = buf
            buf["parts"][index] = data
            buf["ts"] = self._now()
            if device_uid:
                buf["device_uid"] = device_uid
            if len(buf["parts"]) < buf["total"]:
                return None
            self._buffers.pop(request_id, None)

        try:
            payload = json.loads("".join(buf["parts"][i] for i in range(buf["total"])))
        except (KeyError, ValueError):
            return None
        if not isinstance(payload, dict):
            return None
        return {"device_uid": buf["device_uid"], "request_id": request_id, "payload": payload}


def normalize_device_result(raw: dict[str, Any], *, fallback_command: str = "") -> dict[str, Any]:
    """A firmware reply in the shape the Hub reports a one-frame result in.

    Mirrors New-Horizons-Hub's EspNowCommandDispatcher::completePending(), so
    a paged reply is recorded exactly like one that fit in a single frame.
    """
    ok = raw.get("ok") is True
    data = raw.get("data")
    return {
        "command": str(raw.get("cmd") or fallback_command or ""),
        "status": "ok" if ok else "error",
        "ok": ok,
        "message": str(raw.get("message") or ""),
        "data": data if isinstance(data, dict) else {},
        "error": str(raw.get("error") or ""),
    }
