import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.auth import AuthManager, AuthUser  # noqa: E402
from newhorizons_backend.gateway_auth import gateway_expected_token  # noqa: E402
from newhorizons_backend.service import NewHorizonsService  # noqa: E402
from newhorizons_backend.standalone import create_standalone_app  # noqa: E402
from newhorizons_backend.ws import WebSocketHub, _WsClient  # noqa: E402


class _FakeSocket:
    def send(self, payload):
        return payload


class NewHorizonsAuthTest(unittest.TestCase):
    def create_client(self):
        tmpdir = tempfile.TemporaryDirectory()
        env = {
            "NEWHORIZONS_AUTOSTART": "0",
            "NEWHORIZONS_AUTH_DB": str(Path(tmpdir.name) / "auth.sqlite3"),
        }
        patcher = patch.dict("os.environ", env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(tmpdir.cleanup)
        app = create_standalone_app()
        return app.test_client(), Path(env["NEWHORIZONS_AUTH_DB"]), app

    def test_auth_seeds_users_and_accepts_legacy_and_new_passwords(self):
        client, db_path, _ = self.create_client()
        manager = AuthManager(db_path)

        self.assertEqual(manager.authenticate("admin", "admin"), AuthUser(username="admin", role="admin"))
        self.assertEqual(manager.authenticate("admin", "uoacnlab2026"), AuthUser(username="admin", role="admin"))
        self.assertEqual(manager.authenticate("user", "nedo"), AuthUser(username="user", role="user"))
        self.assertEqual(manager.authenticate("user", "uoacnlab2026"), AuthUser(username="user", role="user"))

        response = client.post("/newhorizons/api/auth/login", json={"username": "admin", "password": "bad-password"})
        self.assertEqual(response.status_code, 401)

    def test_auth_me_and_admin_login_expose_authenticated_session(self):
        client, _, _ = self.create_client()

        before = client.get("/newhorizons/api/auth/me")
        self.assertEqual(before.get_json(), {"authenticated": False})

        login = client.post("/newhorizons/api/auth/login", json={"username": "admin", "password": "admin"})
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.get_json()["user"]["role"], "admin")

        after = client.get("/newhorizons/api/auth/me")
        self.assertEqual(
            after.get_json(),
            {"authenticated": True, "username": "admin", "role": "admin"},
        )

    def test_user_role_can_access_visualization_and_profiles_but_not_admin_routes(self):
        client, _, _ = self.create_client()
        login = client.post("/newhorizons/api/auth/login", json={"username": "user", "password": "nedo"})
        self.assertEqual(login.status_code, 200)

        self.assertEqual(client.get("/newhorizons/api/health").status_code, 200)
        self.assertEqual(client.get("/newhorizons/api/devices").status_code, 200)
        self.assertEqual(client.get("/newhorizons/api/visualization/latest").status_code, 200)
        self.assertEqual(client.get("/newhorizons/api/profiles").status_code, 200)

        self.assertEqual(client.get("/newhorizons/api/gateways").status_code, 403)
        self.assertEqual(client.get("/newhorizons/api/files?device_uid=3CDC7545CCD0").status_code, 403)
        self.assertEqual(client.get("/newhorizons/api/terminal/help").status_code, 403)
        self.assertEqual(
            client.post(
                "/newhorizons/api/device-command",
                json={"device_uid": "3CDC7545CCD0", "payload": {"command": "status"}},
            ).status_code,
            403,
        )

    def test_user_websocket_messages_cannot_subscribe_gateways_or_send_commands(self):
        service = NewHorizonsService(mock_mode=False)
        hub = WebSocketHub(service)
        client = _WsClient(hub, _FakeSocket(), AuthUser(username="user", role="user"))

        hub._handle_message(client, {"type": "subscribe_gateways"})
        gateway_error = client._queue.get_nowait()
        self.assertEqual(gateway_error["code"], "forbidden")

        hub._handle_message(
            client,
            {
                "type": "command",
                "device_uid": "3CDC7545CCD0",
                "payload": {"command": "status", "request_id": "req-1"},
            },
        )
        command_error = client._queue.get_nowait()
        self.assertEqual(command_error["code"], "forbidden")

    def test_admin_role_can_access_admin_routes(self):
        client, _, _ = self.create_client()
        login = client.post("/newhorizons/api/auth/login", json={"username": "admin", "password": "uoacnlab2026"})
        self.assertEqual(login.status_code, 200)

        self.assertEqual(client.get("/newhorizons/api/gateways").status_code, 200)
        self.assertEqual(client.get("/newhorizons/api/files?device_uid=3CDC7545CCD0").status_code, 200)

    def test_gateway_suggest_id_is_open_without_token_and_avoids_existing_gateways(self):
        client, _, app = self.create_client()
        service = app.config["NEWHORIZONS_SERVICE"]
        service.register_gateway("nh-gateway-existing", lambda _payload: None, {"gateway_name": "Existing"})

        response = client.post("/newhorizons/api/gateways/suggest-id")
        requested = client.post("/newhorizons/api/gateways/suggest-id", json={"gateway_id": "nh-gateway-existing"})

        self.assertEqual(response.status_code, 200)
        gateway_id = response.get_json()["gateway_id"]
        self.assertTrue(gateway_id.startswith("nh-gateway-"))
        self.assertNotEqual(gateway_id, "nh-gateway-existing")
        self.assertEqual(requested.status_code, 409)
        self.assertFalse(requested.get_json()["available"])

    def test_gateway_token_auth_is_disabled_by_default_for_gateway_api(self):
        client, _, _ = self.create_client()

        self.assertEqual(gateway_expected_token(), "")
        response = client.post("/newhorizons/api/gateways/suggest-id")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["gateway_id"].startswith("nh-gateway-"))

    def test_gateway_delete_is_admin_only_and_removes_registry_entry(self):
        client, _, app = self.create_client()
        service = app.config["NEWHORIZONS_SERVICE"]
        service.register_gateway("nh-gateway-existing", lambda _payload: None, {"gateway_name": "Existing"})

        user_login = client.post("/newhorizons/api/auth/login", json={"username": "user", "password": "nedo"})
        self.assertEqual(user_login.status_code, 200)
        self.assertEqual(client.delete("/newhorizons/api/gateways/nh-gateway-existing").status_code, 403)

        client.post("/newhorizons/api/auth/logout")
        admin_login = client.post("/newhorizons/api/auth/login", json={"username": "admin", "password": "admin"})
        self.assertEqual(admin_login.status_code, 200)
        deleted = client.delete("/newhorizons/api/gateways/nh-gateway-existing")

        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.get_json()["status"], "deleted")
        self.assertEqual(service.gateway_snapshot(), [])
        self.assertEqual(client.delete("/newhorizons/api/gateways/nh-gateway-existing").status_code, 404)

    def test_api_token_issues_bearer_token_for_stream_clients(self):
        client, db_path, app = self.create_client()
        manager = AuthManager(db_path)

        response = client.post("/newhorizons/api/token", json={"username": "admin", "password": "admin"})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["token_type"], "Bearer")
        self.assertGreater(payload["expires_in"], 0)
        self.assertEqual(
            manager.authenticate_token(payload["token"], str(app.secret_key or "")),
            AuthUser(username="admin", role="admin"),
        )

    def test_api_token_rejects_invalid_credentials(self):
        client, _, _ = self.create_client()

        response = client.post("/newhorizons/api/token", json={"username": "user", "password": "bad-password"})

        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
