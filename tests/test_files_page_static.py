import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FILES_PAGE = ROOT / "frontend" / "src" / "pages" / "FilesPage.tsx"
STYLES = ROOT / "frontend" / "src" / "styles.css"


class FilesPageStaticTest(unittest.TestCase):
    def test_csv_export_page_uses_finder_style_explorer_and_preview_workspace(self):
        source = FILES_PAGE.read_text(encoding="utf-8")
        styles = STYLES.read_text(encoding="utf-8")

        self.assertIn("formatFileSize", source)
        self.assertIn("loadingFiles", source)
        self.assertIn("api.csvDirectory(", source)
        self.assertIn("api.previewCsv(", source)
        self.assertIn("api.deleteCsvEntry(", source)
        self.assertIn('t("currentPath")', source)
        self.assertIn('t("parentFolder")', source)
        self.assertIn('t("preview")', source)
        self.assertIn('t("deleteFolderConfirm")', source)
        self.assertIn("csv-workspace", source)
        self.assertIn("csv-explorer-panel", source)
        self.assertIn("csv-preview-panel", source)
        self.assertIn("csv-breadcrumb", source)
        self.assertIn("csv-entry-row", source)
        self.assertIn("csv-preview-table", source)
        self.assertIn("csv-summary-grid", styles)
        self.assertIn("csv-explorer-layout", styles)
        self.assertIn("csv-entry-row", styles)
        self.assertIn("csv-preview-panel", styles)
        self.assertIn("csv-breadcrumb", styles)


if __name__ == "__main__":
    unittest.main()
