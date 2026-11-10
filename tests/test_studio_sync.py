"""Server side of NH Studio / NH Pocket sync: app tokens, relays that are
apps, recording upload, label and profile sync, and the FindMe policy."""
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

from newhorizons_backend import gateway_ws  # noqa: E402
from newhorizons_backend.auth import AuthManager, AuthUser  # noqa: E402
from newhorizons_backend.discovery import DiscoveryResponder, FindmePolicy, decide_findme  # noqa: E402
from newhorizons_backend.gateway_ws import GatewaySocketSession  # noqa: E402
from newhorizons_backend.standalone import create_standalone_app  # noqa: E402

UID = "3CDC7545CCD0"
PREFIX = "/newhorizons/api"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _Env(unittest.TestCase):
    def setUp(self):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        self.tmp = Path(tmpdir.name)
        self.data_root = self.tmp / "store"
        self.profiles_root = self.tmp / "profiles"
        env = {
            "NEWHORIZONS_AUTOSTART": "0",
            "NEWHORIZONS_AUTH_DB": str(self.tmp / "auth.sqlite3"),
            "NEWHORIZONS_DATA_ROOT": str(self.data_root),
            "NEWHORIZONS_PROFILES_DIR": str(self.profiles_root),
        }
        patcher = patch.dict("os.environ", env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.app = create_standalone_app()
        self.service = self.app.config["NEWHORIZONS_SERVICE"]
        self.auth: AuthManager = self.app.config["NEWHORIZONS_AUTH_MANAGER"]

    def admin_client(self):
        client = self.app.test_client()
        self.assertEqual(client.post(f"{PREFIX}/auth/login", json={"username": "admin", "password": "admin"}).status_code, 200)
        return client

    def app_token(self, client_type="studio", role="admin", name="Lab Mac"):
        response = self.admin_client().post(f"{PREFIX}/app-tokens", json={"name": name, "client_type": client_type, "role": role})
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["token"], response.get_json()["item"]

    def bearer(self, token):
        return {"Authorization": f"Bearer {token}"}


class AppTokenTest(_Env):
    def test_admin_creates_lists_and_revokes_tokens_only_hash_is_stored(self):
        token, item = self.app_token("pocket", name="Factory phone")
        self.assertTrue(token.startswith("nhapp_"))
        self.assertEqual(item["client_type"], "pocket")
        self.assertTrue(item["active"])
        self.assertNotIn(token, (self.tmp / "auth.sqlite3").read_bytes().decode("latin-1"))
        listing = self.admin_client().get(f"{PREFIX}/app-tokens").get_json()["items"]
        self.assertEqual([entry["id"] for entry in listing], [item["id"]])
        self.assertNotIn("token", listing[0])

        client = self.app.test_client()
        me = client.get(f"{PREFIX}/auth/me", headers=self.bearer(token)).get_json()
        self.assertEqual(me["app_id"], item["id"])
        self.assertEqual(me["client_type"], "pocket")
        self.assertEqual(client.get(f"{PREFIX}/devices", headers=self.bearer(token)).status_code, 200)

        revoked = self.admin_client().delete(f"{PREFIX}/app-tokens/{item['id']}")
        self.assertEqual(revoked.status_code, 200)
        self.assertFalse(revoked.get_json()["item"]["active"])
        self.assertEqual(client.get(f"{PREFIX}/devices", headers=self.bearer(token)).status_code, 401)
        self.assertEqual(self.admin_client().delete(f"{PREFIX}/app-tokens/nope").status_code, 404)

    def test_wrong_tokens_and_unauthenticated_requests_are_refused(self):
        token, _ = self.app_token()
        client = self.app.test_client()
        self.assertEqual(client.get(f"{PREFIX}/devices").status_code, 401)
        self.assertEqual(client.get(f"{PREFIX}/devices", headers=self.bearer(token[:-2] + "xx")).status_code, 401)
        self.assertEqual(client.get(f"{PREFIX}/devices", headers=self.bearer("garbage")).status_code, 401)

    def test_user_role_token_cannot_reach_admin_routes(self):
        token, _ = self.app_token(role="user")
        client = self.app.test_client()
        self.assertEqual(client.get(f"{PREFIX}/devices", headers=self.bearer(token)).status_code, 200)
        self.assertEqual(client.get(f"{PREFIX}/gateways", headers=self.bearer(token)).status_code, 403)

    def test_tokens_cannot_mint_tokens_and_bad_input_is_rejected(self):
        token, _ = self.app_token()
        client = self.app.test_client()
        self.assertEqual(client.get(f"{PREFIX}/app-tokens", headers=self.bearer(token)).status_code, 403)
        self.assertEqual(client.post(f"{PREFIX}/app-tokens", headers=self.bearer(token), json={"name": "x", "client_type": "studio"}).status_code, 403)
        self.assertEqual(client.get(f"{PREFIX}/app-tokens").status_code, 401)
        admin = self.admin_client()
        self.assertEqual(admin.post(f"{PREFIX}/app-tokens", json={"name": "x", "client_type": "gateway"}).get_json()["error"], "client_type_invalid")
        self.assertEqual(admin.post(f"{PREFIX}/app-tokens", json={"client_type": "studio"}).get_json()["error"], "name_required")

    def test_cookie_login_is_unchanged(self):
        client = self.admin_client()
        self.assertEqual(client.get(f"{PREFIX}/auth/me").get_json(), {"authenticated": True, "username": "admin", "role": "admin"})

    def test_ws_handshake_accepts_bearer_header_or_token_query(self):
        token, item = self.app_token()
        with self.app.test_request_context("/newhorizons/ws", headers=self.bearer(token)):
            from flask import request
            self.assertEqual(self.auth.request_user(request.headers, request.args).app_id, item["id"])
        with self.app.test_request_context(f"/newhorizons/ws?token={token}"):
            from flask import request
            self.assertEqual(self.auth.request_user(request.headers, request.args).client_type, "studio")
        with self.app.test_request_context("/newhorizons/ws"):
            from flask import request
            self.assertIsNone(self.auth.request_user(request.headers, request.args))


class _FakeWs:
    def __init__(self):
        self.sent = []

    def send(self, payload):
        self.sent.append(json.loads(payload))


class RelayClientTypeTest(_Env):
    def session(self, app_user=None):
        ws = _FakeWs()
        return GatewaySocketSession(self.service, ws, app_user=app_user), ws

    def hello(self, session, **fields):
        with patch.object(gateway_ws, "latest_gateway_version", return_value="v9.9.9"), \
             patch.object(gateway_ws, "latest_hub_version", return_value="v0.9.9"):
            session._handle_json(json.dumps({"type": "hello", **fields}))

    def relay(self, gateway_id):
        return next(item for item in self.service.gateway_snapshot() if item["gateway_id"] == gateway_id)

    def test_studio_and_pocket_register_with_their_own_names(self):
        for client_type, name in (("studio", "NH Studio"), ("pocket", "NH Pocket")):
            session, ws = self.session()
            self.hello(session, gateway_id=f"nh-{client_type}-1", client_type=client_type)
            entry = self.relay(f"nh-{client_type}-1")
            self.assertEqual(entry["client_type"], client_type)
            self.assertEqual(entry["gateway_name"], name)
            self.assertFalse(entry["legacy"])
            self.assertFalse(entry["authenticated"])
            ack = ws.sent[-1]
            self.assertEqual(ack["client_type"], client_type)
            self.assertNotIn("latest_gateway_version", ack)

    def test_old_gateway_and_hub_keep_working_and_gateway_is_legacy(self):
        session, ws = self.session()
        self.hello(session, gateway_id="nh-gateway-abc")
        entry = self.relay("nh-gateway-abc")
        self.assertEqual(entry["client_type"], "gateway")
        self.assertEqual(entry["gateway_name"], "NH Gateway")
        self.assertTrue(entry["legacy"])
        self.assertEqual(ws.sent[-1]["latest_gateway_version"], "v9.9.9")
        session, ws = self.session()
        self.hello(session, gateway_id="hub-1", client_type="hub")
        self.assertEqual(self.relay("hub-1")["client_type"], "hub")
        self.assertEqual(ws.sent[-1]["latest_hub_version"], "v0.9.9")
        session, _ = self.session()
        self.hello(session, gateway_id="odd-1", client_type="toaster")
        self.assertEqual(self.relay("odd-1")["client_type"], "gateway")

    def test_app_token_sets_identity_and_default_gateway_id(self):
        _, item = self.app_token("pocket")
        user = AuthUser(username=f"app:{item['id']}", role="admin", app_id=item["id"], client_type="pocket")
        session, ws = self.session(app_user=user)
        # A relay claiming to be something else is the token's kind anyway.
        self.hello(session, client_type="studio")
        gateway_id = f"nh-pocket-{item['id']}"
        entry = self.relay(gateway_id)
        self.assertEqual(entry["client_type"], "pocket")
        self.assertTrue(entry["authenticated"])
        self.assertEqual(entry["app_id"], item["id"])
        self.assertEqual(ws.sent[-1]["app_id"], item["id"])
        # Later messages without client_type keep it.
        session._handle_json(json.dumps({"type": "gateway_claim_request", "gateway_id": gateway_id, "device_uid": UID, "claim_id": "c1"}))
        self.assertEqual(self.relay(gateway_id)["client_type"], "pocket")

    def test_tokens_can_be_required_for_apps(self):
        with patch.dict("os.environ", {"NEWHORIZONS_REQUIRE_APP_TOKEN": "1"}):
            session, ws = self.session()
            self.hello(session, gateway_id="nh-studio-x", client_type="studio")
            self.assertEqual(ws.sent[-1]["code"], "app_token_required")
            self.assertEqual([i for i in self.service.gateway_snapshot() if i["gateway_id"] == "nh-studio-x"], [])
            session, _ = self.session()
            self.hello(session, gateway_id="nh-gateway-y")
            self.assertEqual(self.relay("nh-gateway-y")["client_type"], "gateway")

    def test_studio_relay_takes_gateway_commands_when_capable(self):
        session, _ = self.session()
        self.hello(session, gateway_id="nh-studio-c", client_type="studio", capabilities=["gateway_command"])
        sent = []
        self.service._gateway_session_senders["nh-studio-c"] = sent.append
        result = self.service.publish_gateway_command("nh-studio-c", {"command": next(iter(self.service.GATEWAY_COMMANDS))})
        self.assertEqual(result["status"], "queued")
        self.assertEqual(sent[0]["type"], "gateway_command")


class RecordingUploadTest(_Env):
    DATA = b"timestamp_ms,frame_seq,P1\n" + b"".join(f"{i},{i},{i * 3}\n".encode() for i in range(5000))
    EVENTS = b"timestamp_ms,event\n1,start\n"
    META = json.dumps({"format": 1, "device": {"uid": UID, "nickname": "left"}, "transport": {"path": "pocket", "relay": "pocket"}}).encode()

    def setUp(self):
        super().setUp()
        self.token, self.item = self.app_token("pocket", name="Factory phone")
        self.client = self.app.test_client()
        self.headers = self.bearer(self.token)

    def begin(self, recording_id="rec-0001-abcd", data=None, **extra):
        data = self.DATA if data is None else data
        body = {
            "recording_id": recording_id,
            "device_uid": UID,
            "started_at": "2026-11-10T06:27:56.120Z",
            "files": [
                {"role": "data", "size": len(data), "sha256": sha(data)},
                {"role": "events", "size": len(self.EVENTS), "sha256": sha(self.EVENTS)},
                {"role": "meta", "size": len(self.META), "sha256": sha(self.META)},
            ],
            **extra,
        }
        return self.client.post(f"{PREFIX}/sync/recordings", json=body, headers=self.headers)

    def put(self, recording_id, role, offset, chunk):
        return self.client.put(
            f"{PREFIX}/sync/recordings/{recording_id}/files/{role}?offset={offset}",
            data=chunk,
            headers={**self.headers, "Content-Type": "application/octet-stream"},
        )

    def upload_all(self, recording_id="rec-0001-abcd", data=None):
        data = self.DATA if data is None else data
        for role, blob in (("data", data), ("events", self.EVENTS), ("meta", self.META)):
            self.assertEqual(self.put(recording_id, role, 0, blob).status_code, 200)
        return self.client.post(f"{PREFIX}/sync/recordings/{recording_id}/complete", headers=self.headers)

    def test_upload_lands_in_the_recording_layout_with_source(self):
        started = self.begin()
        self.assertEqual(started.status_code, 200, started.get_json())
        self.assertEqual(started.get_json()["status"], "uploading")
        self.assertTrue(all(f["received"] == 0 for f in started.get_json()["files"]))
        done = self.upload_all()
        self.assertEqual(done.status_code, 200, done.get_json())
        payload = done.get_json()
        self.assertEqual(payload["status"], "complete")
        self.assertEqual(payload["path"], f"{UID}/20261110/062756")
        folder = self.data_root / UID / "20261110" / "062756"
        self.assertEqual((folder / "062756.data.csv").read_bytes(), self.DATA)
        self.assertEqual((folder / "062756.events.csv").read_bytes(), self.EVENTS)
        meta = json.loads((folder / "062756.meta.json").read_text())
        self.assertEqual(meta["files"], {"data": "062756.data.csv", "events": "062756.events.csv"})
        self.assertEqual(meta["device"]["nickname"], "left")
        self.assertEqual(meta["source"]["app_id"], self.item["id"])
        self.assertEqual(meta["source"]["client_type"], "pocket")
        self.assertEqual(meta["source"]["app_name"], "Factory phone")
        self.assertEqual(meta["source"]["recording_id"], "rec-0001-abcd")
        # The Files page sees it as a recording.
        listing = self.admin_client().get(f"{PREFIX}/files?device_uid={UID}&path=20261110").get_json()
        self.assertEqual(listing["items"][0]["kind"], "recording")

    def test_resume_after_partial_chunks(self):
        self.begin()
        half = len(self.DATA) // 2
        self.assertEqual(self.put("rec-0001-abcd", "data", 0, self.DATA[:half]).get_json()["received"], half)
        # Connection lost; the app asks where it was, or simply begins again.
        status = self.client.get(f"{PREFIX}/sync/recordings/rec-0001-abcd", headers=self.headers).get_json()
        self.assertEqual({f["role"]: f["received"] for f in status["files"]}["data"], half)
        again = self.begin().get_json()
        self.assertEqual({f["role"]: f["received"] for f in again["files"]}["data"], half)
        # A resent chunk at the old offset is refused with the right offset.
        mismatch = self.put("rec-0001-abcd", "data", 0, self.DATA[:half])
        self.assertEqual(mismatch.status_code, 409)
        self.assertEqual(mismatch.get_json(), {"error": "offset_mismatch", "role": "data", "received": half})
        self.assertEqual(self.put("rec-0001-abcd", "data", half, self.DATA[half:]).status_code, 200)
        early = self.client.post(f"{PREFIX}/sync/recordings/rec-0001-abcd/complete", headers=self.headers)
        self.assertEqual(early.status_code, 409)
        self.assertEqual(early.get_json()["error"], "upload_incomplete")
        self.put("rec-0001-abcd", "events", 0, self.EVENTS)
        self.put("rec-0001-abcd", "meta", 0, self.META)
        done = self.client.post(f"{PREFIX}/sync/recordings/rec-0001-abcd/complete", headers=self.headers)
        self.assertEqual(done.status_code, 200)
        self.assertEqual((self.data_root / UID / "20261110" / "062756" / "062756.data.csv").read_bytes(), self.DATA)

    def test_reupload_of_same_recording_is_a_no_op(self):
        self.begin()
        first = self.upload_all().get_json()
        again = self.begin()
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.get_json()["status"], "complete")
        self.assertEqual(again.get_json()["path"], first["path"])
        self.assertEqual(self.client.post(f"{PREFIX}/sync/recordings/rec-0001-abcd/complete", headers=self.headers).get_json()["path"], first["path"])
        self.assertEqual(self.put("rec-0001-abcd", "data", 0, b"x").status_code, 409)
        self.assertEqual(sorted(p.name for p in (self.data_root / UID / "20261110").iterdir()), ["062756"])
        conflict = self.begin(data=self.DATA + b"1,1,1\n")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.get_json()["error"], "recording_id_conflict")

    def test_deleted_recording_can_be_uploaded_again(self):
        self.begin()
        self.upload_all()
        import shutil
        # Deleted on the server (the Files page) after it was synced.
        shutil.rmtree(self.data_root / UID / "20261110" / "062756", ignore_errors=True)
        self.assertEqual(self.begin().get_json()["status"], "uploading")

    def test_checksum_mismatch_discards_the_file(self):
        self.begin()
        bad = bytearray(self.DATA)
        bad[10] ^= 1
        self.put("rec-0001-abcd", "data", 0, bytes(bad))
        self.put("rec-0001-abcd", "events", 0, self.EVENTS)
        self.put("rec-0001-abcd", "meta", 0, self.META)
        response = self.client.post(f"{PREFIX}/sync/recordings/rec-0001-abcd/complete", headers=self.headers)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["roles"], ["data"])
        status = self.client.get(f"{PREFIX}/sync/recordings/rec-0001-abcd", headers=self.headers).get_json()
        self.assertEqual({f["role"]: f["received"] for f in status["files"]}, {"data": 0, "events": len(self.EVENTS), "meta": len(self.META)})

    def test_bad_requests(self):
        self.assertEqual(self.begin(recording_id="../../etc").get_json()["error"], "recording_id_invalid")
        self.assertEqual(self.begin(started_at="2026-11-10T06:27:56").get_json()["error"], "started_at_needs_time_zone")
        self.assertEqual(self.begin(device_uid="not a uid").get_json()["error"], "device_uid_invalid")
        self.assertEqual(self.client.post(f"{PREFIX}/sync/recordings", json={"recording_id": "rec-0002-abcd", "device_uid": UID, "started_at": "2026-11-10T00:00:00Z", "files": [{"role": "meta", "size": 1, "sha256": "0" * 64}]}, headers=self.headers).get_json()["error"], "data_file_required")
        self.begin()
        self.assertEqual(self.put("rec-0001-abcd", "data", 0, self.DATA + b"extra").get_json()["error"], "chunk_exceeds_size")
        self.assertEqual(self.client.get(f"{PREFIX}/sync/recordings/rec-9999-none", headers=self.headers).status_code, 404)
        self.assertEqual(self.app.test_client().get(f"{PREFIX}/sync/recordings").status_code, 401)

    def test_list_and_download(self):
        self.begin()
        self.upload_all()
        # One of the server's own recordings, too.
        own = self.data_root / UID / "20261109" / "101010"
        own.mkdir(parents=True)
        (own / "101010.data.csv").write_text("a\n1\n")
        listing = self.client.get(f"{PREFIX}/sync/recordings?device_uid={UID}", headers=self.headers).get_json()
        self.assertEqual(listing["total"], 2)
        by_path = {item["path"]: item for item in listing["items"]}
        uploaded = by_path[f"{UID}/20261110/062756"]
        self.assertEqual(uploaded["recording_id"], "rec-0001-abcd")
        self.assertEqual(uploaded["source"]["client_type"], "pocket")
        self.assertEqual(sorted(f["role"] for f in uploaded["files"]), ["data", "events", "meta"])
        self.assertEqual(by_path[f"{UID}/20261109/101010"]["source"], {"client_type": "server"})
        paged = self.client.get(f"{PREFIX}/sync/recordings?limit=1", headers=self.headers).get_json()
        self.assertEqual((len(paged["items"]), paged["next_offset"]), (1, 1))
        download = self.client.get(f"{PREFIX}/sync/recordings/file?path={UID}/20261110/062756&role=data", headers=self.headers)
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.data, self.DATA)
        download.close()
        ranged = self.client.get(f"{PREFIX}/sync/recordings/file?path={UID}/20261110/062756&role=data", headers={**self.headers, "Range": "bytes=10-19"})
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(ranged.data, self.DATA[10:20])
        ranged.close()
        self.assertEqual(self.client.get(f"{PREFIX}/sync/recordings/file?path=../x/y&role=data", headers=self.headers).status_code, 400)
        self.assertEqual(self.client.get(f"{PREFIX}/sync/recordings/file?path=_newhorizons_sync/uploads/x&role=data", headers=self.headers).status_code, 400)


