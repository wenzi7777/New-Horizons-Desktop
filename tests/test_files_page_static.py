import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FILES_PAGE = ROOT / "frontend" / "src" / "pages" / "FilesPage.tsx"
STYLES = ROOT / "frontend" / "src" / "styles.css"
API = ROOT / "backend" / "newhorizons_backend" / "api.py"


class FilesPageStaticTest(unittest.TestCase):
    def test_csv_export_page_is_a_finder_window(self):
        source = FILES_PAGE.read_text(encoding="utf-8")
        styles = STYLES.read_text(encoding="utf-8")

        self.assertIn("api.csvDirectory(", source)
        # The sidebar lists the devices with recordings on disk, not only
        # the ones connected right now.
        self.assertIn("api.csvDevices()", source)
        self.assertNotIn("api.devices()", source)
        self.assertIn("api.previewCsv(", source)
        self.assertIn("api.deleteCsvEntry(", source)
        # Sidebar of devices, sortable list view, preview pane, path bar.
        for name in ("finder-window", "finder-toolbar", "finder-sidebar", "finder-list-head", "finder-row", "finder-preview", "finder-pathbar", "finder-status"):
            self.assertIn(name, source)
            self.assertIn(f".{name}", styles)
        for column in ("name", "modified", "size", "kind"):
            self.assertIn(f'column="{column}"', source)

    def test_finder_navigation_and_selection(self):
        source = FILES_PAGE.read_text(encoding="utf-8")
        # Back/forward history, enclosing folder, double click opens.
        self.assertIn("function goBack()", source)
        self.assertIn("function goForward()", source)
        self.assertIn("function goUp()", source)
        self.assertIn("onDoubleClick={() => openEntry(entry)}", source)
        # Multiple selection: command toggles, shift extends, keyboard too.
        self.assertIn("event.metaKey || event.ctrlKey", source)
        self.assertIn("event.shiftKey && anchorPath", source)
        self.assertIn('aria-multiselectable="true"', source)
        self.assertIn("onKeyDown={handleListKey}", source)
        # Deleting asks first, in the app's own dialog.
        self.assertIn("<ConfirmModal", source)
        self.assertNotIn("window.confirm", source)

    def test_listing_reports_modification_time(self):
        self.assertIn('"modified_ms": int(', API.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
