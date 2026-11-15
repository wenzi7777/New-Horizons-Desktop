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
    def test_app_list_reports_the_running_apps_by_id(self):
        # Firmware v2.1.0: no slots; only apps that are on are listed, by id.
        roster = self.roster("NH-MOCK-001")
        self.assertEqual(sorted(roster), ["heel_strike"])
        self.assertEqual(roster["heel_strike"]["state"], "running")
        self.assertEqual(roster["heel_strike"]["order"], 0)

    def test_app_list_reports_load_and_the_pool(self):
        data = self.run_command("NH-MOCK-001", {"command": "app_list"})["data"]
        app = data["apps"][0]
        for key in ("load", "level", "cpu1", "cpu10", "cpu60", "base_us", "borrowed_us", "lent_us",
                    "memory_bytes"):
            self.assertIn(key, app)
        self.assertEqual(data["pool"]["bytes"], 8192)
        self.assertEqual(data["pool"]["used"] + data["pool"]["free"], 8192)
        self.assertGreater(data["governor"]["ceiling_permille"], 0)

    def test_stop_then_start_round_trips(self):
        self.assertEqual(
            self.run_command("NH-MOCK-001", {"command": "app_stop", "name": "heel_strike"})["message"],
            "app_stopped",
        )
        self.assertEqual(self.roster("NH-MOCK-001")["heel_strike"]["state"], "stopped")
        self.assertEqual(
            self.run_command("NH-MOCK-001", {"command": "app_start", "name": "heel_strike"})["message"],
            "app_started",
        )
        self.assertEqual(self.roster("NH-MOCK-001")["heel_strike"]["state"], "running")

    def test_a_killed_app_is_not_silently_restarted(self):
        # Reviving is a deliberate acknowledgement.
        self.assertEqual(self.roster("NH-MOCK-002")["heel_strike"]["state"], "killed")
        result = self.run_command("NH-MOCK-002", {"command": "app_start", "name": "heel_strike"})
        self.assertEqual(result.get("error"), "app_state_change_rejected")
        self.assertEqual(self.roster("NH-MOCK-002")["heel_strike"]["state"], "killed")

    def test_revive_clears_the_kill_and_zeroes_overruns(self):
        self.assertGreater(self.roster("NH-MOCK-002")["heel_strike"]["overruns"], 0)
        self.assertEqual(
            self.run_command("NH-MOCK-002", {"command": "app_revive", "name": "heel_strike"})["message"],
            "app_revived",
        )
        revived = self.roster("NH-MOCK-002")["heel_strike"]
        self.assertEqual(revived["state"], "running")
        self.assertEqual(revived["overruns"], 0)

    def test_name_is_required(self):
        self.assertEqual(
            self.run_command("NH-MOCK-001", {"command": "app_stop"}).get("error"),
            "name_required",
        )


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

    def test_a_wrong_checksum_rejects_the_upload(self):
        # file_write_chunk only checks that offsets are sequential, so a chunk
        # of the right length but wrong content otherwise passes silently.
        payload = b"corrupted"
        self.run_command("NH-MOCK-001",
                         {"command": "file_write_begin", "scope": "user",
                          "path": "apps/c.nha", "size": len(payload)})
        self.run_command("NH-MOCK-001",
                         {"command": "file_write_chunk", "scope": "user", "path": "apps/c.nha",
                          "offset": 0, "data": payload.hex()})
        result = self.run_command("NH-MOCK-001",
                                  {"command": "file_write_finish", "scope": "user",
                                   "path": "apps/c.nha", "sha256": "0" * 64})
        self.assertEqual(result.get("error"), "file_checksum_mismatch")

    def test_a_matching_checksum_is_accepted_and_reported(self):
        import hashlib
        payload = b'{"nhapp":1}'
        digest = hashlib.sha256(payload).hexdigest()
        self.run_command("NH-MOCK-001",
                         {"command": "file_write_begin", "scope": "user",
                          "path": "apps/d.nha", "size": len(payload)})
        self.run_command("NH-MOCK-001",
                         {"command": "file_write_chunk", "scope": "user", "path": "apps/d.nha",
                          "offset": 0, "data": payload.hex()})
        result = self.run_command("NH-MOCK-001",
                                  {"command": "file_write_finish", "scope": "user",
                                   "path": "apps/d.nha", "sha256": digest})
        self.assertEqual(result["message"], "file_write_finished")
        self.assertEqual(result["sha256"], digest)

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


