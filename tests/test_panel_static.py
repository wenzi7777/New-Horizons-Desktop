"""Panel apps: a readout that may also act on the device.

What has to hold: a panel can send only the commands its declared
permissions allow, never a forbidden one, with arguments that are constants
or a row/input field copied verbatim -- and every send goes through one lock,
so a Hub's one-command-per-device relay never sees two at once. The same
rules are enforced in the browser (lib/panel.ts) and the backend
(app_library.py); the tests below keep the two tables identical.
"""

import copy
import json
import re
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.app_library import (  # noqa: E402
    PANEL_FORBIDDEN_COMMANDS,
    PANEL_FORBIDDEN_PREFIXES,
    PANEL_PERMISSIONS,
    READOUT_SOURCES,
    AppPackageError,
    panel_command_allowed,
    validate_package,
)

# Vendored byte for byte from NHOS-App-Library apps/sysmon/panel.json.
EXAMPLE = SRC / "sdk" / "examples" / "sysmon.panel.json"
SDK_PANELSET = ROOT.parent / "NHOS-App-Library" / "sdk" / "lib" / "panelset.mjs"

# The readout tests' forbidden list (test_readout_static.py), which a panel
# must not reach through any permission.
NEVER = {"reboot", "reboot_wifi_setup", "app_install", "app_uninstall", "app_activate",
         "enter_maintenance", "file_delete", "file_write_begin", "file_write_chunk",
         "file_write_finish", "set_imu", "set_wifi", "config_set"}


def read(relative: str) -> str:
    return (SRC / relative).read_text(encoding="utf-8")


def ts_permissions() -> dict[str, tuple[str, ...]]:
    lib = read("lib/panel.ts")
    block = lib[lib.index("export const PANEL_PERMISSIONS"):lib.index("};", lib.index("export const PANEL_PERMISSIONS"))]
    table = {}
    for name, commands in re.findall(r"(\w+): \[([^\]]*)\]", block):
        table[name] = tuple(re.findall(r'"([a-z_]+)"', commands))
    return table


def example() -> dict:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


class PermissionTableTests(unittest.TestCase):
    def test_the_permission_table_matches_the_plan(self):
        self.assertEqual(PANEL_PERMISSIONS, {
            "task_control": ("task_stop", "task_start", "task_set_period"),
            "service_control": ("service_stop", "service_start", "service_restart"),
            "app_control": ("app_stop", "app_start", "app_revive"),
        })

    def test_browser_and_backend_share_one_table(self):
        self.assertEqual(ts_permissions(), PANEL_PERMISSIONS)

    @unittest.skipUnless(SDK_PANELSET.exists(), "NHOS-App-Library panelset.mjs not present")
    def test_the_sdk_table_names_the_same_commands(self):
        source = SDK_PANELSET.read_text(encoding="utf-8")
        for permission, commands in PANEL_PERMISSIONS.items():
            with self.subTest(permission=permission):
                self.assertIn(permission, source)
                for command in commands:
                    self.assertIn(command, source)

    def test_no_permission_reaches_a_forbidden_command(self):
        for permission, commands in PANEL_PERMISSIONS.items():
            for command in commands:
                with self.subTest(command=command):
                    self.assertFalse(command.startswith(("set_", "file_write", "file_delete", "reboot")))
                    self.assertNotIn(command, NEVER)
                    self.assertNotIn(command, PANEL_FORBIDDEN_COMMANDS)

    def test_forbidden_commands_stay_forbidden_whatever_is_declared(self):
        everything = list(PANEL_PERMISSIONS)
        for command in NEVER | {"set_scan_timing", "file_write_finish", "reboot", "app_enable"}:
            with self.subTest(command=command):
                self.assertFalse(panel_command_allowed(command, everything))

    def test_the_browser_forbids_the_same_things(self):
        lib = read("lib/panel.ts")
        for prefix in PANEL_FORBIDDEN_PREFIXES:
            self.assertIn(f'"{prefix}"', lib)
        for command in PANEL_FORBIDDEN_COMMANDS:
            self.assertIn(f'"{command}"', lib)

    def test_monitor_commands_are_read_only_sources_in_both_places(self):
        for command in ("sysmon", "thread_list"):
            self.assertIn(command, READOUT_SOURCES)
            self.assertIn(f'"{command}"', read("lib/readout.ts"))


