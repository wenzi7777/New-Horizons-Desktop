"""Update channels (stable / beta) on the Desktop backend side."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend import gateway_ws  # noqa: E402
from newhorizons_backend.service import NewHorizonsService  # noqa: E402
from newhorizons_backend.terminal import compile_terminal_command, validate_device_command_payload  # noqa: E402


class FakeResponse:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return self.body


class GatewayChannelTest(unittest.TestCase):
    def fetch(self, channel):
        seen = []

        def urlopen(url, timeout=0):
            seen.append(url)
            version = b"v0.7.0-beta.1" if url.endswith("-beta.json") else b"v0.6.0"
            return FakeResponse(b'{"version":"' + version + b'"}')

        with patch.object(gateway_ws, "_LATEST_GATEWAY_VERSION_CACHE", {"value": "", "expires_at": 0.0}), \
             patch.object(gateway_ws, "_LATEST_GATEWAY_VERSION_BY_CHANNEL", {}), \
             patch("newhorizons_backend.gateway_ws.urllib.request.urlopen", side_effect=urlopen):
            return gateway_ws.latest_gateway_version(channel), seen

    def test_stable_and_unknown_channels_read_the_latest_manifest(self):
        for channel in ("stable", None, "", "nightly"):
            version, seen = self.fetch(channel)
            self.assertEqual(version, "v0.6.0", channel)
            self.assertTrue(seen[0].endswith("/releases/gateway-latest.json"), seen)

    def test_beta_gateways_get_the_beta_version(self):
        version, seen = self.fetch("beta")
        self.assertEqual(version, "v0.7.0-beta.1")
        self.assertTrue(seen[0].endswith("/releases/gateway-beta.json"), seen)

    def test_hello_ack_answers_with_the_gateways_own_channel(self):
        source = (BACKEND_ROOT / "newhorizons_backend" / "gateway_ws.py").read_text(encoding="utf-8")
        self.assertIn('latest_gateway_version(message.get("update_channel"))', source)


class TerminalChannelTest(unittest.TestCase):
    def test_set_ota_config_passes_channel_and_omits_unset_manifest(self):
        payload = compile_terminal_command("set-ota-config --auto-apply-on-boot true --channel beta")["payload"]
        self.assertEqual(payload["channel"], "beta")
        self.assertNotIn("manifest_url", payload)  # absent keeps the device's custom URL
        validate_device_command_payload(payload)

    def test_set_ota_config_rejects_unknown_channel(self):
        with self.assertRaises(ValueError):
            compile_terminal_command("set-ota-config --channel nightly")


class HubChannelCommandTest(unittest.TestCase):
    def test_hub_accepts_set_update_channel(self):
        self.assertIn("set_update_channel", NewHorizonsService.HUB_COMMANDS)


if __name__ == "__main__":
    unittest.main()
