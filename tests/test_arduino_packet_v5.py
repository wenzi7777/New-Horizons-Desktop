import struct
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.arduino_protocol import is_arduino_heartbeat_packet, is_arduino_stream_packet  # noqa: E402
from newhorizons_backend.packet_parser import PacketParseError, parse_binary_packet  # noqa: E402


def packet_v5(flags: int, body: bytes, *, frame_id: int = 51) -> bytes:
    packet = bytearray(24 + len(body))
    struct.pack_into("<HBB", packet, 0, 0xA55A, 5, flags)
    packet[4:10] = bytes.fromhex("3CDC7545CCD0")
    struct.pack_into("<IQH", packet, 10, frame_id, 1700000000123, len(body))
    packet[24:] = body
    return bytes(packet)


class ArduinoPacketV5ParserTest(unittest.TestCase):
    def test_v5_parses_mag_battery_soc_and_tlv_extensions(self):
        matrix = struct.pack("<2f", 1.25, 2.5)
        mag = struct.pack("<3f", 7.0, 8.0, 9.0)
        battery = struct.pack("<BBHH", 1, 2, 4175, 7350)
        extensions = bytes([0x21, 3]) + b"abc"

        parsed = parse_binary_packet(packet_v5(0x02 | 0x04 | 0x20 | 0x10, matrix + mag + battery + extensions), sensor_count=2)

        self.assertEqual(parsed["packet_version"], 5)
        self.assertEqual(parsed["p"], [1.25, 2.5])
        self.assertEqual(parsed["mag"], [7.0, 8.0, 9.0])
        self.assertEqual(parsed["battery"], {"status": 1, "fault": 2, "vbat_mv": 4175, "soc_centi_percent": 7350, "soc_percent": 73.5})
        self.assertEqual(parsed["extensions"], [{"type": 0x21, "value": b"abc"}])
        self.assertEqual(parsed["device_epoch_ms"], 1700000000123)

    def test_v5_omits_mag_and_battery_without_fake_values(self):
        parsed = parse_binary_packet(packet_v5(0, struct.pack("<2f", 4.0, 5.0)))

        self.assertEqual(parsed["p"], [4.0, 5.0])
        self.assertIsNone(parsed["mag"])
        self.assertIsNone(parsed["battery"])
        self.assertEqual(parsed["extensions"], [])

    def test_v5_extensions_require_an_authoritative_sensor_count(self):
        with self.assertRaisesRegex(PacketParseError, "sensor_count_required_for_extensions"):
            parse_binary_packet(packet_v5(0x20, struct.pack("<f", 1.0) + bytes([0x22, 1, 0xAA])))

    def test_v5_rejects_extension_length_past_payload_with_known_sensor_count(self):
        with self.assertRaisesRegex(PacketParseError, "invalid_extension_layout"):
            parse_binary_packet(packet_v5(0x20, struct.pack("<f", 1.0) + bytes([0x22, 4, 0xAA])), sensor_count=1)

    def test_v5_rejects_trailing_extension_stride_with_known_sensor_count(self):
        with self.assertRaisesRegex(PacketParseError, "invalid_extension_layout"):
            parse_binary_packet(packet_v5(0x20, struct.pack("<f", 1.0) + bytes([0x22, 1, 0xAA, 0xFF])), sensor_count=1)

    def test_v5_stream_and_heartbeat_detectors_accept_24_byte_header(self):
        stream = packet_v5(0, struct.pack("<f", 1.0))
        heartbeat = packet_v5(0x80, b"")

        self.assertTrue(is_arduino_stream_packet(stream))
        self.assertTrue(is_arduino_stream_packet(heartbeat))
        self.assertTrue(is_arduino_heartbeat_packet(heartbeat))

    def test_v3_and_v4_battery_remain_legacy_three_field_payloads(self):
        for version, header_len, tail_format in ((3, 20, "<IIH"), (4, 24, "<IQH")):
            body = struct.pack("<fBBH", 3.0, 1, 0, 4190)
            packet = bytearray(header_len + len(body))
            struct.pack_into("<HBB", packet, 0, 0xA55A, version, 0x02)
            packet[4:10] = bytes.fromhex("3CDC7545CCD0")
            struct.pack_into(tail_format, packet, 10, 1, 2, len(body))
            packet[header_len:] = body

            parsed = parse_binary_packet(bytes(packet))
            self.assertEqual(parsed["battery"], {"status": 1, "fault": 0, "vbat_mv": 4190})
            self.assertNotIn("soc_percent", parsed["battery"])
