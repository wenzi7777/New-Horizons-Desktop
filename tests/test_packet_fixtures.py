"""The backend's packet parser against packets the firmware encoder built.

NewHorizonsOS-OTA/spec/fixtures/packets.json is generated from
PacketV5Codec.cpp (and checked against it by that repo's tests_native), so a
wire-format drift between firmware and backend fails here instead of on a
device.
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.arduino_protocol import (  # noqa: E402
    is_arduino_heartbeat_packet,
    is_arduino_stream_packet,
    packet_device_uid,
)
from newhorizons_backend.packet_parser import parse_binary_packet  # noqa: E402

FIXTURE = ROOT.parent / "NewHorizonsOS-OTA" / "spec" / "fixtures" / "packets.json"


@unittest.skipUnless(FIXTURE.exists(), "NewHorizonsOS-OTA not checked out alongside")
class FirmwarePacketFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_fixture_has_cases(self):
        self.assertGreaterEqual(len(self.fixture["packets"]), 5)

    def test_every_packet_parses_to_what_it_was_built_from(self):
        for case in self.fixture["packets"]:
            with self.subTest(case["name"]):
                packet = bytes.fromhex(case["hex"])
                expect = case["expect"]
                self.assertTrue(is_arduino_stream_packet(packet))
                self.assertFalse(is_arduino_heartbeat_packet(packet))
                self.assertEqual(packet_device_uid(packet), expect["device_uid"])

                parsed = parse_binary_packet(packet)  # sensor count inferred
                self.assertEqual(parsed["packet_version"], self.fixture["packet_version"])
                self.assertEqual(parsed["flags"], expect["flags"])
                self.assertEqual(parsed["packet_device_uid"], expect["device_uid"])
                self.assertEqual(parsed["frame_id"], expect["sequence"])
                self.assertEqual(parsed["sn"], expect["point_count"])
                self.assertEqual(parsed["p"], expect["matrix"])
                self.assertEqual(parsed["raw_adc"], expect["raw"])
                if expect["epoch_valid"]:
                    self.assertEqual(parsed["device_epoch_ms"], expect["epoch_ms"])
                else:
                    self.assertNotIn("device_epoch_ms", parsed)
                if expect["imu"] is None:
                    self.assertIsNone(parsed["acc"])
                else:
                    self.assertEqual(parsed["acc"], expect["imu"][0:3])
                    self.assertEqual(parsed["gyro"], expect["imu"][3:6])
                    self.assertEqual(parsed["imu"]["temperature_c"], expect["imu"][6])
                self.assertEqual(parsed["mag"], expect["mag"])
                if expect["battery"] is None:
                    self.assertIsNone(parsed["battery"])
                else:
                    battery = dict(parsed["battery"])
                    battery.pop("soc_percent", None)
                    self.assertEqual(battery, expect["battery"])
                # App events ride as extension TLVs (firmware v1.16.0+); the
                # sensor count is inferred around them, as without a known
                # matrix shape. Each decodes to the app_events command's shape.
                expected_events = [
                    {key: value for key, value in event.items() if not (key == "value" and value is None)}
                    for event in expect.get("app_events", [])
                ]
                self.assertEqual(parsed["app_events"], expected_events)
                self.assertEqual(len(parsed["extensions"]), len(expected_events))

    def test_a_packet_with_events_parses_with_a_known_sensor_count_too(self):
        case = next(case for case in self.fixture["packets"] if case["expect"].get("app_events"))
        parsed = parse_binary_packet(bytes.fromhex(case["hex"]), sensor_count=case["expect"]["point_count"])
        self.assertEqual([event["seq"] for event in parsed["app_events"]], [3, 4])


if __name__ == "__main__":
    unittest.main()
