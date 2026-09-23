"""Static checks on the device Apps page, the panel, and the shared transfer.

These pin the decisions that are invisible at runtime until they bite: one
upload implementation rather than two, an injected command runner rather than a
second pipeline to the same device, and a capability gate so a v1.0.0 device
degrades instead of failing.
"""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"


def read(relative: str) -> str:
    return (SRC / relative).read_text(encoding="utf-8")


class TransferReuseTests(unittest.TestCase):
    def test_the_upload_loop_lives_in_one_place(self):
        page = read("pages/DeviceFilesPage.tsx")
        # DeviceFilesPage must consume the shared helper, not keep its own copy.
        self.assertIn("writeDeviceFile(queue,", page)
        self.assertNotIn('command: "file_write_chunk"', page)

    def test_the_install_path_reuses_the_same_writer(self):
        lib = read("lib/deviceFileTransfer.ts")
        install = lib[lib.index("export async function installAppPackage"):]
        self.assertIn("writeDeviceFile(queue,", install)

    def test_the_path_cap_is_stated_once(self):
        lib = read("lib/deviceFileTransfer.ts")
        page = read("pages/DeviceFilesPage.tsx")
        self.assertIn("MAX_USER_PATH = 24", lib)
        self.assertIn("MAX_USER_PATH", page)
        self.assertNotIn("targetPath.length > 24", page)

    def test_the_optional_checksum_is_forwarded(self):
        lib = read("lib/deviceFileTransfer.ts")
        # The device deletes the file on a mismatch, so this is worth sending.
        self.assertIn("finishPayload.sha256 = sha256;", lib)


class PanelWiringTests(unittest.TestCase):
    def test_the_panel_takes_an_injected_runner(self):
        panel = read("components/DeviceAppsPanel.tsx")
        # DeviceSettingsPage holds a single-flight mutex; a second pipeline to
        # the same device would race it.
        self.assertNotIn("useDeviceCommand(", panel)
        self.assertIn("runner: CommandRunner", panel)

    def test_the_settings_page_shares_its_own_mutex_with_the_panel(self):
        page = read("pages/DeviceSettingsPage.tsx")
        self.assertIn("runner={(payload, timeoutMs) => run(", page)

    def test_killed_and_suspended_are_shown_differently(self):
        panel = read("components/DeviceAppsPanel.tsx")
        # A killed app needs an operator; a suspended one comes back by itself,
        # and telling the user otherwise would be a lie about their device.
        self.assertIn("needsRevive(app)", panel)
        self.assertIn('t("appSuspendedHint")', panel)
        self.assertIn('t("appKilledHint")', panel)

    def test_installing_an_installed_app_updates_it(self):
        page = read("pages/DeviceAppsPage.tsx")
        call = page[page.index("await installAppPackage(queue, {"):]
        call = call[:call.index("});")]
        # Without it, updating features 1.0.0 -> 1.1.0 failed with
        # already_installed after the new file had already been written.
        self.assertIn("replace: true,", call)

    def test_rolled_off_history_is_not_reported_as_loss(self):
        panel = read("components/DeviceAppsPanel.tsx")
        # The firmware's dropped counter is cumulative since boot, and a
        # one-shot read cannot lose anything: showing it as "lost" told the
        # operator hundreds of events were missing when none were.
        self.assertIn('t("appEventsRolledOff")', panel)
        self.assertNotIn("parsed.dropped", panel)
        self.assertIn("parsed.seq - parsed.events.length", panel)

    def test_newest_events_come_first(self):
        panel = read("components/DeviceAppsPanel.tsx")
        self.assertIn("sort((a, b) => b.seq - a.seq)", panel)

    def test_events_show_the_frame_they_belong_to(self):
        panel = read("components/DeviceAppsPanel.tsx")
        self.assertIn("event.frameSeq", panel)

    def test_degradation_is_visible(self):
        panel = read("components/DeviceAppsPanel.tsx")
        self.assertIn('t("appDegraded")', panel)


class CapabilityGateTests(unittest.TestCase):
    def test_the_registry_ui_is_hidden_on_older_firmware(self):
        page = read("pages/DeviceAppsPage.tsx")
        settings = read("pages/DeviceSettingsPage.tsx")
        for source in (page, settings):
            self.assertIn('compareVersions(', source)
            self.assertIn('"v1.1.0"', source)

    def test_maintenance_is_never_entered_silently(self):
        page = read("pages/DeviceAppsPage.tsx")
        # Entering maintenance stops the scan, which on a recording device is
        # not something to do behind the operator's back.
        self.assertIn('t("appInstallEnterMaintenance")', page)
        self.assertIn('reason: "app_install"', page)


