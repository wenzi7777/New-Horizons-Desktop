"""REST surface for the App Library: auth, shapes and the hex the frontend sends."""

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.app_library import canonical_bytes  # noqa: E402
from newhorizons_backend.standalone import create_standalone_app  # noqa: E402


PACKAGE = {
    "nhapp": 1,
    "kind": "flow",
    "name": "demo",
    "manifest": {
        "id": "demo", "name": "Demo", "version": "1.0.0", "author": "wenzi7777",
        "summary": "fixture", "min_os": "v1.0.0",
        "capabilities": ["read_matrix", "emit_event"],
    },
    "nodes": [
        {"op": "total"},
        {"op": "threshold", "in": 0, "value": 10.0},
        {"op": "emit", "in": 1, "event": "hit"},
    ],
}
RAW = canonical_bytes(PACKAGE)
INDEX = {
    "schema": 1,
    "generated_at": "2026-09-22T00:00:00Z",
    "apps": [{
        "id": "demo",
        "name": {"en": "Demo"},
        "summary": {"en": "fixture"},
        "version": "1.0.0",
        "author": "wenzi7777",
        "min_os": "v1.0.0",
        "device_path": "apps/demo.nha",
        "package": {
            "url": "https://raw.githubusercontent.com/x/y/main/demo.nha",
            "sha256": hashlib.sha256(RAW).hexdigest(),
            "size": len(RAW),
        },
    }],
}


class FakeResponse:
    def __init__(self, body: bytes):
        self._body = body
        self.headers = {}

    def read(self, *_args):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class AppLibraryApiTest(unittest.TestCase):
    def create_client(self, login_as: str | None = "admin"):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        data_root = Path(tmpdir.name) / "store"
        data_root.mkdir(parents=True, exist_ok=True)
        env = {
            "NEWHORIZONS_AUTOSTART": "0",
            "NEWHORIZONS_AUTH_DB": str(Path(tmpdir.name) / "auth.sqlite3"),
            "NEWHORIZONS_DATA_ROOT": str(data_root),
            "NEWHORIZONS_APP_LIBRARY_DIR": str(Path(tmpdir.name) / "library"),
        }
        patcher = patch.dict("os.environ", env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        # get_library() memoises, so give each test its own instance.
        import newhorizons_backend.app_library as module
        module._library = None
        app = create_standalone_app()
        client = app.test_client()
        if login_as:
            login = client.post("/newhorizons/api/auth/login",
                                json={"username": login_as, "password": login_as})
            self.assertEqual(login.status_code, 200)
        return client

    def test_the_catalog_requires_authentication(self):
        client = self.create_client(login_as=None)
        self.assertEqual(client.get("/newhorizons/api/app-library/index").status_code, 401)

    def test_the_catalog_is_served_to_an_admin(self):
        client = self.create_client()
        with patch("urllib.request.urlopen", return_value=FakeResponse(json.dumps(INDEX).encode())):
            response = client.get("/newhorizons/api/app-library/index")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual([item["id"] for item in body["items"]], ["demo"])
        self.assertFalse(body["stale"])

    def test_an_unknown_app_is_a_404(self):
        client = self.create_client()
        with patch("urllib.request.urlopen", return_value=FakeResponse(json.dumps(INDEX).encode())):
            response = client.get("/newhorizons/api/app-library/apps/nothing")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"], "app_not_found")

    def test_a_package_comes_back_as_hex_of_exactly_the_stated_size(self):
        client = self.create_client()
        with patch("urllib.request.urlopen",
                   side_effect=[FakeResponse(json.dumps(INDEX).encode()), FakeResponse(RAW)]):
            response = client.post("/newhorizons/api/app-library/apps/demo/package", json={})
        self.assertEqual(response.status_code, 200)
        package = response.get_json()["package"]
        self.assertEqual(len(package["data_hex"]) % 2, 0)
        self.assertEqual(len(bytes.fromhex(package["data_hex"])), package["size"])
        self.assertEqual(package["device_path"], "apps/demo.nha")

    def test_importing_a_malformed_package_is_a_400(self):
        client = self.create_client()
        response = client.post("/newhorizons/api/app-library/import", data=b"{not json")
        self.assertEqual(response.status_code, 400)

    def test_importing_a_valid_package_returns_its_digest(self):
        client = self.create_client()
        response = client.post("/newhorizons/api/app-library/import", data=RAW)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["package"]["sha256"],
                         hashlib.sha256(RAW).hexdigest())


if __name__ == "__main__":
    unittest.main()
