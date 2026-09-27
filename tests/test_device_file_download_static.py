"""The Files page's download loop must stop on a failed or stalled chunk.

It checked neither: a failed chunk has no data and no next_offset, so the
offset never moved and has_more defaulted to "offset < size" -- the same
chunk was re-sent 8-10 times a second, each failure flashing the device's LED
red, until the tab was closed. readDeviceFile's behaviour is tested for real in
frontend/tests/deviceFileRead.test.mjs; this pins the page's own copy.
"""

import unittest
from pathlib import Path


PAGE = Path(__file__).resolve().parents[1] / "frontend" / "src" / "pages" / "DeviceFilesPage.tsx"


class DownloadLoopTests(unittest.TestCase):
    def setUp(self):
        page = PAGE.read_text(encoding="utf-8")
        self.page = page
        self.loop = page[page.index("async function downloadFileBytes(") : page.index("async function downloadFile(")]

    def test_a_failed_chunk_is_retried_once_then_raised(self):
        self.assertIn("const failure = readFailure(chunk.result);", self.loop)
        self.assertIn("if (retried) throw new Error(failure);", self.loop)
        # The retry re-reads the size; a file that changed is not spliced.
        self.assertIn('throw new Error("file_changed")', self.loop)

    def test_a_chunk_that_does_not_advance_is_raised(self):
        self.assertIn("ensureReadAdvanced(offset, nextOffset, hasMore);", self.loop)

    def test_the_begin_reply_is_checked(self):
        self.assertIn("ensureReadOk(begin.result);", self.loop)

    def test_a_failed_download_is_reported_not_dropped(self):
        download = self.page[self.page.index("async function downloadFile(") : self.page.index("async function deleteFile(")]
        self.assertIn("} catch (error) {", download)
        self.assertIn('t("downloadFailed")', download)
        self.assertIn("setDownloadProgress(null);", download)


if __name__ == "__main__":
    unittest.main()
