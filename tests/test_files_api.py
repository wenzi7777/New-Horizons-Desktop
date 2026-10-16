import io
import json
import sys
import tempfile
import zipfile
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

    def test_devices_with_recordings_are_listed_from_disk(self):
        # Right after a restart no device is connected; the recordings must
        # still be reachable (the CSV page listed only connected devices).
        client, data_root = self.create_client()
        (data_root / "_app_library").mkdir()
        (data_root / "_newhorizons_device_groups.json").write_text("{}", encoding="utf-8")
        (data_root / "80456B76AAF4").mkdir()
        response = client.get("/newhorizons/api/files/devices")
        self.assertEqual(response.status_code, 200)
        items = response.get_json()["items"]
        self.assertEqual(sorted(item["device_uid"] for item in items), ["3CDC7545CCD0", "80456B76AAF4"])
        self.assertTrue(all(item["connected"] is False for item in items))
        self.assertTrue(all(item["modified_ms"] > 0 for item in items))

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
        self.assertTrue(all(isinstance(item["modified_ms"], int) and item["modified_ms"] > 0 for item in root_payload["items"]))

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

    def test_files_api_rejects_traversal(self):
        client, _ = self.create_client()

        traversal = client.get("/newhorizons/api/files?device_uid=3CDC7545CCD0&path=../outside")

        self.assertEqual(traversal.status_code, 403)
        self.assertEqual(traversal.get_json()["error"], "forbidden")

    def test_a_folder_downloads_as_a_zip_that_unpacks_into_the_folder(self):
        client, _ = self.create_client()

        download_dir = client.get("/newhorizons/api/files/download?path=3CDC7545CCD0/20260529")

        self.assertEqual(download_dir.status_code, 200)
        self.assertEqual(download_dir.mimetype, "application/zip")
        self.assertIn("20260529.zip", download_dir.headers["Content-Disposition"])
        with zipfile.ZipFile(io.BytesIO(download_dir.data)) as bundle:
            self.assertEqual(sorted(bundle.namelist()), ["20260529/notes.txt", "20260529/session_a.csv"])
            self.assertEqual(bundle.read("20260529/session_a.csv").decode(), "time,p0,p1\n1,10,11\n2,12,13\n")
        download_dir.close()

    def make_recording(self, data_root):
        folder = data_root / "3CDC7545CCD0" / "20261016" / "062756"
        folder.mkdir(parents=True)
        (folder / "062756.data.csv").write_text("timestamp_ms,P1\n1792132076770,10\n", encoding="utf-8")
        (folder / "062756.events.csv").write_text("seq,frame_seq\n1,2\n", encoding="utf-8")
        meta = {"format": 1, "device": {"hardware_model": "TIA-CTL v1.5.F 2026.7"}, "recording": {"stopped_at": None}}
        (folder / "062756.meta.json").write_text(json.dumps(meta), encoding="utf-8")
        (folder / "062756.meta.json.tmp").write_text("{", encoding="utf-8")
        return folder

    def test_a_recording_folder_is_one_item_with_its_meta(self):
        client, data_root = self.create_client()
        folder = self.make_recording(data_root)

        day = client.get("/newhorizons/api/files?device_uid=3CDC7545CCD0&path=20261016").get_json()["items"]
        self.assertEqual([(item["name"], item["kind"]) for item in day], [("062756", "recording")])
        # Its files come with it, samples first, so the day folder can show them.
        self.assertEqual(
            [child["name"] for child in day[0]["children"]],
            ["062756.data.csv", "062756.events.csv", "062756.meta.json"],
        )
        self.assertEqual(day[0]["children"][0]["path"], "3CDC7545CCD0/20261016/062756/062756.data.csv")
        # A meta write in progress (.tmp) is neither listed nor counted.
        self.assertEqual(day[0]["size"], sum(path.stat().st_size for path in folder.iterdir() if not path.name.endswith(".tmp")))

        inside = client.get("/newhorizons/api/files?device_uid=3CDC7545CCD0&path=20261016/062756").get_json()["items"]
        self.assertEqual(
            [(item["name"], item["kind"]) for item in inside],
            [("062756.data.csv", "csv"), ("062756.events.csv", "csv"), ("062756.meta.json", "meta")],
        )

        folder_preview = client.get("/newhorizons/api/files/preview?device_uid=3CDC7545CCD0&path=20261016/062756").get_json()
        self.assertEqual(folder_preview["kind"], "recording")
        self.assertEqual(folder_preview["meta"]["device"]["hardware_model"], "TIA-CTL v1.5.F 2026.7")
        self.assertEqual(len(folder_preview["files"]), 3)

        data_preview = client.get("/newhorizons/api/files/preview?device_uid=3CDC7545CCD0&path=20261016/062756/062756.data.csv").get_json()
        self.assertEqual(data_preview["kind"], "csv")
        self.assertEqual(data_preview["meta"]["format"], 1)
        self.assertEqual(data_preview["header"], ["timestamp_ms", "P1"])

        meta_preview = client.get("/newhorizons/api/files/preview?device_uid=3CDC7545CCD0&path=20261016/062756/062756.meta.json").get_json()
        self.assertEqual(meta_preview["kind"], "meta")
        self.assertEqual(meta_preview["meta"]["format"], 1)

        legacy_preview = client.get("/newhorizons/api/files/preview?device_uid=3CDC7545CCD0&path=20260529/session_a.csv").get_json()
        self.assertIsNone(legacy_preview["meta"])

        timeline = client.get("/newhorizons/api/files/timeline?device_uid=3CDC7545CCD0&path=20261016/062756").get_json()
        self.assertEqual(timeline["name"], "062756.data.csv")
        self.assertEqual(timeline["path"], "3CDC7545CCD0/20261016/062756/062756.data.csv")
        self.assertEqual(timeline["rows"], 1)
        legacy = client.get("/newhorizons/api/files/timeline?device_uid=3CDC7545CCD0&path=20260529/session_a.csv")
        self.assertEqual(legacy.status_code, 200)
        self.assertEqual(legacy.get_json()["rows"], 2)
        events = client.get("/newhorizons/api/files/timeline?device_uid=3CDC7545CCD0&path=20261016/062756/062756.events.csv")
        self.assertEqual(events.status_code, 400)
        self.assertEqual(events.get_json()["error"], "not_a_recording")

        deleted = client.delete("/newhorizons/api/files?device_uid=3CDC7545CCD0&path=20261016/062756/062756.meta.json")
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse((folder / "062756.meta.json").exists())


if __name__ == "__main__":
    unittest.main()
