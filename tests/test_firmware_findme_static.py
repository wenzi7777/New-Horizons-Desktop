import unittest
from pathlib import Path


def find_workspace_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "NewHorizonsOS-OTA" / "firmware" / "newhorizons_os").is_dir():
            return parent
    raise RuntimeError("NewHorizonsOS-OTA firmware tree not found")


ROOT = find_workspace_root()
ARDUINO_ROOT = ROOT / "NewHorizonsOS-OTA" / "firmware" / "newhorizons_os"
FINDME_CPP = ARDUINO_ROOT / "FindMeClient.cpp"
FINDME_H = ARDUINO_ROOT / "FindMeClient.h"
CONFIG_H = ARDUINO_ROOT / "Config.h"
CONTROL_CPP = ARDUINO_ROOT / "ControlServer.cpp"
PACKET_BUILDER_CPP = ARDUINO_ROOT / "PacketBuilder.cpp"
PACKET_BUILDER_H = ARDUINO_ROOT / "PacketBuilder.h"
SKETCH = ARDUINO_ROOT / "newhorizons_os.ino"


class FirmwareFindMeStaticTest(unittest.TestCase):
    def test_findme_does_not_periodically_rediscover_after_same_gateway_accept(self):
        source = FINDME_CPP.read_text()

        self.assertNotIn("kAttachedRefreshIntervalMs", source)
        self.assertIn("isSameGateway", source)
        self.assertNotIn("findme_offer_refreshed", source)
        self.assertIn("nextDiscoverMs_ = 0;", source)
        self.assertNotIn("nextDiscoverMs_ = millis() + (offer.ttlMs ? offer.ttlMs : kDefaultOfferTtlMs);", source)

    def test_findme_rediscovers_after_wifi_reconnect(self):
        source = FINDME_CPP.read_text()
        header = FINDME_H.read_text()

        self.assertIn("wasWifiConnected_", header)
        self.assertIn("const bool connected = wifi_->isConnected();", source)
        self.assertIn("if (connected && !wasWifiConnected_)", source)
        self.assertIn("discoverNow();", source)

    def test_findme_requires_fresh_offer_after_reboot_before_streaming(self):
        source = FINDME_CPP.read_text()
        header = FINDME_H.read_text()

        self.assertIn("bool attachedThisBoot_ = false;", header)
        self.assertIn("return attachedThisBoot_ && !streamHost_.isEmpty() && streamPort_ > 0;", source)
        self.assertIn("attachedThisBoot_ = false;", source)
        self.assertIn("attachedThisBoot_ = true;", source)
        self.assertNotIn('state_ = streamHost_.isEmpty() ? "idle" : "attached";', source)

    def test_heartbeat_packet_contract_is_v3_empty_payload(self):
        config = CONFIG_H.read_text()
        builder_header = PACKET_BUILDER_H.read_text()
        builder_source = PACKET_BUILDER_CPP.read_text()
        sketch = SKETCH.read_text()

        self.assertIn("kPacketFlagHeartbeat = 0x80", config)
        self.assertIn("kHeartbeatIntervalMs = 5000", config)
        self.assertIn("buildHeartbeat", builder_header)
        self.assertIn("out[3] = kPacketFlagHeartbeat;", builder_source)
        self.assertIn("putU16(out + 18, 0);", builder_source)
        self.assertIn("sendHeartbeatIfDue", sketch)
        self.assertIn("if (!wifi.isConnected() || !findme.hasGateway())", sketch)
        self.assertIn("sendHeartbeatIfDue();", sketch)

    def test_control_server_logs_incoming_commands_for_serial_diagnostics(self):
        source = CONTROL_CPP.read_text()

        self.assertIn("control_command_received", source)
        self.assertIn("control_command_executing", source)
        self.assertIn("control_command_finished", source)
        self.assertIn("duration_ms=", source)
        self.assertIn("request_id=", source)

    def test_control_status_payload_exposes_arduino_identity_and_runtime(self):
        source = CONTROL_CPP.read_text()

        for token in (
            '\\"device_name\\"',
            '\\"firmware_version\\"',
            '\\"hardware_model\\"',
            '\\"matrix_shape\\"',
            '\\"matrix_layout\\"',
            '\\"runtime\\"',
            '\\"scan_timing\\"',
            '\\"scan_health\\"',
            '\\"findme\\"',
        ):
            self.assertIn(token, source)

    def test_control_layout_and_scan_responses_return_status_fields(self):
        source = CONTROL_CPP.read_text()

        self.assertIn("matrixLayoutJson", source)
        self.assertIn("layoutStatusJson", source)
        self.assertIn("scanTimingStatusJson", source)
        self.assertIn('\\"matrix_shape\\"', source)
        self.assertIn('\\"matrix_layout\\"', source)

    def test_scan_overrun_yields_to_control_loop(self):
        scanner = (ARDUINO_ROOT / "MatrixScanner.cpp").read_text(encoding="utf-8")
        header = (ARDUINO_ROOT / "MatrixScanner.h").read_text(encoding="utf-8")

        self.assertIn("scanDue", header)
        self.assertIn("scanIntoPacketPayload", header)
        self.assertNotIn("xTaskCreatePinnedToCore", scanner)
        self.assertNotIn("nhos_scan", scanner)
        self.assertNotIn("taskYIELD();", scanner)

    def test_matrix_scanner_uses_gcu_open_drain_active_low_selects(self):
        scanner = (ARDUINO_ROOT / "MatrixScanner.cpp").read_text(encoding="utf-8")

        self.assertIn("OUTPUT_OPEN_DRAIN", scanner)
        self.assertIn("digitalWrite(cols_[i], HIGH)", scanner)
        self.assertIn("digitalWrite(cols_[c], LOW)", scanner)
        self.assertIn("digitalWrite(cols_[c], HIGH)", scanner)
        self.assertNotIn("pinMode(cols_[i], OUTPUT);", scanner)

    def test_scan_health_exposes_timing_and_udp_perf_fields(self):
        scanner = (ARDUINO_ROOT / "MatrixScanner.cpp").read_text(encoding="utf-8")
        header = (ARDUINO_ROOT / "MatrixScanner.h").read_text(encoding="utf-8")

        for token in (
            "actualScanFps",
            "lastScanDurationUs",
            "maxScanDurationUs",
            "budgetUs",
            "overrunFrames",
            "udpSentFrames",
            "udpSendFailures",
            "lastUdpSendUs",
            "recordUdpSend",
        ):
            self.assertIn(token, header)
        for json_key in (
            '\\"actual_scan_fps\\"',
            '\\"last_scan_duration_us\\"',
            '\\"max_scan_duration_us\\"',
            '\\"budget_us\\"',
            '\\"overrun_frames\\"',
            '\\"udp_sent_frames\\"',
            '\\"udp_send_failures\\"',
            '\\"last_udp_send_us\\"',
        ):
            self.assertIn(json_key, scanner)

    def test_findme_discovery_uses_json(self):
        source = FINDME_CPP.read_text()
        header = FINDME_H.read_text()

        self.assertIn("encodeDiscoverJson", source)
        self.assertIn("findme_discover", source)
        self.assertIn("extractJsonString", source)
        self.assertIn("extractJsonBool", source)
        self.assertIn("String encodeDiscoverJson() const;", header)

    def test_findme_discovery_uses_limited_directed_and_known_gateway_targets(self):
        source = FINDME_CPP.read_text()
        header = FINDME_H.read_text()

        self.assertIn("bool sendDiscoverTo(const IPAddress& host, const String& payload);", header)
        self.assertIn("IPAddress directedBroadcast() const;", header)
        self.assertIn("WiFi.localIP()", source)
        self.assertIn("WiFi.subnetMask()", source)
        self.assertIn("IPAddress(255, 255, 255, 255)", source)
        self.assertIn("sendDiscoverTo(directedBroadcast(), payload)", source)
        self.assertIn("knownGateway.fromString(streamHost_)", source)
        self.assertIn("sendDiscoverTo(knownGateway, payload)", source)


if __name__ == "__main__":
    unittest.main()
