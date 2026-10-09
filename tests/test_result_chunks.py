import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from newhorizons_backend.gateway_ws import GatewaySocketSession  # noqa: E402
from newhorizons_backend.result_chunks import ResultChunkReassembler, normalize_device_result  # noqa: E402
from newhorizons_backend.service import NewHorizonsService  # noqa: E402

DEVICE_UID = "3CDC7545CCD0"


def json_text(payload):
    return json.dumps(payload, separators=(",", ":"))


def split(text, size):
    return [text[i:i + size] for i in range(0, len(text), size)]


class FakeGatewayWebSocket:
    def __init__(self, incoming):
        self.incoming = list(incoming)
        self.sent = []

    def receive(self):
        if not self.incoming:
            return None
        return self.incoming.pop(0)

    def send(self, payload):
        self.sent.append(payload)


def calibration_dump_reply():
    cells = [
        {"sensor_index": i, "row": i % 15, "col": i // 15, "calibrated": True, "value": 1234.567}
        for i in range(225)
    ]
    return {
        "ok": True,
        "cmd": "calibration_dump_level",
        "message": "calibration_level_dump",
        "data": {"level": 1, "saved": {"cells": cells}, "draft": None, "session_active": False},
    }


class ReassemblerTests(unittest.TestCase):
    def frames(self, reply, request_id="req-1", size=700):
        parts = split(json_text(reply), size)
        return [
            {"device_uid": DEVICE_UID, "request_id": request_id, "chunk": i, "chunks": len(parts), "data": part}
            for i, part in enumerate(parts)
        ]

    def test_joins_slices_in_any_order_and_ignores_repeats(self):
        reply = calibration_dump_reply()
        frames = self.frames(reply)
        reassembler = ResultChunkReassembler()
        results = [reassembler.add(f) for f in [frames[-1], frames[0], frames[0]] + frames[1:-1]]
        done = [r for r in results if r is not None]
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["payload"], reply)
        self.assertEqual(done[0]["request_id"], "req-1")
        self.assertEqual(reassembler.pending_count(), 0)

    def test_stale_partial_replies_expire(self):
        clock = [0.0]
        reassembler = ResultChunkReassembler(ttl_sec=30, now=lambda: clock[0])
        frames = self.frames(calibration_dump_reply())
        reassembler.add(frames[0])
        clock[0] = 31.0
        reassembler.add({"request_id": "other", "chunk": 0, "chunks": 2, "data": "{"})
        self.assertEqual(reassembler.pending_count(), 1)

    def test_unparseable_reply_is_dropped(self):
        reassembler = ResultChunkReassembler()
        self.assertIsNone(reassembler.add({"request_id": "r", "chunk": 0, "chunks": 2, "data": "{\"ok\":"}))
        self.assertIsNone(reassembler.add({"request_id": "r", "chunk": 1, "chunks": 2, "data": "tru"}))
        self.assertEqual(reassembler.pending_count(), 0)

    def test_bad_slices_are_ignored(self):
        reassembler = ResultChunkReassembler()
        for frame in (
            {"chunk": 0, "chunks": 1, "data": "{}"},
            {"request_id": "r", "chunk": 1, "chunks": 1, "data": "{}"},
            {"request_id": "r", "chunk": 0, "chunks": 1, "data": 5},
        ):
            self.assertIsNone(reassembler.add(frame))


class NormalizeTests(unittest.TestCase):
    def test_matches_the_hub_result_shape(self):
        self.assertEqual(
            normalize_device_result({"ok": True, "cmd": "status", "message": "status", "data": {"a": 1}}),
            {"command": "status", "status": "ok", "ok": True, "message": "status", "data": {"a": 1}, "error": ""},
        )

    def test_error_reply_keeps_its_code_and_falls_back_to_the_sent_command(self):
        result = normalize_device_result({"ok": False, "error": "result_page_expired"}, fallback_command="status")
        self.assertEqual(result["command"], "status")
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"], "result_page_expired")
        self.assertEqual(result["data"], {})


class HubPagedReplyTests(unittest.TestCase):
    def pages(self, reply, request_id="req-cal"):
        parts = split(json_text(reply), 7000)
        return [
            {
                "type": "device_result_chunk",
                "gateway_id": "hub-1",
                "device_uid": DEVICE_UID,
                "payload": {
                    "device_uid": DEVICE_UID,
                    "request_id": request_id,
                    "command": "calibration_dump_level",
                    "page": {"type": "result_chunk", "rid": 3, "chunk": i, "chunks": len(parts), "data": part},
                },
            }
            for i, part in enumerate(parts)
        ]

    def test_pages_are_joined_and_recorded_as_one_result(self):
        reply = calibration_dump_reply()
        pages = self.pages(reply)
        self.assertGreater(len(pages), 1)
        service = NewHorizonsService(mock_mode=False)
        ws = FakeGatewayWebSocket(
            [json_text({"type": "hello", "gateway_id": "hub-1", "client_type": "hub"})]
            + [json_text(page) for page in pages]
        )
        with patch.object(service, "_record_result") as record:
            GatewaySocketSession(service, ws).handle()

        record.assert_called_once()
        device_uid, result = record.call_args.args
        self.assertEqual(device_uid, DEVICE_UID)
        self.assertEqual(result["request_id"], "req-cal")
        self.assertEqual(result["command"], "calibration_dump_level")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["data"], reply["data"])
        self.assertEqual(result["transport_path"], "gateway_wss")
        self.assertEqual(result["gateway_id"], "hub-1")
        self.assertFalse(any('"unknown_gateway_type"' in sent for sent in ws.sent))

    def test_nothing_is_recorded_until_the_last_page(self):
        pages = self.pages(calibration_dump_reply())
        service = NewHorizonsService(mock_mode=False)
        ws = FakeGatewayWebSocket(
            [json_text({"type": "hello", "gateway_id": "hub-1"})] + [json_text(page) for page in pages[:-1]]
        )
        with patch.object(service, "_record_result") as record:
            GatewaySocketSession(service, ws).handle()
        record.assert_not_called()


class DirectUdpChunkTests(unittest.TestCase):
    def test_chunked_udp_result_is_recorded(self):
        reply = calibration_dump_reply()
        parts = split(json_text(reply), 700)
        service = NewHorizonsService(mock_mode=False)
        with patch.object(service, "_record_result") as record:
            for i, part in enumerate(parts):
                service._handle_udp_control_datagram(
                    json_text({
                        "type": "result_chunk",
                        "device_uid": DEVICE_UID,
                        "request_id": "req-udp",
                        "chunk": i,
                        "chunks": len(parts),
                        "data": part,
                    }).encode(),
                    ("192.168.50.44", 22345),
                )

        record.assert_called_once()
        device_uid, data = record.call_args.args
        self.assertEqual(device_uid, DEVICE_UID)
        self.assertEqual(data["request_id"], "req-udp")
        self.assertEqual(data["cmd"], "calibration_dump_level")
        self.assertEqual(data["data"], reply["data"])
        self.assertEqual(service._udp_control_sessions[DEVICE_UID], ("192.168.50.44", 22345))


if __name__ == "__main__":
    unittest.main()
