"""Static checks on the App Store page wiring and translation parity.

The i18n parity check is the one that earns its keep: the zh-CN dictionary is a
standalone object rather than a spread over `en`, so a key added to two
dictionaries and forgotten in the third fails silently at runtime.
"""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"


def read(relative: str) -> str:
    return (SRC / relative).read_text(encoding="utf-8")


class RoutingTests(unittest.TestCase):
    def test_the_store_is_reachable_from_the_nav_and_the_router(self):
        app = read("App.tsx")
        self.assertIn('{ to: "/apps", labelKey: "navApps"', app)
        self.assertIn('path="/apps"', app)
        self.assertIn('path="/apps/:appId"', app)
        self.assertIn("<AppStorePage />", app)

    def test_the_store_is_admin_only(self):
        app = read("App.tsx")
        # Check each route's own element rather than counting over a span, so
        # inserting a route between them does not break the assertion.
        for path in ('path="/apps"', 'path="/apps/:appId"'):
            with self.subTest(path=path):
                element = app[app.index(path):]
                self.assertIn('RequireRole roles={["admin"]}', element[:220])


class PageWiringTests(unittest.TestCase):
    def test_the_page_uses_the_catalog_api(self):
        page = read("pages/AppStorePage.tsx")
        self.assertIn("api.appLibraryIndex(", page)

    def test_a_stale_catalog_is_surfaced_rather_than_hidden(self):
        # Falling back to a cached catalog silently would misrepresent the
        # library as up to date.
        page = read("pages/AppStorePage.tsx")
        self.assertIn('t("appLibraryStale")', page)

    def test_notice_classes_match_the_stylesheet(self):
        page = read("pages/AppStorePage.tsx")
        self.assertNotIn("notice-error", page)
        self.assertNotIn("notice-warning", page)

    def test_the_styles_the_page_asks_for_exist(self):
        css = read("styles.css")
        for selector in (".app-card-grid", ".app-card", ".app-detail-facts",
                         ".app-store-filters", ".app-card-icon-fallback"):
            with self.subTest(selector=selector):
                self.assertIn(selector, css)


class TranslationParityTests(unittest.TestCase):
    def dictionaries(self) -> dict[str, set[str]]:
        source = read("i18n.tsx")
        # en and ja live in baseDictionaries; zh-CN is a separate object.
        # Start inside the en object, not at the declaration, so the block
        # headers (`en: {`, `ja: {`) are not mistaken for translation keys.
        en_start = source.index("\n  en: {", source.index("const baseDictionaries"))
        en_start = source.index("\n", en_start + 1)
        ja_start = source.index("\n  ja: {", en_start)
        zh_start = source.index("const zhCnDictionary")
        merged = source.index("const dictionaries")
        key_re = re.compile(r"^\s{2,4}([A-Za-z_][A-Za-z0-9_]*)\s*:", re.MULTILINE)
        dictionaries = {
            "en": set(key_re.findall(source[en_start:ja_start])),
            "ja": set(key_re.findall(source[ja_start:zh_start])),
            "zh-CN": set(key_re.findall(source[zh_start:merged])),
        }
        assert len(dictionaries["en"]) > 100, "the en slice did not find the dictionary"
        return dictionaries

    def test_every_app_key_used_by_the_page_exists_in_all_three_languages(self):
        page = read("pages/AppStorePage.tsx")
        used = set(re.findall(r't\("([A-Za-z0-9_]+)"\)', page))
        self.assertTrue(used, "the page should use translated strings")
        dictionaries = self.dictionaries()
        for locale, keys in dictionaries.items():
            missing = sorted(used - keys)
            with self.subTest(locale=locale):
                self.assertEqual(missing, [], f"{locale} is missing {missing}")

    def test_all_three_dictionaries_carry_the_same_keys(self):
        dictionaries = self.dictionaries()
        for locale in ("ja", "zh-CN"):
            with self.subTest(locale=locale):
                self.assertEqual(sorted(dictionaries["en"] - dictionaries[locale]), [],
                                 f"{locale} is missing keys that en has")

    def test_the_new_app_keys_are_translated_everywhere(self):
        dictionaries = self.dictionaries()
        expected = {"navApps", "appStoreTitle", "appStoreSubtitle", "appLibraryRefresh",
                    "appLibraryStale", "appLibraryError", "appMinOs", "appCapabilities"}
        for locale, keys in dictionaries.items():
            with self.subTest(locale=locale):
                self.assertEqual(sorted(expected - keys), [])


if __name__ == "__main__":
    unittest.main()
