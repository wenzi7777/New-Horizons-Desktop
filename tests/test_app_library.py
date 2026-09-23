"""App Library client: catalog caching, integrity and the package defence gate.

The validation here overlaps the library repository's own CI on purpose. CI is
the authoring gate -- it tells an author their app is wrong. This is the defence
gate: nothing malformed reaches a device even if the catalog is hand-edited,
stale, or served by something other than the library.
"""

import hashlib
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.app_library import (  # noqa: E402
    AppLibrary,
    AppLibraryError,
    AppPackageError,
    canonical_bytes,
    validate_package,
)


GOOD_PACKAGE = {
    "nhapp": 1,
    "kind": "flow",
    "name": "demo",
    "manifest": {
        "id": "demo", "name": "Demo", "version": "1.0.0", "author": "wenzi7777",
        "summary": "fixture", "min_os": "v1.0.0",
        "capabilities": ["read_matrix", "emit_event"],
    },
    "nodes": [
        {"op": "total"},
        {"op": "threshold", "in": 0, "value": 10.0},
        {"op": "emit", "in": 1, "event": "hit"},
    ],
}


def package_bytes(overrides: dict | None = None) -> bytes:
    doc = json.loads(json.dumps(GOOD_PACKAGE))
    if overrides:
        doc.update(overrides)
    return canonical_bytes(doc)


