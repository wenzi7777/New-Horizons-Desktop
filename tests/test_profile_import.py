import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.profile_import import import_legacy_profiles, normalize_legacy_profile  # noqa: E402


class ProfileImportTest(unittest.TestCase):
    def test_normalize_legacy_profile_infers_shape_and_defaults(self):
        normalized = normalize_legacy_profile(
            {
                "name": "RightInsole_5*7",
                "background": {"imageData": "data:image/png;base64,abc", "aspectRatio": 0.707},
                "sensors": [{"index": 0, "x": 0.3, "y": 0.2, "label": "P0"}],
                "display": {"mode": "2d", "pressureMin": 300, "pressureMax": 1000},
            },
            profile_stem="RightInsole_5_7",
        )

        self.assertEqual(normalized["name"], "RightInsole_5*7")
        self.assertEqual(normalized["deviceType"], "insole")
        self.assertEqual(normalized["matrix"], {"rows": 5, "cols": 7})
        self.assertEqual(normalized["display"]["dotSize"], 1.0)
        self.assertEqual(normalized["sensors"][0]["label"], "P0")

    def test_import_legacy_profiles_writes_sanitized_filenames(self):
        with tempfile.TemporaryDirectory() as source_tmp, tempfile.TemporaryDirectory() as target_tmp:
            source_dir = Path(source_tmp)
            target_dir = Path(target_tmp)
            source_path = source_dir / "RightInsole_5_7.json"
            source_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "name": "RightInsole_5*7",
                        "background": {"imageData": "", "aspectRatio": 0.707},
                        "sensors": [{"index": 0, "x": 0.3, "y": 0.2, "label": "P0", "enabled": True}],
                        "display": {"mode": "2d", "pressureMin": 300, "pressureMax": 1000},
                    }
                ),
                encoding="utf-8",
            )

            imported = import_legacy_profiles(source_dir, target_dir)

            self.assertEqual(len(imported), 1)
            target_path = target_dir / "RightInsole_5_7.json"
            self.assertTrue(target_path.exists())
            saved = json.loads(target_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["name"], "RightInsole_5*7")
            self.assertEqual(saved["deviceType"], "insole")
            self.assertEqual(saved["display"]["dotSize"], 1.0)


if __name__ == "__main__":
    unittest.main()