class RoutingTests(unittest.TestCase):
    def test_the_device_apps_route_exists_and_is_admin_only(self):
        app = read("App.tsx")
        self.assertIn('path="/device/:deviceUid/apps"', app)
        block = app[app.index('path="/device/:deviceUid/apps"'):]
        self.assertIn('RequireRole roles={["admin"]}', block[:250])

    def test_the_store_can_send_you_to_a_device(self):
        store = read("pages/AppStorePage.tsx")
        self.assertIn("/apps?install=", store)


class TranslationParityTests(unittest.TestCase):
    def dictionaries(self) -> dict[str, set[str]]:
        source = read("i18n.tsx")
        en_start = source.index("\n  en: {", source.index("const baseDictionaries"))
        en_start = source.index("\n", en_start + 1)
        ja_start = source.index("\n  ja: {", en_start)
        zh_start = source.index("const zhCnDictionary")
        merged = source.index("const dictionaries")
        key_re = re.compile(r"^\s{2,4}([A-Za-z_][A-Za-z0-9_]*)\s*:", re.MULTILINE)
        return {
            "en": set(key_re.findall(source[en_start:ja_start])),
            "ja": set(key_re.findall(source[ja_start:zh_start])),
            "zh-CN": set(key_re.findall(source[zh_start:merged])),
        }

    def test_every_key_the_apps_ui_uses_exists_in_all_three_languages(self):
        used: set[str] = set()
        for name in ("components/DeviceAppsPanel.tsx", "pages/DeviceAppsPage.tsx"):
            source = read(name)
            used |= set(re.findall(r't\("([A-Za-z0-9_]+)"\)', source))
            # Template keys like t(`appState_${...}`) are expanded explicitly.
            for prefix in re.findall(r't\(`([A-Za-z0-9_]+)\$\{', source):
                if prefix == "appState_":
                    used |= {f"appState_{s}" for s in
                             ("running", "installed", "killed", "suspended", "faulted", "unknown")}
                elif prefix == "appInstallPhase_":
                    used |= {f"appInstallPhase_{s}" for s in
                             ("upload", "install", "activate", "done")}
        dictionaries = self.dictionaries()
        for locale, keys in dictionaries.items():
            missing = sorted(used - keys)
            with self.subTest(locale=locale):
                self.assertEqual(missing, [], f"{locale} is missing {missing}")

    def test_every_device_error_key_is_translated(self):
        lib = read("lib/deviceApps.ts")
        keys = set(re.findall(r'"(appError_[A-Za-z0-9_]+)"', lib))
        self.assertTrue(keys)
        for locale, have in self.dictionaries().items():
            with self.subTest(locale=locale):
                self.assertEqual(sorted(keys - have), [])


class RunnerIdentityTests(unittest.TestCase):
    """The injected runner must never drive an effect.

    DeviceSettingsPage passes an inline arrow, so the runner is a new function
    on every render. When refresh() depended on it, every command re-rendered
    the page, which re-created refresh(), which re-ran the effect -- the Apps
    tab cycled app_list / app_list_packages / app_events forever. ReadoutView's
    polling restarted the same way.
    """

    def callback_deps(self, source: str, name: str) -> str:
        start = source.index(f"const {name} = useCallback(")
        deps = re.search(r"\n  \}, \[([^\]]*)\]\);", source[start:])
        self.assertIsNotNone(deps, name)
        return deps.group(1)

    def test_panel_refresh_ignores_runner_identity(self):
        panel = read("components/DeviceAppsPanel.tsx")
        self.assertIn("runnerRef.current = runner;", panel)
        self.assertNotIn("runner", self.callback_deps(panel, "refresh"))
        self.assertNotIn("await runner(", panel)

    def test_readout_poll_ignores_runner_identity(self):
        view = read("components/ReadoutView.tsx")
        self.assertIn("runnerRef.current = runner;", view)
        self.assertNotIn("runner", self.callback_deps(view, "poll"))


if __name__ == "__main__":
    unittest.main()
