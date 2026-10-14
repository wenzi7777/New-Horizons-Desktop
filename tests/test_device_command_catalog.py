"""The per-device command catalog (firmware v1.15.0+ `commands`).

With a catalog the device's own table decides what exists and what needs
maintenance mode; without one (older firmware, or before it is fetched) the
static tables in terminal.py / service.py apply unchanged.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.device_commands import (  # noqa: E402
    CATALOG_RETRY_SEC,
    CommandCatalogStore,
    firmware_has_catalog,
)
from newhorizons_backend.service import NewHorizonsService  # noqa: E402
from newhorizons_backend.terminal import compile_terminal_command, validate_device_command_payload  # noqa: E402

UID = "80456B76AAF4"


def row(name, **flags):
    return {"name": name, "maintenance": False, "heavy": False, "quiet": False,
            "internal": False, "status_snapshot": False, "summary": name, **flags}


CATALOG = {
    "hash": 1234,
    "count": 5,
    "commands": [
        row("status", heavy=True, status_snapshot=True),
        row("file_delete", maintenance=True),
        row("exit_maintenance", maintenance=True),
        row("set_transport", internal=True),
        # Added to the firmware after this Desktop: in no static table.
        row("blink_twice"),
    ],
}


class FirmwareVersionTests(unittest.TestCase):
    def test_catalog_starts_at_1_15_0_including_its_betas(self):
        self.assertFalse(firmware_has_catalog("v1.14.0"))
        self.assertFalse(firmware_has_catalog(""))
        self.assertFalse(firmware_has_catalog("garbage"))
        self.assertTrue(firmware_has_catalog("v1.15.0-beta.1"))
        self.assertTrue(firmware_has_catalog("1.15.0"))
        self.assertTrue(firmware_has_catalog("v2.0.0"))


class StoreTests(unittest.TestCase):
    def test_fetch_once_per_firmware_and_retry_after_silence(self):
        store = CommandCatalogStore()
        self.assertFalse(store.needs_fetch(UID, "v1.14.0"))
        self.assertTrue(store.needs_fetch(UID, "v1.15.0", now=100.0))
        store.mark_requested(UID, "v1.15.0", now=100.0)
        self.assertFalse(store.needs_fetch(UID, "v1.15.0", now=101.0))
        self.assertTrue(store.needs_fetch(UID, "v1.15.0", now=100.0 + CATALOG_RETRY_SEC))
        # An OTA to another version asks again right away.
        self.assertTrue(store.needs_fetch(UID, "v1.15.1", now=101.0))

    def test_recorded_catalog_is_kept_for_that_firmware_only(self):
        store = CommandCatalogStore()
        store.mark_requested(UID, "v1.15.0")
        self.assertIsNotNone(store.record(UID, "v1.15.0", CATALOG))
        self.assertFalse(store.needs_fetch(UID, "v1.15.0"))
        self.assertTrue(store.needs_fetch(UID, "v1.15.1"))
        self.assertEqual(store.get(UID).hash, 1234)

    def test_malformed_replies_are_ignored(self):
        store = CommandCatalogStore()
        self.assertIsNone(store.record(UID, "v1.15.0", {"error": "x"}))
        self.assertIsNone(store.record(UID, "v1.15.0", {"commands": []}))
        self.assertIsNone(store.get(UID))

    def test_public_names_leave_out_internal_commands(self):
        store = CommandCatalogStore()
        store.record(UID, "v1.15.0", CATALOG)
        self.assertEqual(store.public_names(UID), {"status", "file_delete", "exit_maintenance", "blink_twice"})
        self.assertIsNone(store.public_names("OTHER"))

    def test_schema_hash_mismatch_drops_the_catalog(self):
        store = CommandCatalogStore()
        store.record(UID, "v1.15.0", CATALOG)
        self.assertFalse(store.invalidate_if_hash_differs(UID, 1234))
        self.assertTrue(store.invalidate_if_hash_differs(UID, 999))
        self.assertIsNone(store.get(UID))
        self.assertTrue(store.needs_fetch(UID, "v1.15.0"))

    def test_mode_error_follows_the_flags(self):
        store = CommandCatalogStore()
        self.assertIsNone(store.mode_error(UID, "status", maintenance=False))
        store.record(UID, "v1.15.0", CATALOG)
        self.assertEqual(store.mode_error(UID, "status", maintenance=False), "")
        self.assertEqual(store.mode_error(UID, "file_delete", maintenance=False), "maintenance_required")
        self.assertEqual(store.mode_error(UID, "file_delete", maintenance=True), "")
        self.assertEqual(store.mode_error(UID, "nope", maintenance=True), "unknown_command")


class ServiceGatingTests(unittest.TestCase):
    def setUp(self):
        self.service = NewHorizonsService(mock_mode=False)

    def gate(self, command, mode):
        with self.service._lock:
            self.service._latest_status[UID] = {"mode": mode}
            return self.service._boot_command_mode_error_locked(UID, {"command": command})

    def test_without_catalog_the_static_tables_apply(self):
        self.assertEqual(self.gate("file_delete", "normal"), "maintenance_required")
        self.assertEqual(self.gate("blink_twice", "normal"), "unknown_command")
        self.assertEqual(self.gate("status", "normal"), "")

    def test_with_catalog_the_device_flags_apply(self):
        self.service._command_catalogs.record(UID, "v1.15.0", CATALOG)
        self.assertEqual(self.gate("blink_twice", "normal"), "")
        self.assertEqual(self.gate("blink_twice", "maintenance"), "")
        self.assertEqual(self.gate("file_delete", "normal"), "maintenance_required")
        self.assertEqual(self.gate("file_delete", "safe"), "")
        # The device does not list it, so it would answer exactly this.
        self.assertEqual(self.gate("calibration_clear_profile", "maintenance"), "unknown_command")
        self.assertEqual(self.gate("status", "booting"), "wrong_mode")
        self.assertEqual(self.gate("status", ""), "")

    def test_status_from_new_firmware_fetches_the_catalog_once(self):
        published = []
        self.service.publish_command = lambda uid, payload: published.append((uid, payload))
        started = []
        with mock.patch("newhorizons_backend.service.threading.Thread") as thread:
            thread.side_effect = lambda target, args, **kw: mock.Mock(start=lambda: started.append(target(*args)))
            status = {"command": "status", "status": "ok", "data": {"firmware_version": "v1.15.0-beta.1", "mode": "normal"}}
            self.service._record_result(UID, dict(status, request_id="a"))
            self.service._record_result(UID, dict(status, request_id="b"))
        self.assertEqual(published, [(UID, {"command": "commands", "quiet": True})])

    def test_status_from_old_firmware_fetches_nothing(self):
        published = []
        self.service.publish_command = lambda uid, payload: published.append((uid, payload))
        self.service._record_result(UID, {"command": "status", "status": "ok",
                                          "data": {"firmware_version": "v1.14.0", "mode": "normal"}})
        self.assertEqual(published, [])

    def test_commands_reply_is_recorded_from_either_envelope(self):
        # Relayed (Gateway/Hub/UDP): data nested.
        self.service._record_result(UID, {"command": "status", "status": "ok",
                                          "data": {"firmware_version": "v1.14.0", "mode": "normal"}})
        self.service._record_result(UID, {"command": "commands", "status": "ok", "data": CATALOG})
        self.assertIn("blink_twice", self.service.device_command_names(UID))
        catalog = self.service.device_command_catalog(UID)
        self.assertEqual(catalog["hash"], 1234)
        self.assertNotIn("set_transport", [item["name"] for item in catalog["commands"]])
        # Direct TCP: _record_arduino_response flattens data into the envelope.
        other = "80456B76AAF5"
        self.service._record_result(other, dict(CATALOG, command="commands", status="ok"))
        self.assertIn("blink_twice", self.service.device_command_names(other))

    def test_error_reply_records_nothing(self):
        self.service._record_result(UID, {"command": "commands", "status": "error", "message": "unknown_command"})
        self.assertIsNone(self.service.device_command_catalog(UID))


class HubRelayedFetchTests(unittest.TestCase):
    """The catalog fetch end to end through a Hub, which pages the reply."""

    def test_backend_commands_carry_a_request_id(self):
        # Pages are joined by request_id; the background fetch used to send
        # none, so every page of its ~19 KB reply was dropped.
        service = NewHorizonsService(mock_mode=False)
        sent = []
        service._gateway_senders[UID] = sent.append
        service._devices[UID] = {"device_uid": UID}
        service.publish_command(UID, {"command": "commands", "quiet": True})
        self.assertTrue(sent[0]["request_id"])
        self.assertEqual(sent[0]["payload"]["request_id"], sent[0]["request_id"])
        # One the caller chose is kept.
        service.publish_command(UID, {"command": "status", "request_id": "mine"})
        self.assertEqual(sent[1]["request_id"], "mine")

    def test_asking_for_a_missing_catalog_fetches_it(self):
        service = NewHorizonsService(mock_mode=False)
        published = []
        service.publish_command = lambda uid, payload: published.append(payload["command"])
        service._devices[UID] = {"device_uid": UID, "firmware_version": "v1.15.0-beta.3"}
        with mock.patch("newhorizons_backend.service.threading.Thread") as thread:
            thread.side_effect = lambda target, args, **kw: mock.Mock(start=lambda: target(*args))
            self.assertIsNone(service.device_command_catalog(UID))
            self.assertIsNone(service.device_command_catalog(UID))  # already requested
        self.assertEqual(published, ["commands"])

    def test_unknown_firmware_is_asked_for_first(self):
        # After a backend restart a device behind a Hub has no known firmware
        # until a status arrives; the Terminal page triggers no status.
        service = NewHorizonsService(mock_mode=False)
        published = []
        service.publish_command = lambda uid, payload: published.append(payload["command"])
        service._devices[UID] = {"device_uid": UID}
        with mock.patch("newhorizons_backend.service.threading.Thread") as thread:
            thread.side_effect = lambda target, args, **kw: mock.Mock(start=lambda: target(*args))
            self.assertIsNone(service.device_command_catalog(UID))
            self.assertIsNone(service.device_command_catalog(UID))  # probed recently
            self.assertEqual(published, ["capabilities"])
            # Its reply carries the version and goes on to fetch the catalog.
            service._record_result(UID, {"command": "capabilities", "status": "ok", "ok": True,
                                         "data": {"firmware_version": "v1.15.0-beta.3", "command_schema_hash": 1}})
        self.assertEqual(published, ["capabilities", "commands"])

    def test_old_firmware_is_probed_once_then_left_alone(self):
        service = NewHorizonsService(mock_mode=False)
        published = []
        service.publish_command = lambda uid, payload: published.append(payload["command"])
        service._devices[UID] = {"device_uid": UID}
        with mock.patch("newhorizons_backend.service.threading.Thread") as thread:
            thread.side_effect = lambda target, args, **kw: mock.Mock(start=lambda: target(*args))
            service.device_command_catalog(UID)
            service._record_result(UID, {"command": "capabilities", "status": "ok", "ok": True,
                                         "data": {"firmware_version": "v1.14.0"}})
            service.device_command_catalog(UID)
        self.assertEqual(published, ["capabilities"])

    def test_a_paged_catalog_reply_is_recorded(self):
        import json
        service = NewHorizonsService(mock_mode=False)
        sent = []
        service._gateway_senders[UID] = sent.append
        service._devices[UID] = {"device_uid": UID}
        service._record_result(UID, {"command": "status", "status": "ok", "ok": True,
                                     "data": {"firmware_version": "v1.15.0-beta.3", "mode": "normal"}})
        service._fetch_command_catalog(UID)
        request = sent[-1]
        self.assertEqual(request["payload"]["command"], "commands")
        reply = json.dumps({"ok": True, "cmd": "commands", "message": "commands", "data": CATALOG, "error": ""})
        size = len(reply) // 3 + 1
        for i in range(3):
            # What a Hub sends for each page (EspNowCommandDispatcher).
            service.record_gateway_result_chunk(UID, {
                "request_id": request["request_id"], "command": "commands",
                "page": {"rid": 1, "chunk": i, "chunks": 3, "data": reply[i * size:(i + 1) * size]},
            })
        self.assertIn("blink_twice", service.device_command_names(UID))


class AllowlistTests(unittest.TestCase):
    def test_catalog_commands_pass_validation(self):
        with self.assertRaises(ValueError):
            validate_device_command_payload({"command": "blink_twice"})
        payload = validate_device_command_payload({"command": "blink_twice"}, {"blink_twice"})
        self.assertEqual(payload["command"], "blink_twice")
        # Payload checks still apply to catalog-admitted commands.
        with self.assertRaises(ValueError):
            validate_device_command_payload({"command": "file_delete", "scope": "proc"}, {"file_delete"})

    def test_generic_terminal_compile_for_catalog_commands(self):
        with self.assertRaises(ValueError):
            compile_terminal_command("blink-twice --count 3")
        compiled = compile_terminal_command(
            "blink-twice --count 3 --gain 0.5 --enabled true --id 0123 --name led", {"blink_twice"}
        )
        self.assertEqual(compiled["payload"], {
            "command": "blink_twice", "count": 3, "gain": 0.5, "enabled": True, "id": "0123", "name": "led",
        })

    def test_dedicated_parsers_win_over_the_generic_one(self):
        compiled = compile_terminal_command("log-tail --lines 5", {"log_tail"})
        self.assertEqual(compiled["payload"], {"command": "log_tail", "max_lines": 5})


if __name__ == "__main__":
    unittest.main()
