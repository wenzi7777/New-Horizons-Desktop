"""Mock-mode app commands and file uploads.

The mock used to ack `file_write_*` without storing anything, so an uploaded
file never appeared in `file_list` -- which made the upload path untestable and
would have made any future `app_install` in mock mode point at a file that does
not exist.
"""

import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import os  # noqa: E402


class MockAppCommandTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        os.environ["NEWHORIZONS_DATA_ROOT"] = self._tmp.name
        from newhorizons_backend.service import NewHorizonsService

        self.svc = NewHorizonsService(mock_mode=True)

    def run_command(self, device_uid, payload):
        self.svc.publish_command(device_uid, payload)
        return self.svc._latest_result.get(device_uid, {})

    def roster(self, device_uid):
        data = self.run_command(device_uid, {"command": "app_list"})["data"]
        return {app["name"]: app for app in data["apps"]}


class MockAppRosterTests(MockAppCommandTestCase):
    def test_app_list_reports_the_compiled_in_apps(self):
        roster = self.roster("NH-MOCK-001")
        self.assertEqual(sorted(roster), ["features", "rules"])
        self.assertEqual(roster["features"]["state"], "running")

    def test_disable_then_enable_round_trips(self):
        self.assertEqual(
            self.run_command("NH-MOCK-001", {"command": "app_disable", "name": "features"})["message"],
            "app_disabled",
        )
        self.assertEqual(self.roster("NH-MOCK-001")["features"]["state"], "installed")
        self.assertEqual(
            self.run_command("NH-MOCK-001", {"command": "app_enable", "name": "features"})["message"],
            "app_enabled",
        )
        self.assertEqual(self.roster("NH-MOCK-001")["features"]["state"], "running")

    def test_a_killed_app_is_not_silently_re_enabled(self):
        # Mirrors AppManager::setEnabled -- reviving is a deliberate acknowledgement.
        self.assertEqual(self.roster("NH-MOCK-002")["rules"]["state"], "killed")
        result = self.run_command("NH-MOCK-002", {"command": "app_enable", "name": "rules"})
        self.assertEqual(result.get("error"), "app_state_change_rejected")
        self.assertEqual(self.roster("NH-MOCK-002")["rules"]["state"], "killed")

    def test_revive_clears_the_kill_and_zeroes_overruns(self):
        self.assertGreater(self.roster("NH-MOCK-002")["rules"]["overruns"], 0)
        self.assertEqual(
            self.run_command("NH-MOCK-002", {"command": "app_revive", "name": "rules"})["message"],
            "app_revived",
        )
        revived = self.roster("NH-MOCK-002")["rules"]
        self.assertEqual(revived["state"], "running")
        self.assertEqual(revived["overruns"], 0)

    def test_name_is_required(self):
        self.assertEqual(
            self.run_command("NH-MOCK-001", {"command": "app_enable"}).get("error"),
            "name_required",
        )

    def test_rule_graph_load_and_unload(self):
        self.assertEqual(
            self.run_command("NH-MOCK-001", {"command": "app_unload_rules"})["message"],
            "rule_graph_unloaded",
        )
        self.assertEqual(self.roster("NH-MOCK-001")["rules"]["state_detail"]["nodes"], 0)


class MockFileUploadTests(MockAppCommandTestCase):
    def setUp(self):
        super().setUp()
        # file_write_* and file_delete are maintenance-only, matching the firmware.
        self.run_command("NH-MOCK-001", {"command": "enter_maintenance"})

    def upload(self, device_uid, path, data, chunk_size=4):
        began = self.run_command(
            device_uid,
            {"command": "file_write_begin", "scope": "user", "path": path, "size": len(data)},
        )
        self.assertEqual(began["message"], "file_write_started")
        for offset in range(0, len(data), chunk_size):
            chunk = data[offset:offset + chunk_size]
            written = self.run_command(
                device_uid,
                {"command": "file_write_chunk", "scope": "user", "path": path,
                 "offset": offset, "data": chunk.hex()},
            )
            self.assertEqual(written["message"], "file_write_chunk_written")
        return self.run_command(
            device_uid, {"command": "file_write_finish", "scope": "user", "path": path}
        )

    def test_an_uploaded_file_is_visible_afterwards(self):
        payload = b'{"nhapp":1,"kind":"rules"}'
        finished = self.upload("NH-MOCK-001", "apps/demo.nha", payload)
        self.assertEqual(finished["message"], "file_write_finished")
        listed = self.run_command("NH-MOCK-001", {"command": "file_list", "scope": "user"})
        self.assertIn("apps/demo.nha", [item["path"] for item in listed["items"]])

    def test_offsets_must_be_sequential(self):
        self.run_command(
            "NH-MOCK-001",
            {"command": "file_write_begin", "scope": "user", "path": "apps/a.nha", "size": 8},
        )
        result = self.run_command(
            "NH-MOCK-001",
            {"command": "file_write_chunk", "scope": "user", "path": "apps/a.nha",
             "offset": 4, "data": "00"},
        )
        self.assertEqual(result.get("error"), "file_write_offset_mismatch")

    def test_a_short_upload_is_rejected_at_finish(self):
        self.run_command(
            "NH-MOCK-001",
            {"command": "file_write_begin", "scope": "user", "path": "apps/b.nha", "size": 16},
        )
        self.run_command(
            "NH-MOCK-001",
            {"command": "file_write_chunk", "scope": "user", "path": "apps/b.nha",
             "offset": 0, "data": "0011"},
        )
        result = self.run_command(
            "NH-MOCK-001", {"command": "file_write_finish", "scope": "user", "path": "apps/b.nha"}
        )
        self.assertEqual(result.get("error"), "file_write_incomplete")

    def test_paths_cannot_escape_the_scope(self):
        result = self.run_command(
            "NH-MOCK-001",
            {"command": "file_write_begin", "scope": "user", "path": "../../escape", "size": 1},
        )
        self.assertEqual(result.get("error"), "invalid_path")

    def test_user_paths_are_capped_like_spiffs(self):
        # "/files/" + path must fit SPIFFS' 31-char limit, so path <= 24.
        result = self.run_command(
            "NH-MOCK-001",
            {"command": "file_write_begin", "scope": "user",
             "path": "apps/" + "z" * 30 + ".nha", "size": 1},
        )
        self.assertEqual(result.get("error"), "path_too_long")

    def test_delete_removes_the_file(self):
        self.upload("NH-MOCK-001", "apps/gone.nha", b"xyz")
        deleted = self.run_command(
            "NH-MOCK-001", {"command": "file_delete", "scope": "user", "path": "apps/gone.nha"}
        )
        self.assertEqual(deleted["message"], "file_deleted")
        listed = self.run_command("NH-MOCK-001", {"command": "file_list", "scope": "user"})
        self.assertNotIn("apps/gone.nha", [item["path"] for item in listed["items"]])


class MockProcScopeTests(MockAppCommandTestCase):
    def test_proc_lists_the_synthetic_views(self):
        listed = self.run_command("NH-MOCK-001", {"command": "file_list", "scope": "proc"})
        self.assertEqual(sorted(item["path"] for item in listed["items"]),
                         ["apps", "services", "tasks"])

    def test_proc_apps_reflects_the_roster(self):
        text = self.svc._mock_read_file("NH-MOCK-002", "apps", "proc")
        self.assertIn("features", text)
        self.assertIn("killed", text)


if __name__ == "__main__":
    unittest.main()
