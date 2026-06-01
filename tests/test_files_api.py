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


class FilesApiTest(unittest.TestCase):
    def create_client(self):
        tmpdir = tempfile.TemporaryDirectory()
        data_root = Path(tmpdir.name) / "mqtt_store"
        data_root.mkdir(parents=True, exist_ok=True)
        device_root = data_root / "3CDC7545CCD0"
        (device_root / "20260529").mkdir(parents=True, exist_ok=True)
        (device_root / "20260528").mkdir(parents=True, exist_ok=True)
        (device_root / "ignore.txt").write_text("ignore", encoding="utf-8")
        (device_root / "root.csv").write_text("time,p0\n1,10\n2,20\n", encoding="utf-8")
        (device_root / "20260529" / "session_a.csv").write_text("time,p0,p1\n1,10,11\n2,12,13\n", encoding="utf-8")
        (device_root / "20260529" / "notes.txt").write_text("ignore", encoding="utf-8")
        (device_root / "20260528" / "session_b.csv").write_text("time,p0\n3,30\n", encoding="utf-8")

        env = {
            "NEWHORIZONS_AUTOSTART": "0",
            "NEWHORIZONS_AUTH_DB": str(Path(tmpdir.name) / "auth.sqlite3"),
            "NEWHORIZONS_DATA_ROOT": str(data_root),
        }
        patcher = patch.dict("os.environ", env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(tmpdir.cleanup)
        app = create_standalone_app()
        client = app.test_client()
        login = client.post("/newhorizons/api/auth/login", json={"username": "admin", "password": "admin"})
        self.assertEqual(login.status_code, 200)
        return client, data_root

    def test_files_list_returns_directories_and_csv_for_current_directory_only(self):
        client, _ = self.create_client()

        root_response = client.get("/newhorizons/api/files?device_uid=3CDC7545CCD0")
        child_response = client.get("/newhorizons/api/files?device_uid=3CDC7545CCD0&path=20260529")

        self.assertEqual(root_response.status_code, 200)
        root_payload = root_response.get_json()
        self.assertEqual(root_payload["device_uid"], "3CDC7545CCD0")
        self.assertEqual(root_payload["path"], "")
        self.assertEqual(root_payload["parent_path"], "")
        self.assertEqual(
            [item["path"] for item in root_payload["items"]],
            ["3CDC7545CCD0/20260528", "3CDC7545CCD0/20260529", "3CDC7545CCD0/root.csv"],
        )
        self.assertEqual([item["kind"] for item in root_payload["items"]], ["directory", "directory", "csv"])

        self.assertEqual(child_response.status_code, 200)
        child_payload = child_response.get_json()
        self.assertEqual(child_payload["path"], "20260529")
        self.assertEqual(child_payload["parent_path"], "")
        self.assertEqual([item["path"] for item in child_payload["items"]], ["3CDC7545CCD0/20260529/session_a.csv"])

    def test_files_preview_returns_table_stats_and_rejects_directories(self):
        client, _ = self.create_client()

        preview = client.get("/newhorizons/api/files/preview?device_uid=3CDC7545CCD0&path=20260529/session_a.csv")
        directory_preview = client.get("/newhorizons/api/files/preview?device_uid=3CDC7545CCD0&path=20260529")

        self.assertEqual(preview.status_code, 200)
        payload = preview.get_json()
        self.assertEqual(payload["name"], "session_a.csv")
        self.assertEqual(payload["path"], "3CDC7545CCD0/20260529/session_a.csv")
        self.assertEqual(payload["columns"], 3)
        self.assertEqual(payload["row_count_previewed"], 2)
        self.assertTrue(payload["has_header"])
        self.assertEqual(payload["header"], ["time", "p0", "p1"])
        self.assertEqual(payload["rows"], [["1", "10", "11"], ["2", "12", "13"]])

        self.assertEqual(directory_preview.status_code, 400)
        self.assertEqual(directory_preview.get_json()["error"], "preview_requires_file")

    def test_files_delete_supports_file_and_recursive_directory_removal(self):
        client, data_root = self.create_client()

        file_delete = client.delete("/newhorizons/api/files?device_uid=3CDC7545CCD0&path=root.csv")
        self.assertEqual(file_delete.status_code, 200)
        self.assertEqual(file_delete.get_json()["deleted_kind"], "file")
        self.assertFalse((data_root / "3CDC7545CCD0" / "root.csv").exists())

        dir_delete = client.delete("/newhorizons/api/files?device_uid=3CDC7545CCD0&path=20260529")
        self.assertEqual(dir_delete.status_code, 200)
        self.assertEqual(dir_delete.get_json()["deleted_kind"], "directory")
        self.assertFalse((data_root / "3CDC7545CCD0" / "20260529").exists())

    def test_files_api_rejects_traversal_and_directory_download(self):
        client, _ = self.create_client()

        traversal = client.get("/newhorizons/api/files?device_uid=3CDC7545CCD0&path=../outside")
        download_dir = client.get("/newhorizons/api/files/download?path=3CDC7545CCD0/20260529")

        self.assertEqual(traversal.status_code, 403)
        self.assertEqual(traversal.get_json()["error"], "forbidden")
        self.assertEqual(download_dir.status_code, 400)
        self.assertEqual(download_dir.get_json()["error"], "download_requires_file")


if __name__ == "__main__":
    unittest.main()