class MockAppRegistryTests(MockAppCommandTestCase):
    """The package registry: an app is on or off; the pool is the only limit."""

    PACKAGE = {
        "nhapp": 1, "kind": "flow", "name": "demo",
        "manifest": {"id": "demo", "name": "Demo", "version": "1.0.0",
                     "author": "wenzi7777", "summary": "fixture", "min_os": "v1.0.0",
                     "capabilities": ["read_matrix", "emit_event"]},
        "nodes": [{"op": "total"}, {"op": "threshold", "in": 0, "value": 10.0},
                  {"op": "emit", "in": 1, "event": "hit"}],
    }

    def setUp(self):
        super().setUp()
        self.run_command("NH-MOCK-001", {"command": "enter_maintenance"})

    def upload(self, path, doc=None):
        import json
        raw = json.dumps(doc or self.PACKAGE).encode()
        self.run_command("NH-MOCK-001", {"command": "file_write_begin", "scope": "user",
                                         "path": path, "size": len(raw)})
        self.run_command("NH-MOCK-001", {"command": "file_write_chunk", "scope": "user",
                                         "path": path, "offset": 0, "data": raw.hex()})
        self.run_command("NH-MOCK-001", {"command": "file_write_finish", "scope": "user",
                                         "path": path})

    def packages(self):
        return self.run_command("NH-MOCK-001", {"command": "app_list_packages"})["data"]["packages"]

    def test_install_then_activate_then_uninstall(self):
        self.upload("apps/demo.nha")
        installed = self.run_command("NH-MOCK-001", {"command": "app_install", "path": "apps/demo.nha"})
        self.assertEqual(installed["message"], "app_installed")
        self.assertEqual([p["id"] for p in self.packages()], ["heel_strike", "gait_rhythm", "demo"])

        # A "slot" from an old client is accepted and ignored.
        activated = self.run_command("NH-MOCK-001", {"command": "app_activate", "id": "demo", "slot": 1})
        self.assertEqual(activated["message"], "app_activated")
        demo = next(p for p in self.packages() if p["id"] == "demo")
        self.assertTrue(demo["active"])
        self.assertEqual(demo["order"], 1)
        self.assertIn("demo", self.roster("NH-MOCK-001"))

        removed = self.run_command("NH-MOCK-001", {"command": "app_uninstall", "id": "demo"})
        self.assertEqual(removed["message"], "app_uninstalled")
        self.assertEqual([p["id"] for p in self.packages()], ["heel_strike", "gait_rhythm"])
        self.assertNotIn("demo", self.roster("NH-MOCK-001"))

    def test_installing_a_missing_file_is_refused(self):
        result = self.run_command("NH-MOCK-001", {"command": "app_install", "path": "apps/ghost.nha"})
        self.assertEqual(result.get("error"), "package_not_found")

    def test_the_manifest_id_must_match_the_filename(self):
        # Otherwise uninstall and reindex key on a name nothing can remove.
        self.upload("apps/wrong.nha")
        result = self.run_command("NH-MOCK-001", {"command": "app_install", "path": "apps/wrong.nha"})
        self.assertEqual(result.get("error"), "id_path_mismatch:demo")

    def test_installing_twice_needs_replace(self):
        self.upload("apps/demo.nha")
        self.run_command("NH-MOCK-001", {"command": "app_install", "path": "apps/demo.nha"})
        again = self.run_command("NH-MOCK-001", {"command": "app_install", "path": "apps/demo.nha"})
        self.assertEqual(again.get("error"), "already_installed:demo")
        forced = self.run_command("NH-MOCK-001",
                                  {"command": "app_install", "path": "apps/demo.nha", "replace": True})
        self.assertEqual(forced["message"], "app_installed")

    def test_more_than_four_apps_can_run(self):
        # No fixed number: the pool is the limit.
        for index in range(4):
            doc = dict(self.PACKAGE, manifest=dict(self.PACKAGE["manifest"], id=f"d{index}"))
            self.upload(f"apps/d{index}.nha", doc)
            self.run_command("NH-MOCK-001", {"command": "app_install", "path": f"apps/d{index}.nha"})
            result = self.run_command("NH-MOCK-001", {"command": "app_activate", "id": f"d{index}"})
            self.assertEqual(result["message"], "app_activated")
        self.assertEqual(len(self.roster("NH-MOCK-001")), 5)

    def test_a_full_pool_is_refused(self):
        big = dict(self.PACKAGE, padding="x" * 8000)
        self.upload("apps/demo.nha", big)
        self.run_command("NH-MOCK-001", {"command": "app_install", "path": "apps/demo.nha"})
        result = self.run_command("NH-MOCK-001", {"command": "app_activate", "id": "demo"})
        self.assertEqual(result.get("error"), "app_pool_exhausted")

    def test_reorder_moves_an_app_first(self):
        self.run_command("NH-MOCK-001", {"command": "app_activate", "id": "gait_rhythm"})
        self.assertEqual(self.roster("NH-MOCK-001")["gait_rhythm"]["order"], 1)
        result = self.run_command("NH-MOCK-001", {"command": "app_reorder", "id": "gait_rhythm", "to": 0})
        self.assertEqual(result["message"], "app_reordered")
        roster = self.roster("NH-MOCK-001")
        self.assertEqual(roster["gait_rhythm"]["order"], 0)
        self.assertEqual(roster["heel_strike"]["order"], 1)

    def test_deactivate_leaves_the_package_installed(self):
        self.run_command("NH-MOCK-001", {"command": "app_deactivate", "id": "heel_strike"})
        entry = next(p for p in self.packages() if p["id"] == "heel_strike")
        self.assertFalse(entry["active"])
        self.assertEqual(entry["state"], "installed")
        self.assertEqual(self.roster("NH-MOCK-001"), {})

    def test_the_registry_reports_the_pool(self):
        data = self.run_command("NH-MOCK-001", {"command": "app_list_packages"})["data"]
        for key in ("pool_bytes", "pool_used", "pool_free", "control_bytes", "budget_us", "used_us"):
            self.assertIn(key, data)
        self.assertNotIn("slots", data)

    def test_events_are_returned_by_sequence(self):
        events = self.run_command("NH-MOCK-001", {"command": "app_events", "since_seq": 5})["data"]
        # A dropped count, so a lost event and one that never happened differ.
        self.assertIn("dropped", events)
        self.assertEqual([e["seq"] for e in events["events"]], [6])

    def test_events_carry_a_frame_sequence(self):
        events = self.run_command("NH-MOCK-001", {"command": "app_events"})["data"]["events"]
        # This is what lets an app's output line up with a recorded CSV.
        self.assertTrue(all("frame_seq" in event for event in events))


