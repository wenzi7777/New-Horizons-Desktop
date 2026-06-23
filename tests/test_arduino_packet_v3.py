import struct
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.packet_parser import parse_binary_packet  # noqa: E402


class ArduinoPacketV3ParserTest(unittest.TestCase):
    def test_parse_arduino_packet_v3_with_imu_and_battery(self):
        flags = 0x01 | 0x02
        device_uid = bytes.fromhex("3CDC7545CCD0")
        matrix = struct.pack("<3f", 1.25, 2.5, 3.75)
        imu = struct.pack("<7f", 0.1, 0.2, 0.3, 4.0, 5.0, 6.0, 27.5)
        battery = struct.pack("<BBH", 1, 0, 4190)
        body = matrix + imu + battery
        packet = bytearray(20 + len(body))
        struct.pack_into("<HBB", packet, 0, 0xA55A, 3, flags)
        packet[4:10] = device_uid
        struct.pack_into("<IIH", packet, 10, 42, 123456, len(body))
        packet[20:] = body

        parsed = parse_binary_packet(bytes(packet))

        self.assertEqual(parsed["protocol"], "NHO/Arduino/1")
        self.assertEqual(parsed["packet_version"], 3)
        self.assertEqual(parsed["device_uid"], "3CDC7545CCD0")
        self.assertEqual(parsed["sn"], 3)
        self.assertEqual(parsed["p"], [1.25, 2.5, 3.75])
        self.assertEqual(parsed["acc"], [0.1, 0.2, 0.3])
        self.assertEqual(parsed["gyro"], [4.0, 5.0, 6.0])
        self.assertEqual(parsed["battery"], {"status": 1, "fault": 0, "vbat_mv": 4190})

    def test_parse_arduino_packet_v3_with_magnetometer_extension(self):
        flags = 0x01 | 0x04
        device_uid = bytes.fromhex("3CDC7545CCD0")
        matrix = struct.pack("<4f", 1.25, 2.5, 3.75, 5.0)
        imu = struct.pack("<7f", 0.1, 0.2, 0.3, 4.0, 5.0, 6.0, 27.5)
        mag = struct.pack("<3f", 7.0, 8.0, 9.0)
        body = matrix + imu + mag
        packet = bytearray(20 + len(body))
        struct.pack_into("<HBB", packet, 0, 0xA55A, 3, flags)
        packet[4:10] = device_uid
        struct.pack_into("<IIH", packet, 10, 43, 123457, len(body))
        packet[20:] = body

        parsed = parse_binary_packet(bytes(packet))

        self.assertEqual(parsed["packet_version"], 3)
        self.assertEqual(parsed["sn"], 4)
        self.assertEqual(parsed["flags"], 0x05)
        self.assertEqual(parsed["acc"], [0.1, 0.2, 0.3])
        self.assertEqual(parsed["gyro"], [4.0, 5.0, 6.0])
        self.assertEqual(parsed["mag"], [7.0, 8.0, 9.0])
        self.assertEqual(parsed["imu"]["mag"], [7.0, 8.0, 9.0])

    def test_parse_arduino_packet_v3_with_raw_adc(self):
        flags = 0x01 | 0x08  # IMU + raw ADC
        device_uid = bytes.fromhex("3CDC7545CCD0")
        matrix = struct.pack("<3f", 1.25, 2.5, 3.75)
        raw = struct.pack("<3f", 1100.0, 1200.0, 1300.0)
        imu = struct.pack("<7f", 0.1, 0.2, 0.3, 4.0, 5.0, 6.0, 27.5)
        body = matrix + raw + imu
        packet = bytearray(20 + len(body))
        struct.pack_into("<HBB", packet, 0, 0xA55A, 3, flags)
        packet[4:10] = device_uid
        struct.pack_into("<IIH", packet, 10, 44, 123458, len(body))
        packet[20:] = body

        parsed = parse_binary_packet(bytes(packet))

        self.assertEqual(parsed["sn"], 3)
        self.assertEqual(parsed["p"], [1.25, 2.5, 3.75])
        self.assertEqual(parsed["raw_adc"], [1100.0, 1200.0, 1300.0])
        self.assertEqual(len(parsed["raw_adc"]), len(parsed["p"]))
        self.assertEqual(parsed["acc"], [0.1, 0.2, 0.3])
        self.assertEqual(parsed["gyro"], [4.0, 5.0, 6.0])

    def test_parse_arduino_packet_v3_without_raw_adc_is_none(self):
        flags = 0x01  # IMU only
        device_uid = bytes.fromhex("3CDC7545CCD0")
        matrix = struct.pack("<3f", 1.25, 2.5, 3.75)
        imu = struct.pack("<7f", 0.1, 0.2, 0.3, 4.0, 5.0, 6.0, 27.5)
        body = matrix + imu
        packet = bytearray(20 + len(body))
        struct.pack_into("<HBB", packet, 0, 0xA55A, 3, flags)
        packet[4:10] = device_uid
        struct.pack_into("<IIH", packet, 10, 45, 123459, len(body))
        packet[20:] = body

        parsed = parse_binary_packet(bytes(packet))

        self.assertEqual(parsed["sn"], 3)
        self.assertIsNone(parsed["raw_adc"])


if __name__ == "__main__":
    unittest.main()
