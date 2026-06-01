import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "frontend" / "src" / "lib" / "profileLayout.ts"


class ProfileLayoutStaticTest(unittest.TestCase):
    def test_profile_layout_helper_exports_shared_fit_and_coordinate_mapping(self):
        source = HELPER.read_text(encoding="utf-8")

        self.assertIn("export type FittedProfileRect", source)
        self.assertIn("export function fitProfileRect", source)
        self.assertIn("export function profilePointToScreen", source)
        self.assertIn("export function profilePointToWorld", source)
        self.assertIn("const drawWidth =", source)
        self.assertIn("const offsetX =", source)
        self.assertIn("const worldX =", source)
        self.assertIn("const worldZ =", source)


if __name__ == "__main__":
    unittest.main()