class BackendGateTests(unittest.TestCase):
    def assertRejected(self, doc: dict, code: str):
        with self.assertRaises(AppPackageError) as ctx:
            validate_package(doc)
        self.assertEqual(str(ctx.exception), code)

    def test_the_example_panel_passes(self):
        report = validate_package(example())
        self.assertEqual(report["kind"], "panel")
        self.assertEqual(report["permissions"], ["task_control", "service_control", "app_control"])
        self.assertEqual(report["device_path"], "apps/sysmon.nha")

    def test_an_action_outside_the_declared_permissions_is_refused(self):
        doc = example()
        doc["manifest"]["permissions"] = ["task_control"]
        self.assertRejected(doc, "panel_action_not_permitted")

    def test_a_forbidden_command_is_refused(self):
        doc = example()
        doc["panel"]["actions"][0]["command"] = "set_imu"
        self.assertRejected(doc, "panel_action_not_permitted")

    def test_unknown_permissions_are_refused(self):
        doc = example()
        doc["manifest"]["permissions"].append("file_control")
        self.assertRejected(doc, "unknown_permission")

    def test_templates_are_constants_row_or_input_only(self):
        for bad in ("$row.name + 1", "${row.name}", "$env.HOME", "$row.", "$row.a.b", {"x": 1}, [1]):
            with self.subTest(template=bad):
                doc = example()
                doc["panel"]["actions"][0]["args"]["name"] = bad
                self.assertRejected(doc, "invalid_arg_template")

    def test_an_input_template_needs_a_declared_input(self):
        doc = example()
        doc["panel"]["actions"][0]["args"]["period_us"] = "$input.period_us"
        self.assertRejected(doc, "input_not_declared")

    def test_an_argument_cannot_name_another_command(self):
        doc = example()
        doc["panel"]["actions"][0]["args"]["command"] = "reboot"
        self.assertRejected(doc, "invalid_arg_name")

    def test_row_actions_and_run_reference_declared_actions(self):
        doc = example()
        doc["panel"]["sections"][1]["tabs"][1]["sections"][0]["row_actions"].append("reboot")
        self.assertRejected(doc, "unknown_action")
        doc = example()
        doc["panel"]["sections"][0]["candidates"][0]["action"] = "nope"
        self.assertRejected(doc, "unknown_action")

    def test_tabs_do_not_nest(self):
        doc = example()
        inner = copy.deepcopy(doc["panel"]["sections"][1])
        doc["panel"]["sections"][1]["tabs"][0]["sections"].append(inner)
        self.assertRejected(doc, "nested_tabs")

    def test_a_readout_cannot_act(self):
        doc = example()
        doc["kind"] = "readout"
        doc["readout"] = doc.pop("panel")
        doc["manifest"]["permissions"] = []
        self.assertRejected(doc, "readout_must_not_declare_actions")
        doc = example()
        doc["kind"] = "readout"
        doc["readout"] = {"sources": [{"id": "s", "command": "sysmon"}],
                          "sections": [{"kind": "stats", "title": "x", "items": []}]}
        del doc["panel"]
        self.assertRejected(doc, "permissions_need_a_panel")

    def test_panel_sources_are_still_read_only(self):
        doc = example()
        doc["panel"]["sources"][0]["command"] = "task_stop"
        self.assertRejected(doc, "readout_source_not_allowed")


class BrowserGateTests(unittest.TestCase):
    def test_the_template_grammar_is_the_same(self):
        lib = read("lib/panel.ts")
        self.assertIn(r"/^\$(row|input)\.([A-Za-z_][A-Za-z0-9_]*)$/", lib)
        backend = (BACKEND_ROOT / "newhorizons_backend" / "app_library.py").read_text(encoding="utf-8")
        self.assertIn(r'r"^\$(row|input)\.([A-Za-z_][A-Za-z0-9_]*)$"', backend)

    def test_the_view_never_evaluates_package_content(self):
        for path in ("components/PanelView.tsx", "lib/panel.ts"):
            source = read(path)
            for danger in ("eval(", "new Function", "dangerouslySetInnerHTML", "innerHTML"):
                with self.subTest(path=path, danger=danger):
                    self.assertNotIn(danger, source)

    def test_a_refused_panel_does_not_render(self):
        view = read("components/PanelView.tsx")
        self.assertIn("panelRejectionReason(pkg)", view)
        self.assertIn("if (rejection || !spec || !model)", view)

    def test_actions_missing_from_the_device_catalog_are_hidden(self):
        self.assertIn("supportedActions(spec.actions ?? [], supportedCommands)", read("components/PanelView.tsx"))
        apps = read("components/DeviceAppsPanel.tsx")
        self.assertIn("supportedCommands={deviceCommands}", apps)
        self.assertIn("api\n      .deviceCommands(deviceUid)", apps)

    def test_permissions_are_shown_on_open_and_install(self):
        self.assertIn("<PanelPermissionList permissions={openModel?.permissions ?? []} />",
                      read("components/DeviceAppsPanel.tsx"))
        self.assertIn("<PanelPermissionList permissions={app.permissions ?? []} />",
                      read("components/AppInstallDialog.tsx"))