class LabelSyncTest(_Env):
    def setUp(self):
        super().setUp()
        self.token, _ = self.app_token()
        self.client = self.app.test_client()
        self.headers = self.bearer(self.token)

    def test_last_writer_wins_per_field(self):
        admin = self.admin_client()
        self.assertEqual(admin.put(f"{PREFIX}/devices/{UID}/nickname", json={"nickname": "Left glove"}).status_code, 200)
        snap = self.client.get(f"{PREFIX}/sync/labels", headers=self.headers).get_json()
        item = next(i for i in snap["items"] if i["device_uid"] == UID)
        self.assertEqual(item["nickname"], "Left glove")
        server_ms = item["nickname_updated_ms"]
        self.assertGreater(server_ms, 0)
        older = self.client.put(f"{PREFIX}/sync/labels", headers=self.headers, json={"items": [
            {"device_uid": UID, "nickname": "Old", "nickname_updated_ms": server_ms - 1, "group": "Lab A", "group_updated_ms": server_ms + 5},
        ]}).get_json()["items"][0]
        self.assertEqual(older["nickname"], "Left glove")
        self.assertEqual(older["group"], "Lab A")
        self.assertEqual(older["applied"], ["group"])
        newer = self.client.put(f"{PREFIX}/sync/labels", headers=self.headers, json={"items": [
            {"device_uid": UID.lower(), "nickname": "", "nickname_updated_ms": server_ms + 10},
        ]}).get_json()["items"][0]
        self.assertEqual((newer["nickname"], newer["applied"]), ("", ["nickname"]))
        # A cleared label is still listed (a tombstone) so others clear it too.
        since = self.client.get(f"{PREFIX}/sync/labels?since_ms={server_ms + 6}", headers=self.headers).get_json()["items"]
        self.assertEqual([(i["device_uid"], i["nickname"], i["nickname_updated_ms"]) for i in since], [(UID, "", server_ms + 10)])
        self.assertEqual(self.service._device_groups[UID], "Lab A")
        # Persisted across a restart.
        times = json.loads((self.data_root / "_newhorizons_device_label_times.json").read_text())
        self.assertEqual(times[UID]["nickname"], server_ms + 10)

    def test_bad_label_items(self):
        put = lambda items: self.client.put(f"{PREFIX}/sync/labels", headers=self.headers, json={"items": items})
        self.assertEqual(put([{"device_uid": UID, "nickname": "x"}]).get_json()["error"], "nickname_updated_ms_required")
        self.assertEqual(put([{"device_uid": "zz", "nickname": "x", "nickname_updated_ms": 5}]).get_json()["error"], "device_uid_invalid")
        self.assertEqual(put([{"device_uid": UID, "group": "g" * 65, "group_updated_ms": 5}]).get_json()["error"], "group_too_long")
        self.assertEqual(self.client.put(f"{PREFIX}/sync/labels", headers=self.headers, json={}).get_json()["error"], "items_required")