def make_index(raw: bytes, url: str = "https://raw.githubusercontent.com/x/y/main/d.nha") -> dict:
    return {
        "schema": 1,
        "generated_at": "2026-09-22T00:00:00Z",
        "apps": [{
            "id": "demo",
            "name": {"en": "Demo"},
            "summary": {"en": "fixture"},
            "version": "1.0.0",
            "author": "wenzi7777",
            "min_os": "v1.0.0",
            "device_path": "apps/demo.nha",
            "package": {"url": url, "sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw)},
        }],
    }


class FakeResponse:
    def __init__(self, body: bytes, etag: str | None = None):
        self._body = body
        self.headers = {"ETag": etag} if etag else {}

    def read(self, *_args):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class LibraryTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.lib = AppLibrary(self.root, index_url="https://raw.githubusercontent.com/x/y/main/index.json")


class PackageValidationTests(unittest.TestCase):
    def assertRejects(self, doc, code):
        with self.assertRaises(AppPackageError) as ctx:
            validate_package(doc)
        self.assertEqual(str(ctx.exception), code)

    def test_a_good_package_passes(self):
        summary = validate_package(GOOD_PACKAGE)
        self.assertEqual(summary["id"], "demo")
        self.assertEqual(summary["device_path"], "apps/demo.nha")

    def test_ids_are_capped_at_the_spiffs_path_limit(self):
        doc = json.loads(json.dumps(GOOD_PACKAGE))
        doc["manifest"]["id"] = "a" * 16
        self.assertRejects(doc, "invalid_id")

    def test_ids_must_be_lowercase_identifiers(self):
        doc = json.loads(json.dumps(GOOD_PACKAGE))
        doc["manifest"]["id"] = "Demo-App"
        self.assertRejects(doc, "invalid_id")

    def test_too_many_nodes(self):
        doc = json.loads(json.dumps(GOOD_PACKAGE))
        doc["nodes"] = [{"op": "total"}] * 25
        self.assertRejects(doc, "too_many_nodes")

    def test_a_24_node_graph_is_accepted(self):
        # Firmware v1.3.0 holds 24 nodes per graph.
        doc = json.loads(json.dumps(GOOD_PACKAGE))
        doc["manifest"]["min_os"] = "v1.3.0"
        doc["nodes"] = [{"op": "total"}] * 22 + [
            {"op": "threshold", "in": 0, "value": 10.0},
            {"op": "emit", "in": 22, "event": "hit"},
        ]
        self.assertEqual(validate_package(doc)["nodes"], 24)

    def test_an_oled_and_button_package_is_accepted(self):
        # Firmware v1.4.0: show/bar/button()/% compile to these, and declare
        # display and button. Refusing them here would stop every such app at
        # install, with a code that says nothing about why.
        doc = json.loads(json.dumps(GOOD_PACKAGE))
        doc["manifest"].update(min_os="v1.4.0", capabilities=["button", "display", "read_matrix"])
        doc["nodes"] = [
            {"op": "button"},
            {"op": "counter", "in": 0},
            {"op": "const", "value": 2.0},
            {"op": "mod", "in": [1, 2]},
            {"op": "oled_text", "in": 3, "row": 0, "label": "page"},
            {"op": "oled_bar", "in": 3, "row": 1, "label": "p", "lo": 0.0, "hi": 1.0},
        ]
        self.assertEqual(validate_package(doc)["nodes"], 6)

    def test_every_op_and_capability_the_sdk_knows_is_known_here(self):
        # The vendored SDK is what App Studio compiles with; an op it can emit
        # that this module does not know is an app the Desktop builds and then
        # refuses to install.
        from newhorizons_backend.app_library import CAPABILITIES, KNOWN_OPS
        import re
        opset = (ROOT / "frontend" / "src" / "sdk" / "lib" / "opset.mjs").read_text(encoding="utf-8")
        sdk_ops = set(re.findall(r'^\s*op\("([a-z_0-9]+)"', opset, re.M))
        self.assertTrue(sdk_ops)
        self.assertEqual(sdk_ops, KNOWN_OPS)
        block = re.search(r"export const CAPABILITIES = Object\.freeze\(\{(.*?)\}\);", opset, re.S)
        sdk_caps = set(re.findall(r"^\s*([a-z_]+):", block.group(1), re.M))
        self.assertEqual(sdk_caps, CAPABILITIES)

    def test_unknown_op(self):
        doc = json.loads(json.dumps(GOOD_PACKAGE))
        doc["nodes"] = [{"op": "rm_rf"}]
        self.assertRejects(doc, "unknown_op")

    def test_forward_references_are_refused(self):
        doc = json.loads(json.dumps(GOOD_PACKAGE))
        doc["nodes"] = [{"op": "threshold", "in": 1, "value": 1.0}, {"op": "total"}]
        self.assertRejects(doc, "input_out_of_order")

    def test_unsupported_kind_is_refused(self):
        # The discriminator exists so a future scripted runtime cannot be
        # mistaken for a flow graph by firmware that predates it.
        for kind in ("lua", "rules", "berry"):
            with self.subTest(kind=kind):
                doc = json.loads(json.dumps(GOOD_PACKAGE))
                doc["kind"] = kind
                self.assertRejects(doc, "unsupported_kind")

    def test_event_names_fit_the_firmware_buffer(self):
        doc = json.loads(json.dumps(GOOD_PACKAGE))
        doc["nodes"][2]["event"] = "e" * 24
        self.assertRejects(doc, "invalid_event_name")


class IntegrityTests(LibraryTestCase):
    def test_checksum_mismatch_is_refused(self):
        raw = package_bytes()
        index = make_index(raw)
        index["apps"][0]["package"]["sha256"] = "0" * 64
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = [
                FakeResponse(json.dumps(index).encode()),
                FakeResponse(raw),
            ]
            with self.assertRaises(AppPackageError) as ctx:
                self.lib.download_package("demo")
        self.assertEqual(str(ctx.exception), "checksum_mismatch")

    def test_size_mismatch_is_refused(self):
        raw = package_bytes()
        index = make_index(raw)
        index["apps"][0]["package"]["size"] = len(raw) + 1
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = [
                FakeResponse(json.dumps(index).encode()),
                FakeResponse(raw),
            ]
            with self.assertRaises(AppPackageError) as ctx:
                self.lib.download_package("demo")
        self.assertEqual(str(ctx.exception), "size_mismatch")

    def test_a_package_url_off_the_allowlist_is_refused(self):
        # package.url arrives inside a remote file, so it is attacker-influenced.
        raw = package_bytes()
        index = make_index(raw, url="https://evil.example.com/payload.nha")
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(json.dumps(index).encode())
            with self.assertRaises(AppLibraryError) as ctx:
                self.lib.download_package("demo")
        self.assertEqual(str(ctx.exception), "package_host_not_allowed")

    def test_plain_http_is_refused(self):
        raw = package_bytes()
        index = make_index(raw, url="http://raw.githubusercontent.com/x/y/main/d.nha")
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(json.dumps(index).encode())
            with self.assertRaises(AppLibraryError):
                self.lib.download_package("demo")

    def test_a_good_download_returns_hex_the_frontend_can_send_as_is(self):
        raw = package_bytes()
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = [
                FakeResponse(json.dumps(make_index(raw)).encode()),
                FakeResponse(raw),
            ]
            package = self.lib.download_package("demo")
        self.assertEqual(bytes.fromhex(package["data_hex"]), raw)
        self.assertEqual(package["size"], len(raw))


class CatalogCacheTests(LibraryTestCase):
    def test_an_unreachable_library_falls_back_to_the_cache_and_says_so(self):
        raw = package_bytes()
        index = make_index(raw)
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(json.dumps(index).encode())
            first = self.lib.fetch_index()
        self.assertFalse(first["stale"])

        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = urllib.error.URLError("offline")
            second = self.lib.fetch_index(force=True)
        # A stale catalog beats an empty page, but the UI has to be able to say so.
        self.assertTrue(second["stale"])
        self.assertEqual(second["error"], "unreachable")
        self.assertEqual(len(second["apps"]), 1)

    def test_an_unreachable_library_with_no_cache_raises(self):
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = urllib.error.URLError("offline")
            with self.assertRaises(AppLibraryError):
                self.lib.fetch_index()

    def test_a_not_modified_response_keeps_the_cache_fresh(self):
        raw = package_bytes()
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(json.dumps(make_index(raw)).encode(), etag="abc")
            self.lib.fetch_index()
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = urllib.error.HTTPError(
                "url", 304, "Not Modified", {}, None)
            result = self.lib.fetch_index(force=True)
        self.assertFalse(result["stale"])

    def test_unknown_app_is_reported_as_such(self):
        raw = package_bytes()
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(json.dumps(make_index(raw)).encode())
            with self.assertRaises(AppLibraryError) as ctx:
                self.lib.entry("nothing")
        self.assertEqual(str(ctx.exception), "app_not_found")


class SourceTests(LibraryTestCase):
    """The SDK page opens a library app's source to edit it."""

    DIST_URL = "https://raw.githubusercontent.com/x/y/main/dist/demo/demo-1.0.0.nha"

    def test_the_source_is_found_beside_the_package(self):
        index = make_index(package_bytes(), url=self.DIST_URL)
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = [FakeResponse(json.dumps(index).encode()), FakeResponse(b"app demo {}\n")]
            source = self.lib.fetch_source("demo")
        self.assertEqual(urlopen.call_args_list[1].args[0],
                         "https://raw.githubusercontent.com/x/y/main/apps/demo/app.nhs")
        self.assertEqual(source["kind"], "flow")
        self.assertEqual(source["source"], "app demo {}\n")
        # The page recompiles the source and checks it against this.
        self.assertEqual(source["package_sha256"], index["apps"][0]["package"]["sha256"])

    def test_a_readout_source_is_its_json(self):
        index = make_index(package_bytes(), url=self.DIST_URL)
        index["apps"][0]["kind"] = "readout"
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = [FakeResponse(json.dumps(index).encode()), FakeResponse(b"{}")]
            source = self.lib.fetch_source("demo")
        self.assertTrue(urlopen.call_args_list[1].args[0].endswith("/apps/demo/readout.json"))
        self.assertEqual(source["filename"], "readout.json")

    def test_the_source_is_served_from_cache_when_offline(self):
        index = make_index(package_bytes(), url=self.DIST_URL)
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = [FakeResponse(json.dumps(index).encode()), FakeResponse(b"cached text")]
            self.lib.fetch_source("demo")
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = urllib.error.URLError("offline")
            self.assertEqual(self.lib.fetch_source("demo")["source"], "cached text")

    def test_an_oversized_source_is_refused(self):
        index = make_index(package_bytes(), url=self.DIST_URL)
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.side_effect = [FakeResponse(json.dumps(index).encode()), FakeResponse(b"x" * (64 * 1024 + 1))]
            with self.assertRaises(AppPackageError) as ctx:
                self.lib.fetch_source("demo")
        self.assertEqual(str(ctx.exception), "source_too_large")

    def test_a_package_url_off_the_library_layout_has_no_source(self):
        index = make_index(package_bytes())
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(json.dumps(index).encode())
            with self.assertRaises(AppLibraryError) as ctx:
                self.lib.fetch_source("demo")
        self.assertEqual(str(ctx.exception), "source_unavailable")

    def test_the_source_host_is_allowlisted_like_packages(self):
        index = make_index(package_bytes(), url="https://evil.example/dist/demo/demo-1.0.0.nha")
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(json.dumps(index).encode())
            with self.assertRaises(AppLibraryError) as ctx:
                self.lib.fetch_source("demo")
        self.assertEqual(str(ctx.exception), "package_host_not_allowed")


class CacheKeyTests(LibraryTestCase):
    def test_a_cache_key_cannot_escape_the_cache_directory(self):
        for key in ("../../etc/passwd", "a/b", "..\\x"):
            with self.subTest(key=key):
                with self.assertRaises(AppLibraryError):
                    self.lib.cached_package(key)

    def test_imported_packages_round_trip_through_the_cache(self):
        raw = package_bytes()
        imported = self.lib.import_package(raw)
        again = self.lib.cached_package(imported["cache_key"])
        self.assertEqual(again["sha256"], imported["sha256"])


class RealCatalogTests(unittest.TestCase):
    """The packages this repo's sibling library actually publishes."""

    def test_every_published_package_passes_the_defence_gate(self):
        library = ROOT.parent / "NHOS-App-Library"
        packages = sorted(library.glob("apps/*/app.nha"))
        if not packages:
            self.skipTest("NHOS-App-Library is not checked out beside this repo")
        for path in packages:
            with self.subTest(app=path.parent.name):
                summary = validate_package(json.loads(path.read_text()))
                self.assertEqual(summary["id"], path.parent.name)


if __name__ == "__main__":
    unittest.main()
