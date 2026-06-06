import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402


def arduino_packet(device_uid: bytes = bytes.fromhex("3CDC7545CCD0")) -> bytes:
    packet = bytearray(20 + 4)
    struct.pack_into("<HBB", packet, 0, 0xA55A, 3, 0)
    packet[4:10] = device_uid
    struct.pack_into("<IIH", packet, 10, 7, 1234, 4)
    packet[20:] = b"\x00\x00\x00\x00"
    return bytes(packet)


def arduino_heartbeat_packet(device_uid: bytes = bytes.fromhex("3CDC7545CCD0")) -> bytes:
    packet = bytearray(20)
    struct.pack_into("<HBB", packet, 0, 0xA55A, 3, 0x80)
    packet[4:10] = device_uid
    struct.pack_into("<IIH", packet, 10, 8, 5000, 0)
    return bytes(packet)


class ArduinoControlTcpTest(unittest.TestCase):
    def test_arduino_v3_stream_packet_registers_tcp_control_route(self):
        service = NewHorizonsService(mock_mode=False)
        service._udp_ingest = object()
        service._handle_udp_datagram(arduino_packet(), ("192.168.50.44", 49152))

        discovered = service.get_device("3CDC7545CCD0")
        self.assertEqual(discovered["device_name"], "New Horizons OS-3CDC7545CCD0")

        with patch.object(service, "_send_arduino_command") as send_tcp:
            send_tcp.return_value = {
                "ok": True,
                "cmd": "status",
                "message": "status",
                "data": {
                    "device_name": "New Horizons OS-3CDC7545CCD0",
                    "mode": "normal",
                    "protocol": "NHO/Arduino/1",
                    "firmware_version": "v0.6.2",
                    "hardware_model": "VD-CTL/R v1.0.F 2026.4",
                    "matrix_shape": {"rows": 10, "cols": 21},
                },
            }

            queued = service.publish_command("3CDC7545CCD0", {"command": "status", "request_id": "req-1"})

        self.assertEqual(queued["transport"], "arduino_tcp")
        send_tcp.assert_called_once()
        self.assertEqual(send_tcp.call_args.args[0], "192.168.50.44")
        self.assertEqual(send_tcp.call_args.args[1]["command"], "status")
        self.assertEqual(send_tcp.call_args.kwargs["port"], 22345)
        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["gateway_connected"], True)
        self.assertEqual(device["mode"], "normal")
        self.assertEqual(service._arduino_control_sessions["3CDC7545CCD0"], ("192.168.50.44", 22345))
        self.assertNotIn("3CDC7545CCD0", service._udp_control_sessions)

    def test_arduino_heartbeat_registers_tcp_control_route_without_visualization_frame(self):
        service = NewHorizonsService(mock_mode=False)
        service._udp_ingest = object()
        service._handle_udp_datagram(arduino_heartbeat_packet(), ("192.168.50.44", 49152))

        discovered = service.get_device("3CDC7545CCD0")
        self.assertEqual(discovered["device_name"], "New Horizons OS-3CDC7545CCD0")
        self.assertEqual(discovered["gateway_connected"], True)
        self.assertEqual(discovered["transport_path"], "arduino_heartbeat")
        self.assertEqual(discovered["findme"]["state"], "attached")
        self.assertEqual(discovered["findme"]["host"], "192.168.50.44")
        self.assertEqual(discovered["findme"]["udp_port"], 13250)
        self.assertEqual(service.latest_visualization("3CDC7545CCD0"), [])

        with patch.object(service, "_send_arduino_command") as send_tcp:
            send_tcp.return_value = {
                "ok": True,
                "cmd": "status",
                "message": "status",
                "data": {
                    "device_name": "New Horizons OS-3CDC7545CCD0",
                    "mode": "normal",
                    "protocol": "NHO/Arduino/1",
                },
            }
            queued = service.publish_command("3CDC7545CCD0", {"command": "status", "request_id": "req-heartbeat"})

        self.assertEqual(queued["transport"], "arduino_tcp")
        self.assertEqual(send_tcp.call_args.args[0], "192.168.50.44")
        self.assertEqual(send_tcp.call_args.kwargs["port"], 22345)
        self.assertEqual(service._arduino_control_sessions["3CDC7545CCD0"], ("192.168.50.44", 22345))
        self.assertNotIn("3CDC7545CCD0", service._udp_control_sessions)

    def test_udp_control_session_is_reserved_for_json_control_frames(self):
        service = NewHorizonsService(mock_mode=False)
        service._udp_ingest = object()
        service._handle_udp_datagram(arduino_packet(), ("192.168.50.44", 49152))

        self.assertNotIn("3CDC7545CCD0", service._udp_control_sessions)

        service._handle_udp_control_datagram(
            b'{"type":"status","device_uid":"3CDC7545CCD0","payload":{"mode":"normal","protocol":"NHO/Arduino/1"}}',
            ("192.168.50.44", 22345),
        )

        self.assertEqual(service._udp_control_sessions["3CDC7545CCD0"], ("192.168.50.44", 22345))

    def test_partial_arduino_status_response_preserves_identity_fields(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_arduino_response(
            "3CDC7545CCD0",
            {"command": "status", "request_id": "req-status"},
            {
                "ok": True,
                "cmd": "status",
                "message": "status",
                "data": {
                    "protocol": "NHO/Arduino/1",
                    "mode": "normal",
                    "firmware_version": "v0.5.0",
                    "hardware_model": "VD-CTL/R v1.0.F 2026.4",
                    "matrix_shape": {"rows": 10, "cols": 21},
                },
                "error": "",
            },
        )
        service._record_arduino_response(
            "3CDC7545CCD0",
            {"command": "memory_status", "request_id": "req-memory"},
            {
                "ok": True,
                "cmd": "memory_status",
                "message": "memory_status",
                "data": {
                    "heap_free": 123456,
                    "heap_largest_free_block": 98765,
                },
                "error": "",
            },
        )

        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["firmware_version"], "v0.5.0")
        self.assertEqual(device["hardware_model"], "VD-CTL/R v1.0.F 2026.4")
        self.assertEqual(device["matrix_shape"], {"rows": 10, "cols": 21})
        self.assertEqual(device["last_status"]["firmware_version"], "v0.5.0")
        self.assertEqual(device["last_status"]["memory"]["heap_free"], 123456)
        self.assertEqual(device["system_summary"]["firmware_version"], "v0.5.0")

    def test_arduino_matrix_layout_response_updates_status_cache(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_arduino_response(
            "3CDC7545CCD0",
            {
                "command": "set_matrix_layout",
                "request_id": "req-layout",
                "analog_pins": [1, 2, 3],
                "select_pins": [13, 14, 15, 16],
            },
            {
                "ok": True,
                "cmd": "set_matrix_layout",
                "message": "matrix_layout_updated",
                "data": {
                    "matrix_shape": {"rows": 3, "cols": 4},
                    "matrix_layout": {
                        "analog_pins": [1, 2, 3],
                        "select_pins": [13, 14, 15, 16],
                    },
                    "scan_health": {"point_count": 12},
                },
                "error": "",
            },
        )

        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["matrix_shape"], {"rows": 3, "cols": 4})
        self.assertEqual(device["last_status"]["matrix_layout"]["analog_pins"], [1, 2, 3])
        self.assertEqual(device["last_status"]["matrix_layout"]["select_pins"], [13, 14, 15, 16])
        self.assertEqual(device["last_status"]["scan_health"]["point_count"], 12)

    def test_arduino_matrix_layout_response_clears_incompatible_visualization_cache(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_parsed(
            "3CDC7545CCD0",
            {
                "dn": "3CDC7545CCD0",
                "sn": 1,
                "p": [float(index) for index in range(210)],
            },
            "udp",
        )

        self.assertEqual(len(service.latest_visualization("3CDC7545CCD0")[0]["p"]), 210)

        service._record_arduino_response(
            "3CDC7545CCD0",
            {
                "command": "set_matrix_layout",
                "request_id": "req-layout",
                "analog_pins": [1, 2, 3],
                "select_pins": [13, 14, 15, 16],
            },
            {
                "ok": True,
                "cmd": "set_matrix_layout",
                "message": "matrix_layout_updated",
                "data": {
                    "matrix_shape": {"rows": 3, "cols": 4},
                    "matrix_layout": {
                        "analog_pins": [1, 2, 3],
                        "select_pins": [13, 14, 15, 16],
                    },
                },
                "error": "",
            },
        )

        self.assertEqual(service.latest_visualization("3CDC7545CCD0"), [])

    def test_arduino_scan_timing_response_updates_status_cache(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_arduino_response(
            "3CDC7545CCD0",
            {"command": "set_scan_timing", "request_id": "req-scan", "target_fps": 90, "settle_us": 15, "send_every_n_frames": 1},
            {
                "ok": True,
                "cmd": "set_scan_timing",
                "message": "scan_timing_updated",
                "data": {
                    "runtime": {"scan_timing": {"target_fps": 90, "settle_us": 15, "send_every_n_frames": 1}},
                    "scan_health": {"requested_target_fps": 90, "settle_us": 15, "send_every_n_frames": 1},
                },
                "error": "",
            },
        )

        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["last_status"]["runtime"]["scan_timing"]["target_fps"], 90)
        self.assertEqual(service.visualization_target_fps("3CDC7545CCD0"), 90)

    def test_arduino_storage_status_response_updates_status_cache(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_arduino_response(
            "3CDC7545CCD0",
            {"command": "storage_status", "request_id": "req-storage"},
            {
                "ok": True,
                "cmd": "storage_status",
                "message": "storage_status",
                "data": {
                    "total_bytes": 1000,
                    "used_bytes": 400,
                    "free_bytes": 600,
                    "categories": [
                        {"scope": "user", "bytes": 120},
                        {"scope": "logs", "bytes": 80},
                    ],
                },
                "error": "",
            },
        )

        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["last_status"]["storage"]["total_bytes"], 1000)
        self.assertEqual(device["last_status"]["storage"]["categories"][0]["scope"], "user")

    def test_arduino_imu_response_updates_runtime_status_and_filter_is_not_ui_command(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_arduino_response(
            "3CDC7545CCD0",
            {"command": "set_imu", "request_id": "req-imu", "enabled": True},
            {"ok": True, "cmd": "set_imu", "message": "config_stored", "data": {}, "error": ""},
        )

        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["last_status"]["imu"]["enabled"], True)
        self.assertNotEqual(device["last_status"]["imu"].get("state"), "deferred")

    def test_arduino_log_config_response_updates_status_cache(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_arduino_response(
            "3CDC7545CCD0",
            {"command": "set_log", "request_id": "req-log", "enabled": True, "level": "debug", "mode": "extended"},
            {
                "ok": True,
                "cmd": "set_log",
                "message": "log_config_updated",
                "data": {
                    "logging": {
                        "enabled": True,
                        "level": "debug",
                        "mode": "extended",
                        "max_bytes": 32768,
                    }
                },
                "error": "",
            },
        )

        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["last_status"]["logging"]["mode"], "extended")
        self.assertEqual(device["last_status"]["logging"]["max_bytes"], 32768)

    def test_arduino_charge_profile_response_updates_battery_status(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_arduino_response(
            "3CDC7545CCD0",
            {"command": "set_charge_profile", "request_id": "req-charge", "profile": "fast"},
            {
                "ok": True,
                "cmd": "set_charge_profile",
                "message": "charge_profile_updated",
                "data": {
                    "battery": {
                        "charger": "bq25180",
                        "configured": True,
                        "profile": "fast",
                        "charge_current_ma": 300,
                        "input_limit_ma": 500,
                    }
                },
                "error": "",
            },
        )

        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["last_status"]["battery"]["profile"], "fast")
        self.assertEqual(device["last_status"]["battery"]["charge_current_ma"], 300)
        self.assertEqual(device["last_result"]["battery"]["input_limit_ma"], 500)

    def test_arduino_indicator_response_updates_external_led_and_oled_config(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_arduino_response(
            "3CDC7545CCD0",
            {
                "command": "set_indicators",
                "request_id": "req-indicators",
                "external_led": {"mode": "enabled", "preset": "stream_health", "brightness": 0.4},
                "oled": {"mode": "auto", "page": "live_status", "update_hz": 1, "contrast": 128},
            },
            {
                "ok": True,
                "cmd": "set_indicators",
                "message": "config_stored",
                "data": {
                    "indicators": {
                        "external_led": {
                            "mode": "enabled",
                            "preset": "stream_health",
                            "brightness": 0.4,
                            "count": 3,
                            "pin": 12,
                            "initialized": True,
                            "last_show_ms": 1234,
                            "last_error": "",
                        },
                        "oled": {
                            "mode": "auto",
                            "enabled": True,
                            "detected": True,
                            "addr": "0x3C",
                            "page": "live_status",
                        },
                        "status_led": {"role": "system_status"},
                    },
                    "config": {"loaded": True, "schema_version": 1},
                },
                "error": "",
            },
        )

        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["last_status"]["indicators"]["external_led"]["mode"], "enabled")
        self.assertEqual(device["last_status"]["indicators"]["external_led"]["count"], 3)
        self.assertEqual(device["last_status"]["indicators"]["external_led"]["pin"], 12)
        self.assertEqual(device["last_status"]["indicators"]["external_led"]["initialized"], True)
        self.assertEqual(device["last_status"]["indicators"]["oled"]["mode"], "auto")
        self.assertEqual(device["last_status"]["indicators"]["oled"]["detected"], True)
        self.assertEqual(device["last_status"]["config"]["schema_version"], 1)

    def test_arduino_power_state_response_updates_power_status_cache(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_arduino_response(
            "3CDC7545CCD0",
            {"command": "power_set_state", "request_id": "req-power", "state": "soft_off_auto"},
            {
                "ok": True,
                "cmd": "power_set_state",
                "message": "power_state_updated",
                "data": {
                    "power": {
                        "state": "soft_off_charging",
                        "wake_source": "command",
                        "soft_off_reason": "command",
                        "charger_present": True,
                        "charge_state": "charging",
                    }
                },
                "error": "",
            },
        )

        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["last_status"]["power"]["state"], "soft_off_charging")
        self.assertEqual(device["last_status"]["power"]["wake_source"], "command")
        self.assertEqual(device["last_result"]["power"]["charge_state"], "charging")

    def test_arduino_heartbeat_preserves_cached_indicator_status(self):
        service = NewHorizonsService(mock_mode=False)
        service._record_arduino_response(
            "3CDC7545CCD0",
            {"command": "status", "request_id": "req-status"},
            {
                "ok": True,
                "cmd": "status",
                "message": "status",
                "data": {
                    "protocol": "NHO/Arduino/1",
                    "mode": "normal",
                    "indicators": {
                        "external_led": {
                            "mode": "enabled",
                            "preset": "stream_health",
                            "brightness": 0.35,
                            "count": 3,
                            "pin": 12,
                            "initialized": True,
                            "last_show_ms": 1234,
                            "last_error": "",
                        },
                        "oled": {
                            "mode": "off",
                            "detected": False,
                            "addr": "",
                            "last_error": "",
                        },
                    },
                },
                "error": "",
            },
        )

        service._handle_udp_datagram(arduino_heartbeat_packet(), ("192.168.50.44", 49152))

        device = service.get_device("3CDC7545CCD0")
        self.assertEqual(device["last_status"]["transport_path"], "arduino_heartbeat")
        self.assertEqual(device["last_status"]["indicators"]["external_led"]["pin"], 12)
        self.assertEqual(device["last_status"]["indicators"]["external_led"]["count"], 3)
        self.assertEqual(device["last_status"]["indicators"]["external_led"]["initialized"], True)
        self.assertEqual(device["last_status"]["indicators"]["oled"]["mode"], "off")

    def test_udp_control_failure_clears_stale_session(self):
        service = NewHorizonsService(mock_mode=False)
        service._udp_ingest = object()
        service._handle_udp_datagram(arduino_heartbeat_packet(), ("192.168.50.44", 49152))

        with patch.object(service, "_send_udp_command", side_effect=RuntimeError("udp unavailable")):
            with self.assertRaisesRegex(RuntimeError, "device_control_unavailable"):
                service.publish_command("3CDC7545CCD0", {"command": "status", "request_id": "req-fail"})

        self.assertNotIn("3CDC7545CCD0", service._udp_control_sessions)


if __name__ == "__main__":
    unittest.main()
