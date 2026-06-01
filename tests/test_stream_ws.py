import json
import sys
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.auth import AuthUser  # noqa: E402
from newhorizons_backend.service import NewHorizonsService  # noqa: E402
from newhorizons_backend.stream_ws import StreamHub, _StreamClient  # noqa: E402


class FakeStreamSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []

    def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


class StreamWebSocketTest(unittest.TestCase):
    def _make_client(self, role: str = "admin") -> tuple[NewHorizonsService, StreamHub, FakeStreamSocket, _StreamClient]:
        service = NewHorizonsService(mock_mode=False)
        hub = StreamHub(service)
        ws = FakeStreamSocket()
        client = _StreamClient(hub, ws, AuthUser(username=role, role=role))
        hub._clients.add(client)
        client.start()
        return service, hub, ws, client

    def _cleanup_client(self, hub: StreamHub, client: _StreamClient) -> None:
        client.close()
        hub._clients.discard(client)
        hub.close()

    def _wait_for(self, predicate, timeout: float = 1.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail("timed out waiting for websocket events")

    def test_subscribe_returns_snapshot_and_normalizes_payload(self):
        service, hub, ws, client = self._make_client()
        device_uid = "3CDC7545CCD0"
        service._latest_visualization[device_uid] = {
            "device_uid": device_uid.lower(),
            "dn": "legacy-name",
            "device_id": "legacy-id",
            "sn": 7,
            "p": [123, 456],
        }

        try:
            hub._handle_message(client, {"type": "subscribe", "device_uid": device_uid.lower()})
            self._wait_for(lambda: len(ws.sent) >= 2)
        finally:
            self._cleanup_client(hub, client)

        self.assertEqual(ws.sent[0], {"type": "subscribed", "device_uid": device_uid})
        self.assertEqual(ws.sent[1]["type"], "snapshot")
        self.assertEqual(ws.sent[1]["device_uid"], device_uid)
        self.assertEqual(ws.sent[1]["data"]["device_uid"], device_uid)
        self.assertEqual(ws.sent[1]["data"]["dn"], device_uid)
        self.assertNotIn("device_id", ws.sent[1]["data"])

    def test_visualization_updates_are_pushed_to_subscribed_clients(self):
        _, hub, ws, client = self._make_client(role="user")
        device_uid = "3CDC7545CCD0"

        try:
            hub._handle_message(client, {"type": "subscribe", "device_uid": device_uid})
            self._wait_for(lambda: len(ws.sent) >= 1)
            ws.sent.clear()

            hub._handle_service_event(
                {
                    "type": "visualization_update",
                    "device_uid": device_uid,
                    "data": {"device_uid": device_uid.lower(), "dn": "legacy", "device_id": "old", "p": [1]},
                }
            )
            self._wait_for(lambda: len(ws.sent) >= 1)
        finally:
            self._cleanup_client(hub, client)

        self.assertEqual(ws.sent[0]["type"], "update")
        self.assertEqual(ws.sent[0]["device_uid"], device_uid)
        self.assertEqual(ws.sent[0]["data"]["device_uid"], device_uid)
        self.assertEqual(ws.sent[0]["data"]["dn"], device_uid)
        self.assertNotIn("device_id", ws.sent[0]["data"])

    def test_unsubscribe_returns_unsubscribed_and_stream_ended(self):
        _, hub, ws, client = self._make_client()
        device_uid = "3CDC7545CCD0"

        try:
            hub._handle_message(client, {"type": "subscribe", "device_uid": device_uid})
            self._wait_for(lambda: len(ws.sent) >= 1)
            ws.sent.clear()

            hub._handle_message(client, {"type": "unsubscribe", "device_uid": device_uid})
            self._wait_for(lambda: len(ws.sent) >= 2)
        finally:
            self._cleanup_client(hub, client)

        self.assertEqual(ws.sent[0], {"type": "unsubscribed", "device_uid": device_uid})
        self.assertEqual(ws.sent[1], {"type": "stream_ended", "device_uid": device_uid})

    def test_device_snapshot_removal_emits_stream_ended(self):
        _, hub, ws, client = self._make_client(role="user")
        device_uid = "3CDC7545CCD0"

        try:
            hub._handle_message(client, {"type": "subscribe", "device_uid": device_uid})
            self._wait_for(lambda: len(ws.sent) >= 1)
            ws.sent.clear()

            hub._handle_service_event({"type": "device_snapshot", "items": []})
            self._wait_for(lambda: len(ws.sent) >= 1)
        finally:
            self._cleanup_client(hub, client)

        self.assertEqual(ws.sent[0], {"type": "stream_ended", "device_uid": device_uid})

    def test_protocol_errors_return_structured_error_messages(self):
        _, hub, ws, client = self._make_client()

        try:
            hub._handle_message(client, {"type": "subscribe"})
            self._wait_for(lambda: len(ws.sent) >= 1)
            self.assertEqual(ws.sent[0]["code"], "device_uid_required")

            ws.sent.clear()
            hub._handle_message(client, {"type": "unknown"})
            self._wait_for(lambda: len(ws.sent) >= 1)
            self.assertEqual(ws.sent[0]["code"], "unknown_type")

            with self.assertRaises(json.JSONDecodeError):
                StreamHub._decode_json_message("{bad json")
        finally:
            self._cleanup_client(hub, client)


if __name__ == "__main__":
    unittest.main()
