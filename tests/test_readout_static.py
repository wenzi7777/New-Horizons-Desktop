"""Readout rendering: the safety property, and the wiring.

A readout is an installable package that renders in the operator's browser.
The property that has to hold is that it carries no code and can only read --
everything else here is presentation.
"""

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
BACKEND = ROOT / "backend" / "newhorizons_backend"


def read(relative: str) -> str:
    return (SRC / relative).read_text(encoding="utf-8")


class DeclarativeOnlyTests(unittest.TestCase):
    def test_the_renderer_never_evaluates_package_content(self):
        renderer = read("components/ReadoutView.tsx")
        lib = read("lib/readout.ts")
        # A package's fields index into results; they must never become code.
        for danger in ("eval(", "new Function", "dangerouslySetInnerHTML", "innerHTML"):
            with self.subTest(danger=danger):
                self.assertNotIn(danger, renderer)
                self.assertNotIn(danger, lib)

    def test_the_source_allowlist_is_enforced_in_the_browser_too(self):
        lib = read("lib/readout.ts")
        self.assertIn("READOUT_ALLOWED_SOURCES", lib)
        self.assertIn("readout_source_not_allowed", lib)
        # A refused readout must not render at all.
        renderer = read("components/ReadoutView.tsx")
        self.assertIn("readoutRejectionReason", renderer)
        self.assertIn('t("readoutRejected")', renderer)

    def test_the_allowlist_contains_no_mutating_command(self):
        lib = read("lib/readout.ts")
        block = lib[lib.index("READOUT_ALLOWED_SOURCES"):lib.index("export const MIN_REFRESH_MS")]
        for command in re.findall(r'"([a-z_]+)"', block):
            with self.subTest(command=command):
                self.assertFalse(command.startswith(("set_", "file_write", "file_delete")))
                self.assertNotIn(command, {"reboot", "app_install", "app_uninstall",
                                           "app_activate", "enter_maintenance"})

    def test_the_backend_gate_enforces_the_same_allowlist(self):
        source = (BACKEND / "app_library.py").read_text(encoding="utf-8")
        self.assertIn("READOUT_SOURCES", source)
        self.assertIn("readout_source_not_allowed", source)


class SourceOfTruthTests(unittest.TestCase):
    def test_a_readout_is_loaded_from_the_device_not_the_catalog(self):
        panel = read("components/DeviceAppsPanel.tsx")
        # The device is the source of truth for what it has; reading from there
        # also works for a sideloaded package or an unreachable library.
        self.assertIn("readDeviceFile(runner", panel)
        self.assertIn("apps/${entry.id}.nha", panel)

    def test_readouts_are_separated_from_flow_packages(self):
        panel = read("components/DeviceAppsPanel.tsx")
        # A readout holds no slot, so listing it among slot-bound packages
        # would invite someone to try activating it.
        self.assertIn('p.kind === "readout"', panel)
        self.assertIn('p.kind !== "readout"', panel)

    def test_the_package_kind_is_parsed(self):
        lib = read("lib/deviceApps.ts")
        self.assertIn('kind: str(entry.kind, "flow")', lib)


class PollingTests(unittest.TestCase):
    def test_passes_do_not_overlap(self):
        renderer = read("components/ReadoutView.tsx")
        # The device answers one command per connection; overlapping passes
        # would queue behind each other indefinitely.
        self.assertIn("inFlight", renderer)

    def test_one_request_per_distinct_command(self):
        renderer = read("components/ReadoutView.tsx")
        self.assertIn("byCommand", renderer)

    def test_the_interval_is_clamped(self):
        lib = read("lib/readout.ts")
        self.assertIn("MIN_REFRESH_MS", lib)
        self.assertIn("MAX_REFRESH_MS", lib)
        self.assertIn("Math.min(Math.max(raw, MIN_REFRESH_MS), MAX_REFRESH_MS)", lib)


class PublishedReadoutTests(unittest.TestCase):
    def test_the_shipped_readout_passes_the_desktop_gate(self):
        library = ROOT.parent / "NHOS-App-Library"
        package = library / "apps" / "sysmon" / "app.nha"
        if not package.exists():
            self.skipTest("NHOS-App-Library is not checked out beside this repo")
        import sys
        backend_root = str(ROOT / "backend")
        if backend_root not in sys.path:
            sys.path.insert(0, backend_root)
        from newhorizons_backend.app_library import validate_package

        report = validate_package(json.loads(package.read_text()))
        self.assertEqual(report["kind"], "readout")
        self.assertEqual(report["device_path"], "apps/sysmon.nha")


class TranslationTests(unittest.TestCase):
    def test_readout_keys_exist_in_all_three_languages(self):
        source = read("i18n.tsx")
        en_start = source.index("\n  en: {", source.index("const baseDictionaries"))
        ja_start = source.index("\n  ja: {", en_start)
        zh_start = source.index("const zhCnDictionary")
        merged = source.index("const dictionaries")
        key_re = re.compile(r"^\s{2,4}([A-Za-z_][A-Za-z0-9_]*)\s*:", re.MULTILINE)
        dictionaries = {
            "en": set(key_re.findall(source[en_start:ja_start])),
            "ja": set(key_re.findall(source[ja_start:zh_start])),
            "zh-CN": set(key_re.findall(source[zh_start:merged])),
        }
        used = set(re.findall(r't\("([A-Za-z0-9_]+)"\)', read("components/ReadoutView.tsx")))
        used |= {"installedReadouts", "appKindReadout", "readoutOpen", "appNoReadouts"}
        for locale, keys in dictionaries.items():
            with self.subTest(locale=locale):
                self.assertEqual(sorted(used - keys), [])


if __name__ == "__main__":
    unittest.main()