class MockAppViewTests(MockAppCommandTestCase):
    def test_app_view_has_the_firmware_shape(self):
        view = self.run_command("NH-MOCK-001", {"command": "app_view"})["data"]
        self.assertEqual(len(view["oled"]["rows"]), 4)
        self.assertIn(view["status_led"]["owner"], ("system", "heel_strike"))
        self.assertIn("load", view)
        text = view["oled"]["rows"][0]
        # Rows arrive already formatted to the panel's 21 columns.
        self.assertEqual(len(text["text"]), 21)

    def test_a_stopped_app_draws_nothing(self):
        self.run_command("NH-MOCK-001", {"command": "app_stop", "name": "heel_strike"})
        view = self.run_command("NH-MOCK-001", {"command": "app_view"})["data"]
        self.assertEqual(view["oled"]["rows"], [None] * 4)
        self.assertEqual(view["status_led"]["owner"], "system")

class MockProcScopeTests(MockAppCommandTestCase):
    def test_proc_lists_the_synthetic_views(self):
        listed = self.run_command("NH-MOCK-001", {"command": "file_list", "scope": "proc"})
        self.assertEqual(sorted(item["path"] for item in listed["items"]),
                         ["apps", "services", "tasks"])

    def test_proc_apps_reflects_the_roster(self):
        text = self.svc._mock_read_file("NH-MOCK-002", "apps", "proc")
        self.assertIn("heel_strike", text)
        self.assertIn("killed", text)


if __name__ == "__main__":
    unittest.main()