class ProfileSyncTest(_Env):
    def setUp(self):
        super().setUp()
        self.token, _ = self.app_token()
        self.client = self.app.test_client()
        self.headers = self.bearer(self.token)

    def snapshot(self, since=0):
        return self.client.get(f"{PREFIX}/sync/profiles?since_ms={since}", headers=self.headers).get_json()

    def test_profiles_sync_both_ways_last_writer_wins(self):
        admin = self.admin_client()
        admin.post(f"{PREFIX}/profiles/glove", json={"name": "Glove", "rows": 5})
        items = {i["name"]: i for i in self.snapshot()["items"]}
        self.assertEqual(items["glove"]["profile"], {"name": "Glove", "rows": 5})
        server_ms = items["glove"]["updated_ms"]
        # The listing still shows only real profiles.
        self.assertEqual([i["name"] for i in admin.get(f"{PREFIX}/profiles").get_json()["items"]], ["glove"])

        result = self.client.put(f"{PREFIX}/sync/profiles", headers=self.headers, json={"items": [
            {"name": "glove", "updated_ms": server_ms - 1, "profile": {"name": "Stale"}},
            {"name": "insole", "updated_ms": server_ms + 1, "profile": {"name": "Insole", "rows": 7}},
        ]}).get_json()["items"]
        self.assertEqual([(r["name"], r["applied"]) for r in result], [("glove", False), ("insole", True)])
        self.assertEqual(result[0]["profile"], {"name": "Glove", "rows": 5})
        self.assertEqual(admin.get(f"{PREFIX}/profiles/insole").get_json()["rows"], 7)

        deleted = self.client.put(f"{PREFIX}/sync/profiles", headers=self.headers, json={"items": [
            {"name": "glove", "updated_ms": server_ms + 2, "deleted": True},
        ]}).get_json()["items"][0]
        self.assertTrue(deleted["applied"] and deleted["deleted"])
        self.assertEqual(admin.get(f"{PREFIX}/profiles/glove").status_code, 404)
        since = {i["name"]: i for i in self.snapshot(server_ms + 1)["items"]}
        self.assertEqual(since["glove"], {"name": "glove", "updated_ms": server_ms + 2, "deleted": True})
        self.assertNotIn("insole", since)

    def test_deleting_from_the_page_leaves_a_tombstone(self):
        admin = self.admin_client()
        admin.post(f"{PREFIX}/profiles/temp", json={"name": "Temp"})
        admin.delete(f"{PREFIX}/profiles/temp")
        item = next(i for i in self.snapshot()["items"] if i["name"] == "temp")
        self.assertTrue(item["deleted"])

    def test_bad_profile_items(self):
        put = lambda items: self.client.put(f"{PREFIX}/sync/profiles", headers=self.headers, json={"items": items}).get_json()
        self.assertEqual(put([{"name": "../x", "updated_ms": 1, "profile": {}}])["error"], "profile_name_invalid")
        self.assertEqual(put([{"name": "x", "profile": {}}])["error"], "updated_ms_required")
        self.assertEqual(put([{"name": "x", "updated_ms": 1}])["error"], "profile_required")


