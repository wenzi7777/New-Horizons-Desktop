import base64
import csv
import json
import os
import struct
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from flask import Flask


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.api import create_blueprint  # noqa: E402
from newhorizons_backend.gateway_ws import GatewaySocketSession, PACKET_TEXT_PREFIX  # noqa: E402
from newhorizons_backend.service import NewHorizonsService  # noqa: E402
from newhorizons_backend.standalone import create_standalone_app  # noqa: E402


def json_payload(response):
    return response.get_json()


def json_text(payload):
    return json.dumps(payload, separators=(",", ":"))


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


class IndependentNewHorizonsTest(unittest.TestCase):
    def test_discovery_responder_supports_json_findme(self):
        from newhorizons_backend.discovery import DiscoveryResponder

        responder = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-json",
            udp_port=13250,
            priority=77,
        )
        packet = json_text({"type": "findme_discover", "device_uid": "3CDC7545CCD0", "mode": "normal"}).encode()

        request = responder._decode_request(packet)
        response = json.loads(responder._encode_offer(request).decode())

        self.assertEqual(request["device_uid"], "3CDC7545CCD0")
        self.assertEqual(response["type"], "findme_offer")
        self.assertEqual(response["gateway_id"], "gw-json")
        self.assertEqual(response["udp_port"], 13250)
        self.assertTrue(response["accept"])

    def test_standalone_app_uses_independent_defaults(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            "os.environ",
            {
                "NEWHORIZONS_AUTOSTART": "0",
                "NEWHORIZONS_AUTH_DB": str(Path(tmpdir) / "auth.sqlite3"),
            },
            clear=True,
        ):
            app = create_standalone_app()
        client = app.test_client()

        health = client.get("/newhorizons/api/health")
        me = client.get("/newhorizons/api/auth/me")

        self.assertEqual(health.status_code, 401)
        self.assertEqual(json_payload(me), {"authenticated": False})

    def test_gateway_registered_device_receives_commands(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        service.register_gateway_device("3CDC7545CCD0", sent.append)

        queued = service.publish_command("3CDC7545CCD0", {"command": "status", "request_id": "req-1"})

        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(queued["request_id"], "req-1")
        self.assertEqual(sent[0]["type"], "command")
        self.assertEqual(sent[0]["device_uid"], "3CDC7545CCD0")
        self.assertEqual(sent[0]["payload"]["command"], "status")

    def test_command_without_active_control_route_reports_device_unavailable(self):
        service = NewHorizonsService(mock_mode=False)

        with self.assertRaisesRegex(RuntimeError, "device_control_unavailable"):
            service.publish_command("3CDC7545CCD0", {"command": "status", "request_id": "req-1"})

    def test_udp_json_status_registers_command_session(self):
        class FakeUDPIngest:
            started = True
            bound_port = 13250

            def __init__(self):
                self.sent = []

            def send_datagram(self, payload, addr):
                self.sent.append((payload, addr))

        service = NewHorizonsService(mock_mode=False)
        service._udp_ingest = FakeUDPIngest()
        device_uid = "3CDC7545CCD0"
        addr = ("192.168.50.32", 49152)

        service._handle_udp_datagram(
            json_text({"type": "status", "device_uid": device_uid, "message": "status_announce"}).encode(),
            addr,
        )

        queued = service.publish_command(device_uid, {"command": "scan_health", "request_id": "req-udp"})

        self.assertEqual(queued["transport"], "udp")
        self.assertEqual(queued["device_uid"], device_uid)
        self.assertEqual(queued["request_id"], "req-udp")
        self.assertEqual(len(service._udp_ingest.sent), 3)
        packet, target = service._udp_ingest.sent[0]
        self.assertEqual(target, addr)
        message = json.loads(packet.decode())
        self.assertEqual(message["type"], "command")
        self.assertEqual(message["device_uid"], device_uid)
        self.assertEqual(message["payload"]["command"], "scan_health")
        self.assertEqual(message["payload"]["request_id"], "req-udp")

    def test_http_command_unavailable_reports_retryable_message(self):
        service = NewHorizonsService(mock_mode=False)
        app = Flask(__name__)
        app.register_blueprint(create_blueprint(service=service, profiles_root=ROOT / "mock_data" / "profiles", data_root=ROOT / "mock_data" / "mqtt_store"))
        client = app.test_client()

        response = client.post(
            "/newhorizons/api/device-command",
            json={"device_uid": "3CDC7545CCD0", "payload": {"command": "status", "request_id": "req-1"}},
        )

        self.assertEqual(response.status_code, 503)
        payload = json_payload(response)
        self.assertEqual(payload["code"], "device_control_unavailable")
        self.assertEqual(payload["error"], "Device control is reconnecting; try again in a few seconds.")
        self.assertTrue(payload["retryable"])

    def test_http_wrong_mode_command_reports_non_retryable_wrong_mode(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        service.register_gateway_device("3CDC7545CCD0", sent.append)
        service.record_gateway_result("3CDC7545CCD0", {
            "device_uid": "3CDC7545CCD0",
            "message": "status",
            "mode": "unsupported_legacy_mode",
        })
        app = Flask(__name__)
        app.register_blueprint(create_blueprint(service=service, profiles_root=ROOT / "mock_data" / "profiles", data_root=ROOT / "mock_data" / "mqtt_store"))
        client = app.test_client()

        response = client.post(
            "/newhorizons/api/device-command",
            json={"device_uid": "3CDC7545CCD0", "payload": {"command": "set_scan_timing", "request_id": "req-wrong"}},
        )

        self.assertEqual(response.status_code, 409)
        payload = json_payload(response)
        self.assertEqual(payload["code"], "wrong_mode")
        self.assertEqual(payload["error"], "wrong_mode")
        self.assertFalse(payload["retryable"])
        self.assertEqual(sent, [])

    def test_terminal_command_unavailable_reports_retryable_message(self):
        service = NewHorizonsService(mock_mode=False)
        app = Flask(__name__)
        app.register_blueprint(create_blueprint(service=service, profiles_root=ROOT / "mock_data" / "profiles", data_root=ROOT / "mock_data" / "mqtt_store"))
        client = app.test_client()

        response = client.post(
            "/newhorizons/api/terminal/execute",
            json={"device_uid": "3CDC7545CCD0", "command_line": "status"},
        )

        self.assertEqual(response.status_code, 503)
        payload = json_payload(response)
        self.assertEqual(payload["code"], "device_control_unavailable")
        self.assertEqual(payload["error"], "Device control is reconnecting; try again in a few seconds.")
        self.assertTrue(payload["retryable"])

    def test_gateway_summary_connected_device_receives_commands(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        service.register_gateway("gw-main", sent.append, {"gateway_name": "Bench Gateway"})

        service.record_gateway_summary("gw-main", {
            "gateway_name": "Bench Gateway",
            "state": {
                "devices": [{
                    "device_uid": "3CDC7545CCD0",
                    "connected": True,
                    "findme_state": "attached",
                }],
            },
        })
        queued = service.publish_command("3CDC7545CCD0", {"command": "memory_status", "request_id": "req-memory"})

        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(sent[-1]["type"], "command")
        self.assertEqual(sent[-1]["device_uid"], "3CDC7545CCD0")
        self.assertEqual(sent[-1]["payload"]["command"], "memory_status")

    def test_gateway_summary_arduino_peer_registers_direct_tcp_control(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        service.register_gateway("gw-main", sent.append, {"gateway_name": "Bench Gateway"})

        service.record_gateway_summary("gw-main", {
            "gateway_name": "Bench Gateway",
            "state": {
                "devices": [{
                    "device_uid": "3CDC7545CCD0",
                    "connected": True,
                    "findme_state": "attached",
                    "protocol": "NHO/Arduino/1",
                    "peer": "192.168.50.32:22345",
                }],
            },
        })

        queued = service.publish_command("3CDC7545CCD0", {"command": "status", "request_id": "req-direct"})

        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(sent[-1]["type"], "command")
        self.assertEqual(sent[-1]["payload"]["command"], "status")
        self.assertEqual(sent[-1]["payload"]["request_id"], "req-direct")
        self.assertEqual(len(sent), 1)

    def test_gateway_sender_is_used_even_when_gateway_summary_reports_peer(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        service.register_gateway("gw-main", sent.append, {"gateway_name": "Bench Gateway"})
        service.record_gateway_summary("gw-main", {
            "gateway_name": "Bench Gateway",
            "state": {
                "devices": [{
                    "device_uid": "3CDC7545CCD0",
                    "connected": True,
                    "findme_state": "attached",
                    "protocol": "NHO/Arduino/1",
                    "peer": "192.168.50.32:22345",
                }],
            },
        })

        queued = service.publish_command("3CDC7545CCD0", {"command": "status", "request_id": "req-fallback"})

        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(sent[-1]["type"], "command")
        self.assertEqual(sent[-1]["device_uid"], "3CDC7545CCD0")
        self.assertEqual(sent[-1]["payload"]["request_id"], "req-fallback")

    def test_arduino_apply_update_started_response_updates_status_cache(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        service.register_gateway("gw-main", sent.append, {"gateway_name": "Bench Gateway"})
        service.record_gateway_summary("gw-main", {
            "gateway_name": "Bench Gateway",
            "state": {
                "devices": [{
                    "device_uid": "3CDC7545CCD0",
                    "connected": True,
                    "findme_state": "attached",
                    "protocol": "NHO/Arduino/1",
                    "peer": "192.168.50.32:22345",
                }],
            },
        })
        service.record_gateway_result("3CDC7545CCD0", {
            "device_uid": "3CDC7545CCD0",
            "message": "update_checked",
            "command": "check_update",
            "status": "ok",
            "update_state": {
                "phase": "ready",
                "operation": "check_update",
                "version": "v0.5.10",
                "manifest_url": "https://example.com/arduino-latest.json",
                "last_result": "manifest_ready",
            },
            "firmware_version": "v0.5.9",
        })

        queued = service.publish_command("3CDC7545CCD0", {"command": "apply_update", "request_id": "req-apply"})

        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(sent[-1]["type"], "command")
        self.assertEqual(sent[-1]["payload"]["command"], "apply_update")
        self.assertEqual(sent[-1]["payload"]["request_id"], "req-apply")

    def test_gateway_sender_relays_apply_update_without_direct_tcp_shortcut(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        service.register_gateway("gw-main", sent.append, {"gateway_name": "Bench Gateway"})
        service.record_gateway_summary("gw-main", {
            "gateway_name": "Bench Gateway",
            "state": {
                "devices": [{
                    "device_uid": "3CDC7545CCD0",
                    "connected": True,
                    "findme_state": "attached",
                    "protocol": "NHO/Arduino/1",
                    "peer": "192.168.50.32:22345",
                }],
            },
        })
        service.record_gateway_result("3CDC7545CCD0", {
            "device_uid": "3CDC7545CCD0",
            "message": "update_checked",
            "command": "check_update",
            "status": "ok",
            "update_state": {
                "phase": "ready",
                "operation": "check_update",
                "version": "v0.5.10",
                "manifest_url": "https://example.com/arduino-latest.json",
                "last_result": "manifest_ready",
            },
            "firmware_version": "v0.5.9",
        })

        queued = service.publish_command("3CDC7545CCD0", {"command": "apply_update", "request_id": "req-legacy-apply"})

        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(sent[-1]["type"], "command")
        self.assertEqual(sent[-1]["payload"]["command"], "apply_update")
        self.assertEqual(sent[-1]["payload"]["request_id"], "req-legacy-apply")

    def test_removed_recovery_reboot_to_os_is_not_queued(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        device_uid = "3CDC7545CCD0"
        service.register_gateway_device(device_uid, sent.append)
        service.record_gateway_result(device_uid, {"device_uid": device_uid, "message": "status", "mode": "normal"})

        with self.assertRaisesRegex(RuntimeError, "unknown_command"):
            service.publish_command(device_uid, {"command": "reboot_to_os", "target_mode": "recovery", "request_id": "req-os"})

        self.assertEqual(sent, [])
        self.assertNotIn(device_uid, service._pending_commands)
        self.assertNotIn(device_uid, service._boot_transitions)

    def test_gateway_summary_connected_device_refreshes_device_presence(self):
        service = NewHorizonsService(mock_mode=False)
        events = []
        service.add_event_listener(events.append)
        service.register_gateway("gw-main", events.append, {"gateway_name": "Bench Gateway"})
        service.record_gateway_result("3CDC7545CCD0", {
            "device_uid": "3CDC7545CCD0",
            "message": "status",
            "mode": "normal",
            "received_at": "2026-05-23T00:00:00+00:00",
        })

        service.record_gateway_summary("gw-main", {
            "gateway_name": "Bench Gateway",
            "state": {
                "devices": [{
                    "device_uid": "3CDC7545CCD0",
                    "connected": True,
                    "findme_state": "attached",
                }],
            },
        })

        devices = {item["device_uid"]: item for item in service.list_devices()}
        device = devices["3CDC7545CCD0"]
        self.assertEqual(device["mode"], "normal")
        self.assertTrue(device["gateway_connected"])
        self.assertEqual(device["gateway_id"], "gw-main")
        self.assertNotEqual(device["last_seen_at"], "2026-05-23T00:00:00+00:00")
        self.assertTrue(any(event.get("type") == "device_update" and event.get("item", {}).get("gateway_connected") for event in events))

    def test_gateway_disconnect_marks_device_gateway_presence_offline(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        service.register_gateway("gw-main", sent.append, {"gateway_name": "Bench Gateway"})
        service.record_gateway_summary("gw-main", {
            "gateway_name": "Bench Gateway",
            "state": {
                "devices": [{"device_uid": "3CDC7545CCD0", "connected": True}],
            },
        })

        service.unregister_gateway_sender(sent.append)

        devices = {item["device_uid"]: item for item in service.list_devices()}
        self.assertFalse(devices["3CDC7545CCD0"]["gateway_connected"])

    def test_gateway_summary_disconnected_does_not_override_recent_attached_findme(self):
        service = NewHorizonsService(mock_mode=False)
        device_uid = "3CDC7545CCD0"
        recent = datetime.now(timezone.utc).isoformat()
        service.record_gateway_result(device_uid, {
            "device_uid": device_uid,
            "message": "status",
            "mode": "normal",
            "received_at": recent,
            "gateway_connected": True,
            "findme": {
                "state": "attached",
                "gateway_id": "gw-main",
                "gateway_name": "Bench Gateway",
                "host": "192.168.1.1",
                "udp_port": 13250,
                "last_error": "",
            },
        })

        service.record_gateway_summary("gw-main", {
            "gateway_name": "Bench Gateway",
            "state": {
                "devices": [{
                    "device_uid": device_uid,
                    "connected": False,
                    "findme_state": "disconnected",
                }],
            },
        })

        devices = {item["device_uid"]: item for item in service.list_devices()}
        device = devices[device_uid]
        self.assertTrue(device["gateway_connected"])
        self.assertEqual(device["findme"]["state"], "attached")
        self.assertEqual(device["findme"]["host"], "192.168.1.1")

    def test_removed_recovery_boot_command_is_unknown_and_not_queued(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        device_uid = "3CDC7545CCD0"
        service.register_gateway_device(device_uid, sent.append)
        service.record_gateway_result(device_uid, {
            "device_uid": device_uid,
            "message": "status",
            "mode": "normal",
        })

        with self.assertRaisesRegex(RuntimeError, "unknown_command"):
            service.publish_command(
                device_uid,
                {"command": "reboot_to_os", "target_mode": "recovery", "request_id": "req-boot"},
            )

        self.assertEqual(sent, [])
        self.assertNotIn(device_uid, service._pending_commands)

    def test_mode_aware_command_gating_blocks_wrong_mode_commands_before_queue(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        device_uid = "3CDC7545CCD0"
        service.register_gateway_device(device_uid, sent.append)

        service.record_gateway_result(device_uid, {"device_uid": device_uid, "message": "status", "mode": "recovery"})
        with self.assertRaisesRegex(RuntimeError, "wrong_mode"):
            service.publish_command(device_uid, {"command": "set_scan_timing", "request_id": "req-scan"})

        service.record_gateway_result(device_uid, {"device_uid": device_uid, "message": "status", "mode": "normal"})
        with self.assertRaisesRegex(RuntimeError, "unknown_command"):
            service.publish_command(device_uid, {"command": "write_os", "request_id": "req-write"})

        with self.assertRaisesRegex(RuntimeError, "maintenance_required"):
            service.publish_command(device_uid, {"command": "file_write_begin", "path": "profile.json", "size": 1, "request_id": "req-file"})

        self.assertEqual(sent, [])
        self.assertNotIn(device_uid, service._pending_commands)

    def test_manual_calibration_commands_use_new_mode_gating_contract(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        device_uid = "3CDC7545CCD0"
        service.register_gateway_device(device_uid, sent.append)

        service.record_gateway_result(device_uid, {"device_uid": device_uid, "message": "status", "mode": "normal"})
        queued = service.publish_command(device_uid, {"command": "calibration_status", "request_id": "req-cal-status"})
        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(sent[-1]["payload"]["command"], "calibration_status")
        queued = service.publish_command(device_uid, {"command": "calibration_dump_tare", "request_id": "req-cal-dump-tare"})
        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(sent[-1]["payload"]["command"], "calibration_dump_tare")

        with self.assertRaisesRegex(RuntimeError, "maintenance_required"):
            service.publish_command(device_uid, {"command": "calibration_session_begin", "request_id": "req-cal-begin"})
        with self.assertRaisesRegex(RuntimeError, "maintenance_required"):
            service.publish_command(device_uid, {"command": "calibration_capture_tare", "request_id": "req-cal-tare"})

        service.record_gateway_result(device_uid, {"device_uid": device_uid, "message": "status", "mode": "maintenance"})
        queued = service.publish_command(device_uid, {"command": "calibration_session_begin", "request_id": "req-cal-begin-2"})
        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(sent[-1]["payload"]["command"], "calibration_session_begin")
        queued = service.publish_command(device_uid, {"command": "calibration_capture_tare", "request_id": "req-cal-tare-2"})
        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(sent[-1]["payload"]["command"], "calibration_capture_tare")

    def test_reboot_command_is_plain_arduino_command_without_boot_transition(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []
        device_uid = "3CDC7545CCD0"
        service.register_gateway_device(device_uid, sent.append)
        service.record_gateway_result(device_uid, {
            "device_uid": device_uid,
            "message": "status",
            "mode": "normal",
        })

        queued = service.publish_command(device_uid, {"command": "reboot", "request_id": "req-reboot"})

        self.assertEqual(queued["transport"], "gateway_wss")
        self.assertEqual(sent[-1]["payload"]["command"], "reboot")
        self.assertIn("req-reboot", service._pending_commands.get(device_uid, {}))
        self.assertNotIn(device_uid, service._boot_transitions)

    def test_gateway_registry_tracks_upstream_gateways(self):
        service = NewHorizonsService(mock_mode=False)
        sent = []

        service.register_gateway("gw-main", sent.append, {"gateway_name": "Bench Gateway", "version": "0.4.0"})

        snapshot = service.gateway_snapshot()
        self.assertEqual(len(snapshot), 1)
        self.assertEqual(snapshot[0]["gateway_id"], "gw-main")
        self.assertEqual(snapshot[0]["gateway_name"], "Bench Gateway")
        self.assertEqual(snapshot[0]["status"], "online")

    def test_delete_gateway_removes_registry_and_marks_devices_offline(self):
        service = NewHorizonsService(mock_mode=False)
        events = []
        service.add_event_listener(events.append)
        sent = []

        service.register_gateway("gw-main", sent.append, {"gateway_name": "Bench Gateway"})
        service.record_gateway_summary("gw-main", {
            "gateway_name": "Bench Gateway",
            "state": {
                "devices": [{
                    "device_uid": "3CDC7545CCD0",
                    "connected": True,
                    "findme_state": "attached",
                }],
            },
        })

        deleted = service.delete_gateway("gw-main")

        self.assertTrue(deleted)
        self.assertEqual(service.gateway_snapshot(), [])
        device = service.list_devices()[0]
        self.assertFalse(device["gateway_connected"])
        self.assertEqual(device["gateway_id"], "")
        self.assertTrue(any(event.get("type") == "device_update" and event.get("item", {}).get("device_uid") == "3CDC7545CCD0" for event in events))

    def test_gateway_claim_request_routes_switch_command_to_current_gateway(self):
        service = NewHorizonsService(mock_mode=False)
        current_sent = []
        target_sent = []
        service.register_gateway("gw-current", current_sent.append, {"gateway_name": "Current Gateway"})
        service.register_gateway("gw-target", target_sent.append, {"gateway_name": "Target Gateway"})
        service.register_gateway_device("3CDC7545CCD0", current_sent.append, gateway_id="gw-current")

        claim = service.handle_gateway_claim_request(
            "gw-target",
            {"device_uid": "3CDC7545CCD0", "claim_id": "claim-1", "ttl_ms": 30000},
        )

        self.assertEqual(claim["state"], "switch_command_queued")
        self.assertEqual(current_sent[-1]["type"], "command")
        self.assertEqual(current_sent[-1]["device_uid"], "3CDC7545CCD0")
        payload = current_sent[-1]["payload"]
        self.assertEqual(payload["command"], "findme_switch_gateway")
        self.assertEqual(payload["preferred_gateway_id"], "gw-target")
        self.assertEqual(payload["claim_id"], "claim-1")
        self.assertEqual(payload["ttl_ms"], 30000)
        self.assertEqual(target_sent[-1]["type"], "gateway_claim_update")
        self.assertEqual(target_sent[-1]["claim_id"], "claim-1")

    def test_gateway_summary_reconciles_claim_state(self):
        service = NewHorizonsService(mock_mode=False)
        events = []
        service.add_event_listener(events.append)
        service.register_gateway("gw-target", events.append, {"gateway_name": "Target Gateway"})

        service.record_gateway_summary("gw-target", {
            "gateway_name": "Target Gateway",
            "state": {
                "devices": [{"device_uid": "3CDC7545CCD0", "connected": True}],
                "claims": [{
                    "claim_id": "claim-1",
                    "device_uid": "3CDC7545CCD0",
                    "state": "attached",
                    "last_error": "",
                }],
            },
        })

        snapshot = service.gateway_snapshot()
        self.assertEqual(snapshot[0]["claims"][0]["claim_id"], "claim-1")
        self.assertEqual(snapshot[0]["claims"][0]["state"], "attached")
        self.assertTrue(any(event.get("type") == "gateway_claim_update" and event.get("state") == "attached" for event in events))

    def test_gateway_binary_packet_updates_visualization_cache(self):
        service = NewHorizonsService(mock_mode=False)
        device_uid = "3CDC7545CCD0"
        packet = bytearray(20 + 4)
        struct.pack_into("<HBB", packet, 0, 0xA55A, 2, 0)
        packet[4:10] = bytes.fromhex(device_uid)
        struct.pack_into("<IIH", packet, 10, 1, 123456, 4)
        struct.pack_into("<f", packet, 20, 315.0)

        service.record_gateway_packet(bytes(packet))

        latest = service.latest_visualization(device_uid)
        self.assertEqual(len(latest), 1)
        self.assertEqual(latest[0]["device_uid"], device_uid)
        self.assertEqual(latest[0]["p"], [315.0])

    def test_visualization_payload_includes_backend_udp_fps_per_device(self):
        service = NewHorizonsService(mock_mode=False)
        device_uid = "3CDC7545CCD0"
        events = []
        service.add_event_listener(events.append)

        for frame_id in range(3):
            packet = bytearray(20 + 4)
            struct.pack_into("<HBB", packet, 0, 0xA55A, 3, 0)
            packet[4:10] = bytes.fromhex(device_uid)
            struct.pack_into("<IIH", packet, 10, frame_id + 1, 123456 + frame_id, 4)
            struct.pack_into("<f", packet, 20, 315.0 + frame_id)
            service.record_gateway_packet(bytes(packet))

        latest = service.latest_visualization(device_uid)[0]
        self.assertGreaterEqual(latest["device_udp_fps"], 3)
        self.assertIn("received_at_ms", latest)
        visualization_updates = [event for event in events if event.get("type") == "visualization_update"]
        self.assertGreaterEqual(visualization_updates[-1]["data"]["device_udp_fps"], 3)

    def test_arduino_v3_stream_does_not_emit_device_update_for_every_frame(self):
        service = NewHorizonsService(mock_mode=False)
        events = []
        service.add_event_listener(events.append)
        device_uid = "3CDC7545CCD0"

        for frame_id in range(5):
            packet = bytearray(20 + 4)
            struct.pack_into("<HBB", packet, 0, 0xA55A, 3, 0)
            packet[4:10] = bytes.fromhex(device_uid)
            struct.pack_into("<IIH", packet, 10, frame_id + 1, 123456 + frame_id, 4)
            struct.pack_into("<f", packet, 20, 315.0 + frame_id)
            service.record_gateway_packet(bytes(packet))

        visualization_updates = [event for event in events if event.get("type") == "visualization_update"]
        device_updates = [event for event in events if event.get("type") == "device_update"]
        self.assertEqual(len(visualization_updates), 5)
        self.assertLessEqual(len(device_updates), 1)

    def test_recording_writes_every_received_frame_before_ui_visualization_coalescing(self):
        previous_data_root = os.environ.get("NEWHORIZONS_DATA_ROOT")
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["NEWHORIZONS_DATA_ROOT"] = tmpdir
            try:
                service = NewHorizonsService(mock_mode=False)
                device_uid = "3CDC7545CCD0"
                service.set_recording_enabled(device_uid, True)

                for frame_id in range(5):
                    packet = bytearray(20 + 4)
                    struct.pack_into("<HBB", packet, 0, 0xA55A, 3, 0)
                    packet[4:10] = bytes.fromhex(device_uid)
                    struct.pack_into("<IIH", packet, 10, frame_id + 1, 123456 + frame_id, 4)
                    struct.pack_into("<f", packet, 20, 315.0 + frame_id)
                    service.record_gateway_packet(bytes(packet))

                csv_files = list(Path(tmpdir).glob(f"{device_uid}/**/*.csv"))
                self.assertEqual(len(csv_files), 1)
                with csv_files[0].open(newline="", encoding="utf-8") as handle:
                    rows = list(csv.reader(handle))
                self.assertEqual(len(rows), 6)
                self.assertEqual([float(row[1]) for row in rows[1:]], [315.0, 316.0, 317.0, 318.0, 319.0])
            finally:
                if previous_data_root is None:
                    os.environ.pop("NEWHORIZONS_DATA_ROOT", None)
                else:
                    os.environ["NEWHORIZONS_DATA_ROOT"] = previous_data_root

    def test_gateway_ws_accepts_json_status_and_registers_device(self):
        service = NewHorizonsService(mock_mode=False)
        ws = FakeGatewayWebSocket([
            json_text({"type": "hello", "gateway_id": "gw-main", "gateway_name": "Bench Gateway"}),
            json_text({
                "type": "device_status",
                "gateway_id": "gw-main",
                "device_uid": "3CDC7545CCD0",
                "payload": {
                    "device_uid": "3CDC7545CCD0",
                    "device_name": "New Horizons OS-3CDC7545CCD0",
                    "mode": "normal",
                },
            }),
            None,
        ])

        GatewaySocketSession(service, ws).handle()

        devices = {item["device_uid"]: item for item in service.list_devices()}
        self.assertIn("3CDC7545CCD0", devices)
        self.assertEqual(devices["3CDC7545CCD0"]["mode"], "normal")
        self.assertFalse(devices["3CDC7545CCD0"]["gateway_connected"])

    def test_gateway_ws_accepts_json_bytes_status_and_registers_device(self):
        service = NewHorizonsService(mock_mode=False)
        ws = FakeGatewayWebSocket([
            json_text({"type": "hello", "gateway_id": "gw-main", "gateway_name": "Bench Gateway"}).encode(),
            json_text({
                "type": "device_status",
                "gateway_id": "gw-main",
                "device_uid": "3CDC7545CCD0",
                "payload": {
                    "device_uid": "3CDC7545CCD0",
                    "device_name": "New Horizons OS-3CDC7545CCD0",
                    "mode": "maintenance",
                },
            }).encode(),
            None,
        ])

        GatewaySocketSession(service, ws).handle()

        devices = {item["device_uid"]: item for item in service.list_devices()}
        self.assertIn("3CDC7545CCD0", devices)
        self.assertEqual(devices["3CDC7545CCD0"]["mode"], "maintenance")

    def test_gateway_ws_routes_raw_binary_packet_to_service(self):
        service = NewHorizonsService(mock_mode=False)
        device_uid = "3CDC7545CCD0"
        packet = bytearray(20 + 4)
        struct.pack_into("<HBB", packet, 0, 0xA55A, 2, 0)
        packet[4:10] = bytes.fromhex(device_uid)
        struct.pack_into("<IIH", packet, 10, 1, 123456, 4)
        struct.pack_into("<f", packet, 20, 315.0)
        ws = FakeGatewayWebSocket([bytes(packet), None])

        GatewaySocketSession(service, ws).handle()

        latest = service.latest_visualization(device_uid)
        self.assertEqual(len(latest), 1)
        self.assertEqual(latest[0]["device_uid"], device_uid)

    def test_gateway_ws_routes_packet_text_envelope_to_service(self):
        service = NewHorizonsService(mock_mode=False)
        device_uid = "3CDC7545CCD0"
        packet = bytearray(20 + 4)
        struct.pack_into("<HBB", packet, 0, 0xA55A, 2, 0)
        packet[4:10] = bytes.fromhex(device_uid)
        struct.pack_into("<IIH", packet, 10, 1, 123456, 4)
        struct.pack_into("<f", packet, 20, 315.0)
        ws = FakeGatewayWebSocket([
            PACKET_TEXT_PREFIX + base64.b64encode(bytes(packet)).decode("ascii"),
            None,
        ])

        GatewaySocketSession(service, ws).handle()

        latest = service.latest_visualization(device_uid)
        self.assertEqual(len(latest), 1)
        self.assertEqual(latest[0]["device_uid"], device_uid)

    def test_memory_status_is_treated_as_status_like_result(self):
        result = NewHorizonsService._result_from_pending_status(
            "memory_status",
            "req-memory",
            {"memory": {"free": 81920}, "mode": "normal"},
            {},
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["command"], "memory_status")
        self.assertEqual(result["request_id"], "req-memory")
        self.assertEqual(result["status"], "ok")

    def test_scan_health_is_treated_as_status_like_result(self):
        result = NewHorizonsService._result_from_pending_status(
            "scan_health",
            "req-health",
            {"measured_scan_fps": 42, "mode": "normal"},
            {},
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["command"], "scan_health")
        self.assertEqual(result["request_id"], "req-health")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["measured_scan_fps"], 42)

    def test_mock_check_update_uses_arduino_update_contract(self):
        service = NewHorizonsService(mock_mode=True)
        device_uid = "NH-MOCK-002"

        queued = service.publish_command(device_uid, {"command": "check_update", "manifest_url": "https://example.com/arduino-latest.json", "request_id": "req-check"})
        devices = {item["device_uid"]: item for item in service.list_devices()}
        latest = devices[device_uid]
        result = latest["last_result"]

        self.assertEqual(queued["status"], "queued")
        self.assertEqual(result["message"], "update_checked")
        self.assertEqual(result["version"], "v0.5.1")
        self.assertEqual(latest["last_status"]["update_state"]["operation"], "check_update")
        self.assertEqual(latest["last_status"]["update_state"]["manifest_url"], "https://example.com/arduino-latest.json")
        self.assertIn("changelog_url", latest["last_status"]["update_state"])

    def test_mock_set_scan_timing_stores_full_runtime_controls(self):
        service = NewHorizonsService(mock_mode=True)
        device_uid = "NH-MOCK-002"

        queued = service.publish_command(
            device_uid,
            {
                "command": "set_scan_timing",
                "target_fps": 75,
                "settle_us": 18,
                "send_every_n_frames": 3,
                "request_id": "req-scan",
            },
        )
        devices = {item["device_uid"]: item for item in service.list_devices()}
        latest = devices[device_uid]
        scan_timing = latest["last_status"]["runtime"]["scan_timing"]

        self.assertEqual(queued["status"], "queued")
        self.assertEqual(scan_timing["target_fps"], 75)
        self.assertEqual(scan_timing["settle_us"], 18)
        self.assertEqual(scan_timing["send_every_n_frames"], 3)

    def test_mock_set_imu_updates_optional_sensor_runtime(self):
        service = NewHorizonsService(mock_mode=True)
        device_uid = "NH-MOCK-002"

        queued = service.publish_command(
            device_uid,
            {"command": "set_imu", "enabled": False, "request_id": "req-imu"},
        )
        devices = {item["device_uid"]: item for item in service.list_devices()}
        latest = devices[device_uid]
        imu = latest["last_status"]["runtime"]["imu"]
        result = latest["last_result"]

        self.assertEqual(queued["status"], "queued")
        self.assertFalse(imu["enabled"])
        self.assertEqual(imu["state"], "disabled")
        self.assertEqual(result["message"], "imu_updated")
        self.assertEqual(result["imu"]["state"], "disabled")

    def test_mock_set_stream_buffer_updates_runtime_and_scan_health(self):
        service = NewHorizonsService(mock_mode=True)
        device_uid = "NH-MOCK-002"

        queued = service.publish_command(
            device_uid,
            {"command": "set_stream_buffer", "enabled": True, "mode": "extended", "request_id": "req-buffer"},
        )
        devices = {item["device_uid"]: item for item in service.list_devices()}
        latest = devices[device_uid]
        runtime = latest["last_status"]["runtime"]["stream_buffer"]
        scan_health = latest["last_status"]["scan_health"]
        result = latest["last_result"]

        self.assertEqual(queued["status"], "queued")
        self.assertTrue(runtime["enabled"])
        self.assertEqual(runtime["mode"], "extended")
        self.assertEqual(runtime["depth_frames"], 5)
        self.assertTrue(scan_health["queue_enabled"])
        self.assertEqual(scan_health["queue_capacity_frames"], 5)
        self.assertEqual(result["message"], "stream_buffer_updated")
        self.assertEqual(result["stream_buffer"]["mode"], "extended")

    def test_mock_set_log_updates_logging_runtime(self):
        service = NewHorizonsService(mock_mode=True)
        device_uid = "NH-MOCK-002"

        queued = service.publish_command(
            device_uid,
            {
                "command": "set_log",
                "enabled": True,
                "mode": "extended",
                "level": "debug",
                "max_bytes": 24576,
                "request_id": "req-log",
            },
        )
        devices = {item["device_uid"]: item for item in service.list_devices()}
        latest = devices[device_uid]

        self.assertEqual(queued["status"], "queued")
        self.assertEqual(latest["last_status"]["logging"]["mode"], "extended")
        self.assertEqual(latest["last_status"]["logging"]["level"], "debug")

    def test_apply_update_starting_progress_resets_previous_done_state(self):
        existing = {
            "phase": "done",
            "operation": "apply_update",
            "total_files": 1,
            "applied_files": 1,
            "last_result": "applied",
        }
        incoming = {
            "phase": "downloading",
            "operation": "apply_update",
            "total_files": 0,
            "applied_files": 0,
            "last_result": "starting",
            "current_file": "firmware manifest",
        }

        merged = NewHorizonsService._merge_update_state(existing, incoming, "normal", "normal")

        self.assertEqual(merged["phase"], "downloading")
        self.assertEqual(merged["last_result"], "starting")
        self.assertEqual(merged["current_file"], "firmware manifest")

    def test_status_firmware_version_match_marks_apply_update_done(self):
        existing = {
            "device_uid": "3CDC7545CCD0",
            "firmware_version": "v0.5.9",
            "update_state": {
                "phase": "downloading",
                "operation": "apply_update",
                "version": "v0.5.10",
                "total_files": 0,
                "applied_files": 0,
                "downloaded_files": 0,
                "skipped_files": 0,
                "current_file": "firmware",
                "last_error": "",
                "last_result": "starting",
                "reboot_required": True,
            },
        }
        incoming = {
            "device_uid": "3CDC7545CCD0",
            "firmware_version": "v0.5.10",
            "update_state": {
                "phase": "idle",
                "available": False,
                "version": "",
                "url": "",
                "size": 0,
                "manifest_url": "",
                "error": "",
            },
        }

        merged = NewHorizonsService._merge_device_entry(existing, incoming)

        self.assertEqual(merged["update_state"]["phase"], "done")
        self.assertEqual(merged["update_state"]["last_result"], "applied")
        self.assertEqual(merged["update_state"]["downloaded_files"], 1)
        self.assertEqual(merged["update_state"]["version"], "v0.5.10")

    def test_memory_status_result_updates_latest_status_cache(self):
        service = NewHorizonsService(mock_mode=False)
        payload = {
            "device_uid": "3CDC7545CCD0",
            "command": "memory_status",
            "message": "memory_status",
            "memory": {"heap_free": 81920, "heap_allocated": 40960, "heap_total": 122880},
        }

        service.record_gateway_result("3CDC7545CCD0", payload)

        devices = {item["device_uid"]: item for item in service.list_devices()}
        self.assertEqual(devices["3CDC7545CCD0"]["last_status"]["memory"]["heap_free"], 81920)

    def test_visualization_target_fps_tracks_device_scan_timing_without_rounding_or_cap(self):
        service = NewHorizonsService(mock_mode=False)
        self.assertEqual(service.visualization_target_fps("3CDC7545CCD0"), 60)

        service.record_gateway_result(
            "3CDC7545CCD0",
            {
                "device_uid": "3CDC7545CCD0",
                "command": "status",
                "message": "status",
                "runtime": {"scan_timing": {"target_fps": 123}},
            },
        )

        self.assertEqual(service.visualization_target_fps("3CDC7545CCD0"), 123)

    def test_enter_maintenance_result_without_mode_field_updates_device_mode(self):
        # The firmware enter_maintenance ack does not carry a "mode" field and
        # the device does not proactively push a status afterwards.  The mode
        # must still be recorded across UDP/gateway transports (not only the
        # synchronous TCP path).
        service = NewHorizonsService(mock_mode=False)
        device_uid = "3CDC7545CCD0"
        service.register_gateway_device(device_uid, lambda _msg: None)
        service.record_gateway_status(device_uid, {
            "device_uid": device_uid,
            "message": "status",
            "mode": "normal",
        })
        self.assertEqual((service.get_device(device_uid) or {}).get("mode"), "normal")

        service.record_gateway_result(device_uid, {
            "device_uid": device_uid,
            "ok": True,
            "cmd": "enter_maintenance",
            "message": "maintenance_entered",
            "request_id": "req-maint-1",
            "data": {},
        })
        self.assertEqual((service.get_device(device_uid) or {}).get("mode"), "maintenance")

    def test_maintenance_mode_survives_heartbeat_without_mode_field(self):
        service = NewHorizonsService(mock_mode=False)
        device_uid = "3CDC7545CCD0"
        service.register_gateway_device(device_uid, lambda _msg: None)
        service.record_gateway_result(device_uid, {
            "device_uid": device_uid,
            "ok": True,
            "cmd": "enter_maintenance",
            "message": "maintenance_entered",
            "request_id": "req-maint-2",
            "data": {},
        })
        self.assertEqual((service.get_device(device_uid) or {}).get("mode"), "maintenance")

        # A heartbeat/stream status without a mode field must not revert to normal.
        service.record_gateway_status(device_uid, {
            "device_uid": device_uid,
            "transport_path": "arduino_heartbeat",
        })
        self.assertEqual((service.get_device(device_uid) or {}).get("mode"), "maintenance")

    def test_exit_maintenance_result_without_mode_field_updates_device_mode(self):
        service = NewHorizonsService(mock_mode=False)
        device_uid = "3CDC7545CCD0"
        service.register_gateway_device(device_uid, lambda _msg: None)
        service.record_gateway_result(device_uid, {
            "device_uid": device_uid,
            "ok": True,
            "cmd": "enter_maintenance",
            "message": "maintenance_entered",
            "request_id": "req-maint-3",
            "data": {},
        })
        self.assertEqual((service.get_device(device_uid) or {}).get("mode"), "maintenance")

        service.record_gateway_result(device_uid, {
            "device_uid": device_uid,
            "ok": True,
            "cmd": "exit_maintenance",
            "message": "maintenance_exited",
            "request_id": "req-exit-1",
            "data": {},
        })
        self.assertEqual((service.get_device(device_uid) or {}).get("mode"), "normal")

    def test_gateway_status_normal_does_not_overwrite_known_maintenance_mode(self):
        # Regression: gateway_status fires every 5s with mode="normal" (before
        # FindMe updates gateway state).  The backend must not let a stale
        # gateway snapshot downgrade a maintenance mode it already knows about
        # from an authoritative enter_maintenance result (_latest_status).
        service = NewHorizonsService(mock_mode=False)
        gateway_id = "gw-001"
        device_uid = "3CDC7545CCD0"
        service.register_gateway_device(device_uid, lambda _msg: None, gateway_id=gateway_id)

        # Step 1: enter_maintenance result arrives → backend correctly knows "maintenance"
        service.record_gateway_result(device_uid, {
            "device_uid": device_uid,
            "ok": True,
            "cmd": "enter_maintenance",
            "message": "maintenance_entered",
            "request_id": "req-maint-1",
            "data": {},
        })
        self.assertEqual((service.get_device(device_uid) or {}).get("mode"), "maintenance")

        # Step 2: gateway_status fires with stale mode="normal" (gateway hasn't
        # received FindMe with "maintenance" yet).  Backend must NOT downgrade.
        service.record_gateway_summary(gateway_id, {
            "gateway_name": "test-gw",
            "gateway_id": gateway_id,
            "enabled": True,
            "version": "v0.2.2",
            "state": {
                "devices": [{
                    "device_uid": device_uid,
                    "device_name": "New Horizons OS-3CDC7545CCD0",
                    "mode": "normal",
                    "connected": True,
                    "findme_state": "attached",
                }],
                "denied_devices": [],
                "claims": [],
            },
        })
        self.assertEqual((service.get_device(device_uid) or {}).get("mode"), "maintenance",
                         "gateway_status with stale mode='normal' must not overwrite backend's known 'maintenance'")

    def test_gateway_status_normal_allowed_after_exit_maintenance(self):
        # After exit_maintenance, the backend's _latest_status has mode="normal".
        # A subsequent gateway_status with mode="normal" is legitimate and must
        # be accepted (the protection must not block valid normal-mode updates).
        service = NewHorizonsService(mock_mode=False)
        gateway_id = "gw-001"
        device_uid = "3CDC7545CCD0"
        service.register_gateway_device(device_uid, lambda _msg: None, gateway_id=gateway_id)

        service.record_gateway_result(device_uid, {
            "device_uid": device_uid,
            "ok": True,
            "cmd": "enter_maintenance",
            "message": "maintenance_entered",
            "request_id": "req-m1",
            "data": {},
        })
        service.record_gateway_result(device_uid, {
            "device_uid": device_uid,
            "ok": True,
            "cmd": "exit_maintenance",
            "message": "maintenance_exited",
            "request_id": "req-e1",
            "data": {},
        })
        self.assertEqual((service.get_device(device_uid) or {}).get("mode"), "normal")

        service.record_gateway_summary(gateway_id, {
            "gateway_name": "test-gw",
            "gateway_id": gateway_id,
            "enabled": True,
            "version": "v0.2.2",
            "state": {
                "devices": [{
                    "device_uid": device_uid,
                    "device_name": "New Horizons OS-3CDC7545CCD0",
                    "mode": "normal",
                    "connected": True,
                    "findme_state": "attached",
                }],
                "denied_devices": [],
                "claims": [],
            },
        })
        self.assertEqual((service.get_device(device_uid) or {}).get("mode"), "normal",
                         "gateway_status with mode='normal' must be accepted after exit_maintenance")


if __name__ == "__main__":
    unittest.main()
