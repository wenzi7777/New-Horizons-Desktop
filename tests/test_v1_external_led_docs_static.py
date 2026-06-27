import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
V1_ROOT = ROOT / "wiki" / "devices" / "vd-ctl-r-v1.0f"


class V1ExternalLedDocsStaticTest(unittest.TestCase):
    def test_led_status_docs_use_v011_external_led_contract(self):
        doc_paths = (
            V1_ROOT / "en" / "led-status.md",
            V1_ROOT / "ja" / "led-status.md",
            V1_ROOT / "zh-CN" / "led-status.md",
        )

        for path in doc_paths:
            source = path.read_text(encoding="utf-8")
            with self.subTest(path=path.name):
                self.assertIn("system_status", source)
                self.assertIn("connectivity", source)
                self.assertIn("pressure_meter", source)
                self.assertIn("stream_heartbeat", source)
                self.assertIn("calibration_auto", source)
                self.assertIn("solid_marker", source)
                self.assertIn("identify", source)
                self.assertIn("`off` / `enabled`", source)
                self.assertNotIn("stream_health", source)
                self.assertNotIn("`off`, `on`, or `auto`", source)

    def test_configuration_docs_use_enabled_mode_and_color_field(self):
        doc_paths = (
            V1_ROOT / "en" / "configuration.md",
            V1_ROOT / "ja" / "configuration.md",
            V1_ROOT / "zh-CN" / "configuration.md",
        )

        for path in doc_paths:
            source = path.read_text(encoding="utf-8")
            with self.subTest(path=path.name):
                self.assertIn('"mode": "enabled"', source)
                self.assertIn('"preset": "system_status"', source)
                self.assertIn('"color": "teal"', source)
                self.assertIn("`color`", source)
                self.assertNotIn("stream_health", source)
                self.assertNotIn('"mode": "auto"', source)


if __name__ == "__main__":
    unittest.main()
