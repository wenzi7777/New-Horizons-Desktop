from __future__ import annotations

import socket
import threading
from typing import Callable


DatagramCallback = Callable[[bytes, tuple[str, int]], None]


class UDPIngestServer:
    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 13250,
        on_datagram: DatagramCallback | None = None,
        buffer_bytes: int = 8192,
    ) -> None:
        self.host = host
        self.port = int(port)
        self.on_datagram = on_datagram
        self.buffer_bytes = int(buffer_bytes)
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._running = threading.Event()
        self._send_lock = threading.RLock()
        self.last_error = ""

    @property
    def started(self) -> bool:
        return self._sock is not None

    @property
    def bound_port(self) -> int:
        if self._sock is None:
            return self.port
        return int(self._sock.getsockname()[1])

    def start(self) -> None:
        if self._sock is not None:
            return
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self.port))
        sock.settimeout(0.5)
        self._sock = sock
        self._running.set()
        self._thread = threading.Thread(target=self._run, name="newhorizons-udp-ingest", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running.clear()
        sock = self._sock
        thread = self._thread
        self._sock = None
        self._thread = None
        if sock is not None:
            sock.close()
        if thread is not None:
            thread.join(timeout=1.0)

    def send_datagram(self, payload: bytes, addr: tuple[str, int]) -> None:
        sock = self._sock
        if sock is None:
            raise RuntimeError("udp_ingest_not_started")
        with self._send_lock:
            sock.sendto(payload, addr)

    def _run(self) -> None:
        assert self._sock is not None
        while self._running.is_set():
            try:
                payload, addr = self._sock.recvfrom(self.buffer_bytes)
            except socket.timeout:
                continue
            except OSError as exc:
                if self._running.is_set():
                    self.last_error = str(exc)
                break
            if payload and self.on_datagram is not None:
                try:
                    self.on_datagram(payload, addr)
                    self.last_error = ""
                except Exception as exc:
                    self.last_error = str(exc)
