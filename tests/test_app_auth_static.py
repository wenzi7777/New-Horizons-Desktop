import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "frontend" / "src" / "App.tsx"
MAIN = ROOT / "frontend" / "src" / "main.tsx"
AUTH = ROOT / "frontend" / "src" / "lib" / "auth.tsx"
RUNTIME = ROOT / "frontend" / "src" / "lib" / "runtime.ts"
API = ROOT / "frontend" / "src" / "lib" / "api.ts"
WS_CLIENT = ROOT / "frontend" / "src" / "lib" / "wsClient.ts"


class AppAuthStaticTest(unittest.TestCase):
    def test_app_bootstraps_auth_and_user_redirects_to_visualization(self):
        app_source = APP.read_text(encoding="utf-8")
        main_source = MAIN.read_text(encoding="utf-8")
        auth_source = AUTH.read_text(encoding="utf-8")

        self.assertIn('path="/login"', app_source)
        self.assertIn('Navigate to="/visualization" replace', app_source)
        self.assertIn("RequireRole", app_source)
        self.assertIn("AuthProvider", main_source)
        self.assertIn("api.authMe()", auth_source)
        self.assertIn("api.login(", auth_source)
        self.assertIn("api.logout()", auth_source)

    def test_frontend_uses_shared_base_path_for_router_api_and_ws(self):
        main_source = MAIN.read_text(encoding="utf-8")
        runtime_source = RUNTIME.read_text(encoding="utf-8")
        api_source = API.read_text(encoding="utf-8")
        ws_source = WS_CLIENT.read_text(encoding="utf-8")

        self.assertIn("APP_BASE_PATH", main_source)
        self.assertIn("appHref", runtime_source)
        self.assertIn("wsHref", runtime_source)
        self.assertIn("const API_BASE = appHref(\"api\")", api_source)
        self.assertIn("return wsHref(\"ws\")", ws_source)

    def test_login_page_removes_app_subtitle_and_shows_contact_admin_copy(self):
        login_source = (ROOT / "frontend" / "src" / "pages" / "LoginPage.tsx").read_text(encoding="utf-8")
        i18n_source = (ROOT / "frontend" / "src" / "i18n.tsx").read_text(encoding="utf-8")

        self.assertNotIn("appSubtitle", login_source)
        self.assertIn("loginContactAdmin", login_source)
        self.assertIn('loginContactAdmin: "Contact the administrator to obtain an account."', i18n_source)
        self.assertIn('loginContactAdmin: "アカウントの発行は管理者へお問い合わせください。"', i18n_source)

    def test_gateways_page_supports_gateway_delete_action(self):
        gateways_source = (ROOT / "frontend" / "src" / "pages" / "GatewaysPage.tsx").read_text(encoding="utf-8")
        api_source = API.read_text(encoding="utf-8")
        i18n_source = (ROOT / "frontend" / "src" / "i18n.tsx").read_text(encoding="utf-8")

        self.assertIn("api.deleteGateway(", gateways_source)
        self.assertIn("deleteGatewayConfirm", gateways_source)
        self.assertIn("deleteGateway", i18n_source)
        self.assertIn("gatewayDeleted", i18n_source)
        self.assertIn("gatewayDeleteFailed", i18n_source)
        self.assertIn("deleteGateway: (gatewayId: string)", api_source)


if __name__ == "__main__":
    unittest.main()
