import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.standalone import create_standalone_app  # noqa: E402


WIKI_PAGE = ROOT / "frontend" / "src" / "pages" / "DeviceWikiPage.tsx"
DOCKERFILE = ROOT / "Dockerfile"


class WikiApiAndPageTest(unittest.TestCase):
    def create_client(self):
        tmpdir = tempfile.TemporaryDirectory()
        data_root = Path(tmpdir.name) / "mqtt_store"
        wiki_root = Path(tmpdir.name) / "wiki"
        legacy_dir = wiki_root / "devices" / "vd-ctl-r-v1.0f"
        legacy_dir.mkdir(parents=True, exist_ok=True)
        (legacy_dir / "README.md").write_text("# VD-CTL/R\n\n- Overview\n", encoding="utf-8")
        (legacy_dir / "indicators.md").write_text("| LED | State |\n| --- | --- |\n| white pulse | wake |\n", encoding="utf-8")
        gcu_dir = wiki_root / "devices" / "vd-ctl-r-v2-3-d-gcu-lts"
        gcu_dir.mkdir(parents=True, exist_ok=True)
        (gcu_dir / "README.md").write_text("# VD-CTL/R GCU LTS\n\n- 15x15\n", encoding="utf-8")
        v21_dir = wiki_root / "devices" / "vd-ctl-r-v2-1-gcu-lts"
        v21_dir.mkdir(parents=True, exist_ok=True)
        (v21_dir / "README.md").write_text("# VD-CTL/R v2.1 GCU LTS\n\n- 10x12\n", encoding="utf-8")

        env = {
            "NEWHORIZONS_AUTOSTART": "0",
            "NEWHORIZONS_AUTH_DB": str(Path(tmpdir.name) / "auth.sqlite3"),
            "NEWHORIZONS_DATA_ROOT": str(data_root),
            "NEWHORIZONS_WIKI_ROOT": str(wiki_root),
        }
        patcher = patch.dict("os.environ", env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(tmpdir.cleanup)
        app = create_standalone_app()
        client = app.test_client()
        login = client.post("/newhorizons/api/auth/login", json={"username": "admin", "password": "admin"})
        self.assertEqual(login.status_code, 200)
        return client

    def test_wiki_api_lists_device_directories_and_markdown_documents(self):
        client = self.create_client()

        devices = client.get("/newhorizons/api/wiki/devices")
        docs = client.get("/newhorizons/api/wiki?device=vd-ctl-r-v1.0f")
        document = client.get("/newhorizons/api/wiki/document?device=vd-ctl-r-v1.0f&path=README.md")

        self.assertEqual(devices.status_code, 200)
        self.assertEqual(
            [item["slug"] for item in devices.get_json()["items"]],
            ["vd-ctl-r-v1.0f", "vd-ctl-r-v2-1-gcu-lts", "vd-ctl-r-v2-3-d-gcu-lts"],
        )
        self.assertEqual(docs.status_code, 200)
        self.assertEqual([item["path"] for item in docs.get_json()["items"]], ["README.md", "indicators.md"])
        self.assertEqual(document.status_code, 200)
        self.assertIn("# VD-CTL/R", document.get_json()["content"])

    def test_wiki_page_uses_browser_style_workspace_and_markdown_preview(self):
        source = WIKI_PAGE.read_text(encoding="utf-8")
        styles = (ROOT / "frontend" / "src" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("api.wikiDevices()", source)
        self.assertIn("api.wikiDirectory(", source)
        self.assertIn("api.wikiDocument(", source)
        self.assertIn("renderMarkdown", source)
        self.assertIn("wikiSlugFromHardwareModel", source)
        self.assertIn("vd-ctl-r-v2-1-gcu-lts", (ROOT / "frontend" / "src" / "lib" / "boardProfile.ts").read_text(encoding="utf-8"))
        self.assertIn("vd-ctl-r-v2-3-d-gcu-lts", (ROOT / "frontend" / "src" / "lib" / "boardProfile.ts").read_text(encoding="utf-8"))
        self.assertIn("wiki-workspace", source)
        self.assertIn("wiki-preview-panel", source)
        self.assertIn("wiki-preview-content", styles)
        self.assertIn("documentLoading", source)
        self.assertIn('t("wikiEmptyDocuments")', source)
        self.assertEqual(source.count('t("wikiCopy")'), 1)
        self.assertNotIn('<Link className="button" to="/">', source)

    def test_docker_image_includes_repository_wiki_tree(self):
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")

        self.assertIn("COPY wiki ./wiki", dockerfile)
        self.assertIn("ENV NEWHORIZONS_FRONTEND_DIST=/app/frontend/dist", dockerfile)


if __name__ == "__main__":
    unittest.main()
