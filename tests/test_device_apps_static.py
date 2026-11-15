"""Static checks on the device Apps section, its parts, and the shared transfer.

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


SECTION = "components/deviceApps/DeviceAppsSection.tsx"
CARD = "components/deviceApps/RunningAppCard.tsx"
SHEET = "components/deviceApps/AppDetailSheet.tsx"
ROW = "components/deviceApps/InstalledAppRow.tsx"
APPS_UI = (SECTION, CARD, SHEET, ROW,
           "components/deviceApps/AppResourceBar.tsx", "components/deviceApps/AppParts.tsx")


class PanelWiringTests(unittest.TestCase):
    def test_the_section_takes_an_injected_runner(self):
        section = read(SECTION)
        # DeviceSettingsPage holds a single-flight mutex; a second pipeline to
        # the same device would race it.
        for name in APPS_UI:
            self.assertNotIn("useDeviceCommand(", read(name), name)
            self.assertNotIn("sendDeviceCommand(", read(name), name)
        self.assertIn("runner: CommandRunner", section)

    def test_the_settings_page_shares_its_own_mutex_with_the_section(self):
        page = read("pages/DeviceSettingsPage.tsx")
        flat = re.sub(r"\s+", " ", page)
        self.assertIn("<DeviceAppsSection", page)
        self.assertIn("runner={(payload, timeoutMs) => run(", flat)
        # The live view holds the same mutex between polls, so an operator's
        # click must wait it out rather than be silently skipped.
        self.assertRegex(flat, r"runner=\{\(payload, timeoutMs\) => run\([^}]*\{ waitForLock: true \}")
        self.assertRegex(flat, r"poll=\{\(payload, timeoutMs\) => run\([^}]*\{ background: true \}")

    def test_a_background_run_neither_logs_nor_marks_the_page_busy(self):
        page = read("pages/DeviceSettingsPage.tsx")
        body = page[page.index("if (options.background) {"):]
        body = body[:body.index("setBusyCommand(command);")]
        self.assertIn("pollDeviceCommand(", body)
        self.assertNotIn("pushOperationLog", body)
        self.assertIn("commandInFlightRef.current = false", body)

    def test_the_live_view_polls_only_through_the_background_runner(self):
        section = read(SECTION)
        live = section[section.index("// --- the live view"):section.index("// --- actions ---")]
        self.assertIn('pollNow({ command: "app_view" }', live)
        self.assertNotIn("runnerRef.current(", live)
        # Paused while the operator's own command is in flight, and when hidden.
        self.assertIn("!pausedRef.current", live)
        self.assertIn('document.visibilityState === "visible"', live)

    def test_the_shared_indicator_views_do_not_pull_in_the_sdk(self):
        views = read("components/sdk/IndicatorViews.tsx")
        # The Apps section is in the main bundle; a value import from the SDK
        # index drags the simulator and compiler in with it.
        imports = [line for line in views.splitlines() if "sdk/lib" in line]
        self.assertTrue(imports)
        self.assertTrue(all(line.startswith("import type") for line in imports))

    def test_installed_packages_show_the_catalog_translation(self):
        section = read(SECTION)
        # A package manifest holds one English name; the catalog has every
        # locale, looked up by id, with the device's own text as the fallback.
        self.assertIn("api\n      .appLibraryIndex()", section)
        self.assertIn("name: localise(known.name) || app.name", section)
        self.assertIn("summary: localise(known.summary) || app.summary", section)

    def test_killed_and_suspended_are_shown_differently(self):
        card = read(CARD)
        sheet = read(SHEET)
        # A killed app needs an operator; a suspended one comes back by itself,
        # and telling the user otherwise would be a lie about their device.
        self.assertIn('if (runtime.state === "suspended") return "suspended";', card)
        self.assertIn('if (runtime.state === "killed") return "killed";', card)
        self.assertIn('state === "killed" ? (', sheet)
        self.assertIn('t("appRevive")', sheet)

    def test_installing_an_installed_app_updates_it(self):
        page = read("components/AppInstallDialog.tsx")
        call = page[page.index("await installAppPackage(queue, {"):]
        call = call[:call.index("});")]
        # Without it, updating features 1.0.0 -> 1.1.0 failed with
        # already_installed after the new file had already been written.
        self.assertIn("replace: true,", call)

    def test_an_idle_app_is_not_shown_as_running(self):
        card = read(CARD)
        lib = read("lib/deviceApps.ts")
        # After uninstalling every package all four slots still said Running:
        # on, but with nothing to run.
        self.assertIn('if (runtime.state === "running") return runtime.idle ? "faulted" : "running";', card)
        self.assertIn("entry.idle !== undefined ? entry.idle === true", lib)
        self.assertIn("num(detail.nodes) === 0", lib)

    def test_the_cumulative_dropped_counter_is_not_shown_as_loss(self):
        # The firmware's dropped counter is cumulative since boot, and a
        # one-shot read cannot lose anything.
        for name in APPS_UI:
            self.assertNotIn("parsed.dropped", read(name), name)

    def test_newest_events_come_first_and_only_the_open_apps(self):
        section = read(SECTION)
        self.assertIn("sort((a, b) => b.seq - a.seq)", section)
        self.assertIn("filter((event) => event.app === sheetName)", section)

    def test_events_show_the_frame_they_belong_to(self):
        self.assertIn("event.frameSeq", read(SHEET))

    def test_degradation_is_visible(self):
        self.assertIn('t("appDegraded")', read(CARD))

    def test_there_are_no_slots_in_the_ui(self):
        for name in APPS_UI:
            source = read(name)
            self.assertNotRegex(source, r"\bslot\b", name)
            self.assertNotIn("freeSlots", source, name)


class CapabilityGateTests(unittest.TestCase):
    def test_the_registry_ui_is_hidden_on_older_firmware(self):
        settings = read("pages/DeviceSettingsPage.tsx")
        # Cores only: a beta of v1.1.0 has what v1.1.0 has.
        self.assertIn('compareVersionCores(', settings)
        self.assertIn('"v1.1.0"', settings)
        self.assertIn('t("appRegistryUnsupported")', read(SECTION))

    def test_maintenance_is_entered_openly_and_left_only_if_entered(self):
        section = read(SECTION)
        lib = read("lib/deviceCommand.ts")
        dialog = read("components/AppInstallDialog.tsx")
        # Switching an app needs maintenance mode, which pauses the scan: the
        # section says so up front, asks first while recording, and leaves
        # maintenance only when it entered it itself.
        self.assertIn('t("appsScanPauseNote")', section)
        self.assertIn("if (recording && !inMaintenance) setConfirm({ kind: \"toggle\", app });", section)
        self.assertIn('t("appsRecordingConfirm")', section)
        self.assertIn("withMaintenance(runnerRef.current, inMaintenance,", section)
        helper = lib[lib.index("export async function withMaintenance"):]
        helper = helper[:helper.index("\n}\n")]
        self.assertIn("if (alreadyInMaintenance) return work();", helper)
        self.assertIn("finally", helper)
        # Pausing and resuming do not need maintenance.
        self.assertIn('send({ command: "app_stop", name: runtimeName(sheetApp) })', section)
        self.assertIn('t("appInstallMaintenanceNote")', dialog)
        self.assertEqual(dialog.count("void install()"), 1)
        self.assertIn("if (entered)", dialog)


class RoutingTests(unittest.TestCase):
    def test_the_old_device_apps_route_lands_on_the_settings_section(self):
        app = read("App.tsx")
        self.assertIn('path="/device/:deviceUid/apps"', app)
        self.assertIn("element={<DeviceAppsRedirect />}", app)
        self.assertIn("/settings?section=apps", app)
        self.assertFalse((SRC / "pages" / "DeviceAppsPage.tsx").exists())
        settings = read("pages/DeviceSettingsPage.tsx")
        self.assertIn('searchParams.get("section") === "apps"', settings)

    def test_the_store_can_send_you_to_a_device(self):
        store = read("pages/AppStorePage.tsx")
        dialog = read("components/AppInstallDialog.tsx")
        self.assertIn("<AppInstallDialog", store)
        self.assertIn("/settings?section=apps", dialog)
        self.assertIn('to="/apps"', read(SECTION))


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
        for name in (*APPS_UI, "components/AppInstallDialog.tsx"):
            source = read(name)
            used |= set(re.findall(r't\("([A-Za-z0-9_]+)"\)', source))
            # t(cond ? "a" : "b") picks between two keys.
            for _, first, second in re.findall(r't\(([^()]*?)\? "([A-Za-z0-9_]+)" : "([A-Za-z0-9_]+)"\)', source):
                used |= {first, second}
            # Template keys like t(`appState_${...}`) are expanded explicitly.
            for prefix in re.findall(r't\(`([A-Za-z0-9_]+)\$\{', source):
                if prefix in ("appsState_", "appsHint_"):
                    used |= {f"{prefix}{s}" for s in
                             ("running", "stopped", "suspended", "killed", "faulted")}
                elif prefix == "appsLevel_":
                    used |= {f"appsLevel_{s}" for s in ("low", "medium", "high", "overloaded")}
                elif prefix == "appState_":
                    used |= {f"appState_{s}" for s in
                             ("running", "installed", "killed", "suspended", "faulted", "unknown")}
                elif prefix == "appInstallStep_":
                    used |= {f"appInstallStep_{s}" for s in
                             ("maintenance", "upload", "install", "restore")}
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

    def test_section_refresh_ignores_runner_identity(self):
        section = read(SECTION)
        self.assertIn("runnerRef.current = runner;", section)
        self.assertNotIn("runner", self.callback_deps(section, "refresh"))
        self.assertNotIn("await runner(", section)

    def test_readout_poll_ignores_runner_identity(self):
        # Readouts and panels poll through PanelView.
        view = read("components/PanelView.tsx")
        self.assertIn("runnerRef.current = runner;", view)
        self.assertNotIn("runner", self.callback_deps(view, "poll"))


if __name__ == "__main__":
    unittest.main()