class FindmePolicyTest(_Env):
    GW = "newhorizons-standalone"

    def decide(self, request, policy=FindmePolicy()):
        return decide_findme(request, gateway_id=self.GW, policy=policy)

    def test_attached_elsewhere_is_never_taken(self):
        self.assertEqual(self.decide({"device_uid": UID, "current_gateway_id": "nh-studio-x"}), (False, "device_attached_elsewhere", False))
        self.assertEqual(self.decide({"device_uid": UID, "current_gateway_id": self.GW}), (True, "", True))
        self.assertEqual(self.decide({"device_uid": UID}), (True, "", True))

    def test_switching_deny_and_managed(self):
        self.assertEqual(self.decide({"device_uid": UID, "preferred_gateway_id": "nh-pocket-1"}), (True, "device_switching_gateway", False))
        deny = FindmePolicy(denied=(UID,))
        self.assertEqual(self.decide({"device_uid": UID.lower()}, deny), (True, "device_rejected", False))
        managed = FindmePolicy(offer_policy="managed", managed=("AABBCCDDEEFF",))
        self.assertEqual(self.decide({"device_uid": UID}, managed), (False, "device_not_managed", False))
        self.assertEqual(self.decide({"device_uid": "AABBCCDDEEFF"}, managed), (True, "", True))

    def test_responder_replies_follow_the_policy(self):
        policy = {"value": FindmePolicy(denied=(UID,))}
        responder = DiscoveryResponder("127.0.0.1", 0, gateway_id=self.GW, udp_port=13250, policy=lambda: policy["value"])
        decline = json.loads(responder.reply_for({"device_uid": UID}))
        self.assertEqual((decline["accept"], decline["reason"], decline["cooldown_ms"]), (False, "device_rejected", 30000))
        self.assertIsNone(responder.reply_for({"device_uid": "AABBCCDDEEFF", "current_gateway_id": "nh-studio-x"}))
        offer = json.loads(responder.reply_for({"device_uid": "AABBCCDDEEFF"}))
        self.assertTrue(offer["accept"])
        self.assertEqual(offer["type"], "findme_offer")
        # Default (no policy given): offers to everyone, as before.
        legacy = DiscoveryResponder("127.0.0.1", 0, gateway_id=self.GW, udp_port=13250)
        self.assertTrue(json.loads(legacy.reply_for({"device_uid": UID}))["accept"])

    def test_policy_api_persists_and_validates(self):
        admin = self.admin_client()
        self.assertEqual(admin.get(f"{PREFIX}/findme/policy").get_json()["offer_policy"], "all")
        saved = admin.put(f"{PREFIX}/findme/policy", json={"offer_policy": "managed", "managed": ["3c:dc:75:45:cc:d0", "bad uid"], "denied": "AABBCCDDEEFF"}).get_json()
        self.assertEqual((saved["offer_policy"], saved["managed"], saved["denied"]), ("managed", [UID], ["AABBCCDDEEFF"]))
        stored = json.loads((self.data_root / "_newhorizons_findme_policy.json").read_text())
        self.assertEqual(stored["managed"], [UID])
        self.assertEqual(self.service._findme_policy.offer_policy, "managed")
        self.assertEqual(admin.put(f"{PREFIX}/findme/policy", json={"offer_policy": "some"}).get_json()["error"], "offer_policy_invalid")
        partial = admin.put(f"{PREFIX}/findme/policy", json={"denied": []}).get_json()
        self.assertEqual((partial["offer_policy"], partial["managed"], partial["denied"]), ("managed", [UID], []))

    def test_env_sets_the_starting_policy(self):
        with patch.dict("os.environ", {"NEWHORIZONS_FINDME_OFFER_POLICY": "managed", "NEWHORIZONS_FINDME_MANAGED": f"{UID},AABBCCDDEEFF"}):
            policy = FindmePolicy.from_env()
        self.assertEqual((policy.offer_policy, policy.managed), ("managed", (UID, "AABBCCDDEEFF")))


if __name__ == "__main__":
    unittest.main()