class RunnerMutexTests(unittest.TestCase):
    def setUp(self):
        self.view = read("components/PanelView.tsx")

    def test_one_lock_for_polls_and_actions(self):
        self.assertEqual(self.view.count("createCommandLock()"), 1)
        # Polls skip while the lock is held; actions wait for it.
        self.assertIn("await lock.current.tryRun(async () => {", self.view)
        self.assertIn("await lock.current.run(() => runnerRef.current({ ...args, command: action.command }))", self.view)

    def test_every_device_call_is_inside_the_lock(self):
        calls = [m.start() for m in re.finditer(r"runnerRef\.current\(", self.view)]
        self.assertEqual(len(calls), 2)
        poll_start = self.view.index("await lock.current.tryRun(async () => {")
        poll_end = self.view.index("}, [spec, charts, rejection]);")
        self.assertTrue(poll_start < calls[0] < poll_end)
        self.assertIn("lock.current.run(() => runnerRef.current(", self.view[calls[1] - 40:calls[1] + 20])

    def test_an_action_re_polls_once_done(self):
        execute = self.view[self.view.index("const execute = useCallback("):self.view.index("const request = useCallback(")]
        self.assertIn("await poll();", execute)

    def test_every_action_is_confirmed(self):
        # execute() is reached only from the ConfirmModal.
        self.assertEqual(len(re.findall(r"void execute\(", self.view)), 1)
        confirm = self.view[self.view.index("<ConfirmModal"):]
        self.assertIn("void execute(pending);", confirm)
        self.assertIn("destructive={Boolean(confirming.action.confirm?.destructive)}", confirm)

    def test_the_lock_skips_and_waits(self):
        lib = read("lib/panel.ts")
        lock = lib[lib.index("export function createCommandLock"):]
        self.assertIn("if (current) return null;", lock)
        self.assertIn("while (current) await current.catch(() => undefined);", lock)


class TranslationTests(unittest.TestCase):
    def dictionaries(self):
        source = read("i18n.tsx")
        en_start = source.index("\n  en: {", source.index("const baseDictionaries"))
        ja_start = source.index("\n  ja: {", en_start)
        zh_start = source.index("const zhCnDictionary")
        merged = source.index("const dictionaries")
        key_re = re.compile(r"^\s{2,4}([A-Za-z_][A-Za-z0-9_]*)\s*:", re.MULTILINE)
        return {
            "en": set(key_re.findall(source[en_start:ja_start])),
            "ja": set(key_re.findall(source[ja_start:zh_start])),
            "zh-CN": set(key_re.findall(source[zh_start:merged])),
        }

    def test_panel_keys_exist_in_all_three_languages(self):
        view = read("components/PanelView.tsx")
        used = set(re.findall(r't\("([A-Za-z0-9_]+)"\)', view))
        lib = read("lib/panel.ts")
        # parseInput's error keys and the device error codes.
        used |= set(re.findall(r'error: "(panel[A-Za-z]+)"', lib))
        block = lib[lib.index("export const PANEL_ERROR_CODES"):lib.index("] as const;", lib.index("export const PANEL_ERROR_CODES"))]
        used |= {f"panelError_{code}" for code in re.findall(r'"([a-z_]+)"', block)}
        used |= {f"panelPermission_{name}" for name in PANEL_PERMISSIONS}
        used |= {"appKindPanel", "panelErrorUnknown"}
        for command in ("Sysmon", "ThreadList", "TaskStop", "TaskStart", "TaskSetPeriod",
                        "ServiceStop", "ServiceStart", "AppStop", "AppStart"):
            used.add(f"terminalHelp{command}")
        used |= {"paramTaskName", "paramPeriodUs"}
        for locale, keys in self.dictionaries().items():
            with self.subTest(locale=locale):
                self.assertEqual(sorted(used - keys), [])

    def test_the_firmware_error_codes_are_translated(self):
        lib = read("lib/panel.ts")
        # Every code firmware v1.19.0's task-manager commands answer with.
        for code in ("task_protected", "period_fixed", "period_out_of_range", "period_required",
                     "already_stopped", "already_running", "unknown_task", "service_protected",
                     "service_not_restartable", "service_start_failed", "unknown_service",
                     "unknown_app", "app_not_running", "app_not_stopped", "app_start_failed"):
            self.assertIn(f'"{code}"', lib)


if __name__ == "__main__":
    unittest.main()
