import sys
import json
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402
from newhorizons_backend.ws import WebSocketHub, _WsClient  # noqa: E402


class FakeWebSocket:
    def __init__(self):
        self.sent = []

    def send(self, payload):
        self.sent.append(json.loads(payload))


class WebSocketBackpressureTest(unittest.TestCase):
    def test_command_result_is_sent_before_coalesced_visualization_frames(self):
        service = NewHorizonsService(mock_mode=False)
        hub = WebSocketHub(service)
        ws = FakeWebSocket()
        client = _WsClient(hub, ws)
        client.subscribed_visualizations.add("device-1")
        client.start()

        try:
            for seq in range(100):
                client.enqueue({
                    "type": "visualization_update",
                    "device_uid": "device-1",
                    "data": {"seq": seq},
                })
            client.enqueue({
                "type": "command_result",
                "device_uid": "device-1",
                "request_id": "req-critical",
                "payload": {"status": "ok"},
            })

            deadline = time.time() + 2.0
            while time.time() < deadline:
                if ws.sent:
                    break
                time.sleep(0.01)
        finally:
            client.close()

        self.assertTrue(ws.sent)
        self.assertEqual(ws.sent[0]["type"], "command_result")
        self.assertEqual(ws.sent[0]["request_id"], "req-critical")
        stats = hub.stats()
        self.assertGreater(stats["ws_coalesced_frames"], 0)

    def test_service_health_includes_websocket_backpressure_stats(self):
        service = NewHorizonsService(mock_mode=False)
        hub = WebSocketHub(service)
        hub.note_dropped_visualization()

        health = service.health()

        self.assertEqual(health["websocket"]["dropped_visualization"], 1)
        self.assertIn("ws_sent_fps", health["websocket"])

    def test_visualization_flush_keeps_up_with_sixty_fps_target(self):
        service = NewHorizonsService(mock_mode=False)
        hub = WebSocketHub(service)
        ws = FakeWebSocket()
        client = _WsClient(hub, ws)
        client.subscribed_visualizations.add("device-1")
        client.start()

        try:
            deadline = time.time() + 0.65
            seq = 0
            while time.time() < deadline:
                client.enqueue({
                    "type": "visualization_update",
                    "device_uid": "device-1",
                    "target_fps": 60,
                    "data": {"seq": seq, "target_fps": 60},
                })
                seq += 1
                time.sleep(0.004)
            time.sleep(0.08)
        finally:
            client.close()

        sent_visualizations = [item for item in ws.sent if item.get("type") == "visualization_update"]
        self.assertGreaterEqual(len(sent_visualizations), 25)

    def test_visualization_display_stream_is_capped_at_sixty_fps_even_when_device_targets_higher(self):
        event = {
            "type": "visualization_update",
            "device_uid": "device-1",
            "target_fps": 90,
            "data": {"target_fps": 90},
        }

        self.assertEqual(_WsClient._visualization_target_fps(event), 60)


if __name__ == "__main__":
    unittest.main()
