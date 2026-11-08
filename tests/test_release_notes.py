import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTES = ROOT / "notes"


class ReleaseNotesTest(unittest.TestCase):
    def test_current_release_has_notes_in_three_languages(self):
        # notes/vX.Y.Z.md is the Traditional Chinese original; from v1.2.3
        # every release also ships .ja.md and .en.md, which the About dialog
        # shows for the Japanese / English UI.
        version = "v" + json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))["version"]
        for name in (f"{version}.md", f"{version}.ja.md", f"{version}.en.md"):
            path = NOTES / name
            self.assertTrue(path.exists(), name)
            self.assertTrue(path.read_text(encoding="utf-8").startswith(f"# {version}\n"), name)

    def test_translations_always_have_an_original(self):
        for path in NOTES.glob("v*.md"):
            match = re.match(r"^(v.+)\.(ja|en)\.md$", path.name)
            if match:
                self.assertTrue((NOTES / f"{match.group(1)}.md").exists(), path.name)


if __name__ == "__main__":
    unittest.main()
