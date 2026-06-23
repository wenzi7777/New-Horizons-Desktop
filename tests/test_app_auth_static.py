import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "frontend" / "src" / "App.tsx"
MAIN = ROOT / "frontend" / "src" / "main.tsx"
AUTH = ROOT / "frontend" / "src" / "lib" / "auth.tsx"
RUNTIME = ROOT / "frontend" / "src" / "lib" / "runtime.ts"
API = ROOT / "frontend" / "src" / "lib" / "api.ts"
WS_CLIENT = ROOT / "frontend" / "src" / "lib" / "wsClient.ts"
LAUNCHPAD = ROOT / "frontend" / "src" / "pages" / "LaunchpadPage.tsx"


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

    def test_app_and_launchpad_expose_device_wiki_navigation(self):
        app_source = APP.read_text(encoding="utf-8")
        api_source = API.read_text(encoding="utf-8")
        launchpad_source = LAUNCHPAD.read_text(encoding="utf-8")
        i18n_source = (ROOT / "frontend" / "src" / "i18n.tsx").read_text(encoding="utf-8")

        self.assertIn('path="/wiki"', app_source)
        self.assertIn('path="/device/:deviceUid/wiki"', app_source)
        self.assertIn("wikiDevices", api_source)
        self.assertIn("wikiDocument", api_source)
        self.assertIn('/device/${encodeURIComponent(device.uid)}/wiki', launchpad_source)
        self.assertIn("deviceWiki", i18n_source)
        self.assertIn("navWiki", i18n_source)

    def test_launchpad_groups_devices_into_default_and_custom_folders(self):
        launchpad_source = LAUNCHPAD.read_text(encoding="utf-8")
        api_source = API.read_text(encoding="utf-8")
        i18n_source = (ROOT / "frontend" / "src" / "i18n.tsx").read_text(encoding="utf-8")

        self.assertIn("device_group?: string", api_source)
        self.assertIn("activeFolder", launchpad_source)
        self.assertIn("deviceGroupOnline", launchpad_source)
        self.assertIn("deviceGroupOffline", launchpad_source)
        self.assertIn("folder-grid", launchpad_source)
        self.assertIn("folder-preview-grid", launchpad_source)
        self.assertIn("folder-overlay", launchpad_source)
        self.assertIn("folder-preview-card", launchpad_source)
        self.assertIn("folder-preview-empty", launchpad_source)
        self.assertIn("folder-count-badge", launchpad_source)
        self.assertIn("folder-device-chip placeholder", launchpad_source)
        self.assertIn("disabled={folder.devices.length === 0}", launchpad_source)
        self.assertIn("launchpad-apps", launchpad_source)
        self.assertIn("deviceMacSuffix", launchpad_source)
        self.assertIn('uid.slice(-4).toUpperCase()', launchpad_source)
        self.assertIn("device-code-mark", launchpad_source)
        self.assertIn("device.device_group", launchpad_source)
        self.assertIn("deviceGroupOnline", i18n_source)
        self.assertIn("deviceGroupOffline", i18n_source)

    def test_frontend_api_supports_saving_device_group(self):
        api_source = API.read_text(encoding="utf-8")

        self.assertIn("saveDeviceGroup", api_source)
        self.assertIn("/devices/${encodeURIComponent(deviceUid)}/group", api_source)


if __name__ == "__main__":
    unittest.main()
