"""The NHOS App Library client: catalog fetch, caching and package validation.

Division of labour with the frontend: this module owns the catalog, the bytes
and the checking; the browser owns the conversation with the device. The device
conversation stays there because request_id correlation, per-device
serialisation and chunk progress all already exist in the frontend and exist
nowhere in the backend -- see lib/deviceCommand.ts.

Why validate here at all, when the library's own CI already does? Different
jobs. CI is the authoring gate: it tells an author their app is wrong. This is
the defence gate: nothing malformed reaches a device even if the catalog is
hand-edited, stale, or served by something other than the library.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_LIBRARY_INDEX_URL = (
    "https://raw.githubusercontent.com/wenzi7777/NHOS-App-Library/main/index.json"
)
# package.url comes out of a remote file, so it is attacker-influenced input as
# far as this process is concerned: restrict where it may point.
DEFAULT_ALLOWED_HOSTS = ("raw.githubusercontent.com",)

DEVICE_APP_DIR = "apps"
APP_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,14}$")
RESERVED_APP_IDS = {"index"}
# FlowApp::kMaxNodes since firmware v1.3.0 (12 before). A graph over 12 also
# carries min_os v1.3.0, which the device itself checks against its version.
MAX_RULE_NODES = 24
MAX_PACKAGE_BYTES = 4096  # the firmware's parse buffer, for either kind
MAX_EVENT_NAME = 23
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
MIN_OS_RE = re.compile(r"^v?\d+\.\d+\.\d+$")

# button and display since firmware v1.4.0 (the OLED and the action button);
# drive_ext_led since v1.5.0 (the external LED strip).
CAPABILITIES = {"read_matrix", "read_imu", "emit_event", "drive_led", "write_file", "button", "display", "drive_ext_led"}

# Commands a readout may poll. Enforced here as well as in the library's CI:
# a package can arrive from a hand-edited catalog, and nothing that renders in
# an operator's browser should be able to write to a device.
READOUT_SOURCES = {
    "task_list", "service_list", "app_list", "app_list_packages", "app_events",
    "memory_status", "scan_health", "storage_status", "status", "capabilities",
}
READOUT_SECTION_KINDS = {"stats", "table"}

# Mirrors the App Library's sdk/lib/opset.mjs. Kept as a flat set because this module's job is to
# reject the impossible, not to estimate cost -- the device does that.
# v1.1.0 renamed the engine from "rule" to "flow"; the op names did not change.
KNOWN_OPS = {
    "total", "peak", "region_sum", "active_cells", "threshold", "debounce", "emit",
    "const", "add", "sub", "mul", "div", "min", "max", "abs", "clamp",
    "mean", "max_hold", "delta", "integrate", "counter",
    "features", "feature_get", "arg_max", "row_centroid", "col_centroid",
    "led", "emit_value", "select", "gate", "budget_load", "grace_left",
    # v1.4.0: the OLED and the action button
    "mod", "button", "oled_text", "oled_bar",
    # v1.5.0: the external LED strip
    "ext_pixel", "ext_meter",
}

FETCH_TIMEOUT_SEC = 5
DEFAULT_TTL_SEC = 900
# An app's source is the text an author edits, not the package a device runs,
# so it has no firmware limit -- but it is still remote input, so cap it.
MAX_SOURCE_BYTES = 64 * 1024


class AppLibraryError(Exception):
    """A catalog or transport problem."""


class AppPackageError(Exception):
    """A package that must not be sent to a device."""


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise AppPackageError(code)


def validate_package(doc: Any) -> dict[str, Any]:
    """Structural checks, no I/O. Raises AppPackageError, returns a summary."""
    _require(isinstance(doc, dict), "not_a_package")
    _require(doc.get("nhapp") == 1, "unsupported_package_version")
    kind = str(doc.get("kind") or "flow")
    _require(kind in ("flow", "readout"), "unsupported_kind")

    manifest = doc.get("manifest")
    _require(isinstance(manifest, dict), "missing_manifest")

    app_id = str(manifest.get("id") or "")
    # The id cap is not cosmetic: "/files/apps/<id>.nha" has to fit SPIFFS' 31
    # character path limit, and an over-long id fails during the UPLOAD with an
    # opaque path_too_long, long before app_install could explain itself.
    _require(bool(APP_ID_RE.match(app_id)), "invalid_id")
    _require(app_id not in RESERVED_APP_IDS, "reserved_id")
    _require(bool(SEMVER_RE.match(str(manifest.get("version") or ""))), "invalid_version")
    for field in ("name", "author", "summary"):
        _require(bool(str(manifest.get(field) or "").strip()), "invalid_manifest")
    min_os = str(manifest.get("min_os") or "v1.0.0")
    _require(bool(MIN_OS_RE.match(min_os)), "invalid_min_os")

    capabilities = manifest.get("capabilities", [])
    _require(isinstance(capabilities, list), "invalid_manifest")
    for capability in capabilities:
        _require(capability in CAPABILITIES, "unknown_capability")

    if kind == "readout":
        _require("nodes" not in doc, "readout_must_not_declare_nodes")
        readout = doc.get("readout")
        _require(isinstance(readout, dict), "missing_readout")
        sources = readout.get("sources")
        _require(isinstance(sources, list) and sources, "missing_sources")
        for source in sources:
            _require(isinstance(source, dict), "invalid_source")
            _require(str(source.get("command")) in READOUT_SOURCES, "readout_source_not_allowed")
        sections = readout.get("sections")
        _require(isinstance(sections, list) and sections, "missing_sections")
        for section in sections:
            _require(isinstance(section, dict), "invalid_section")
            _require(str(section.get("kind")) in READOUT_SECTION_KINDS, "unknown_section_kind")
        return {
            "id": app_id,
            "version": str(manifest["version"]),
            "min_os": min_os,
            "kind": "readout",
            "nodes": 0,
            "capabilities": list(capabilities),
            "device_path": f"{DEVICE_APP_DIR}/{app_id}.nha",
        }

    _require("readout" not in doc, "flow_must_not_declare_a_readout")
    nodes = doc.get("nodes")
    _require(isinstance(nodes, list), "missing_nodes")
    _require(len(nodes) > 0, "empty_graph")
    _require(len(nodes) <= MAX_RULE_NODES, "too_many_nodes")

    for index, node in enumerate(nodes):
        _require(isinstance(node, dict), "invalid_node")
        _require(str(node.get("op") or "") in KNOWN_OPS, "unknown_op")
        refs = node.get("in", [])
        refs = [refs] if isinstance(refs, int) else refs
        _require(isinstance(refs, list), "invalid_node")
        for ref in refs:
            # Backward-only references are what make a cycle unrepresentable.
            _require(isinstance(ref, int) and 0 <= ref < index, "input_out_of_order")
        event = node.get("event")
        if event is not None:
            _require(isinstance(event, str) and 0 < len(event) <= MAX_EVENT_NAME,
                     "invalid_event_name")

    return {
        "id": app_id,
        "version": str(manifest["version"]),
        "min_os": min_os,
        "kind": "flow",
        "nodes": len(nodes),
        "capabilities": list(capabilities),
        "device_path": f"{DEVICE_APP_DIR}/{app_id}.nha",
    }


def canonical_bytes(doc: dict) -> bytes:
    """Match the library's serialisation so a re-serialised package still hashes."""
    return (json.dumps(doc, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":")) + "\n").encode("utf-8")


class AppLibrary:
    def __init__(self, cache_root: Path, index_url: str | None = None,
                 ttl_sec: int = DEFAULT_TTL_SEC, allowed_hosts: tuple[str, ...] | None = None):
        self._cache_root = Path(cache_root)
        self._index_url = index_url or os.getenv("NEWHORIZONS_APP_LIBRARY_URL", DEFAULT_LIBRARY_INDEX_URL)
        self._ttl_sec = ttl_sec
        extra = os.getenv("NEWHORIZONS_APP_LIBRARY_HOSTS", "")
        self._allowed_hosts = tuple(allowed_hosts or DEFAULT_ALLOWED_HOSTS) + tuple(
            host.strip() for host in extra.split(",") if host.strip()
        )
        # Flask-Sock serves concurrent clients; the cache is process-wide state.
        self._lock = threading.RLock()

    # -- paths --
    @property
    def _index_path(self) -> Path:
        return self._cache_root / "index.json"

    @property
    def _meta_path(self) -> Path:
        return self._cache_root / "index.meta.json"

    def _package_path(self, cache_key: str) -> Path:
        return self._cache_root / "packages" / f"{cache_key}.nha"

    # -- catalog --
    def fetch_index(self, force: bool = False) -> dict[str, Any]:
        """Return the catalog, falling back to the disk copy when offline.

        A stale catalog is far better than an empty page, so a network failure
        is reported alongside the cached content rather than instead of it.
        """
        with self._lock:
            meta = self._read_json(self._meta_path) or {}
            cached = self._read_json(self._index_path)
            if cached and not force and not self._expired(meta):
                return self._decorate(cached, source="cache", stale=False)

            request = urllib.request.Request(self._index_url, headers={"Accept": "application/json"})
            if cached and meta.get("etag"):
                request.add_header("If-None-Match", str(meta["etag"]))
            try:
                with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SEC) as response:
                    body = response.read()
                    etag = response.headers.get("ETag")
            except urllib.error.HTTPError as exc:
                if exc.code == 304 and cached:
                    self._write_meta(meta.get("etag"))
                    return self._decorate(cached, source="cache", stale=False)
                if cached:
                    return self._decorate(cached, source="cache", stale=True, error=f"http_{exc.code}")
                raise AppLibraryError(f"http_{exc.code}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if cached:
                    return self._decorate(cached, source="cache", stale=True, error="unreachable")
                raise AppLibraryError("unreachable") from exc

            try:
                index = json.loads(body.decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                if cached:
                    return self._decorate(cached, source="cache", stale=True, error="malformed_index")
                raise AppLibraryError("malformed_index") from exc

            self._cache_root.mkdir(parents=True, exist_ok=True)
            self._index_path.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
            self._write_meta(etag)
            return self._decorate(index, source="remote", stale=False)

    def entry(self, app_id: str) -> dict[str, Any]:
        index = self.fetch_index()
        for item in index.get("apps", []):
            if str(item.get("id")) == app_id:
                return item
        raise AppLibraryError("app_not_found")

    # -- packages --
    def download_package(self, app_id: str, version: str | None = None) -> dict[str, Any]:
        _require(bool(APP_ID_RE.match(app_id)), "invalid_id")
        entry = self.entry(app_id)
        if version and str(entry.get("version")) != version:
            raise AppLibraryError("version_not_available")

        package = entry.get("package") or {}
        url = str(package.get("url") or "")
        expected_sha = str(package.get("sha256") or "")
        expected_size = int(package.get("size") or 0)
        self._check_host(url)

        cache_key = f"{app_id}-{entry.get('version')}"
        cached = self._package_path(cache_key)
        raw = cached.read_bytes() if cached.exists() else None
        if raw is None or (expected_sha and hashlib.sha256(raw).hexdigest() != expected_sha):
            try:
                with urllib.request.urlopen(url, timeout=FETCH_TIMEOUT_SEC) as response:
                    raw = response.read(MAX_PACKAGE_BYTES + 1)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                raise AppLibraryError("package_unreachable") from exc

        return self._accept(raw, cache_key, expected_sha=expected_sha, expected_size=expected_size)

    def fetch_source(self, app_id: str) -> dict[str, Any]:
        """The source an app's package was built from, for the SDK page to open.

        The catalog has no URL for it, so it is found where the library keeps
        it: `apps/<id>/app.nhs` (or `readout.json`) under the same base as the
        package. There is no checksum for source; the SDK page recompiles it
        and compares the result against the package's sha256 instead, which is
        a stronger check than a second hash would be.
        """
        _require(bool(APP_ID_RE.match(app_id)), "invalid_id")
        entry = self.entry(app_id)
        kind = "readout" if entry.get("kind") == "readout" else "flow"
        filename = "readout.json" if kind == "readout" else "app.nhs"
        package_url = str((entry.get("package") or {}).get("url") or "")
        if "/dist/" not in package_url:
            raise AppLibraryError("source_unavailable")
        url = f"{package_url.split('/dist/', 1)[0]}/apps/{app_id}/{filename}"
        self._check_host(url)

        cache = self._cache_root / "sources" / f"{app_id}-{entry.get('version')}-{filename}"
        try:
            with urllib.request.urlopen(url, timeout=FETCH_TIMEOUT_SEC) as response:
                raw = response.read(MAX_SOURCE_BYTES + 1)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if not cache.exists():
                raise AppLibraryError("source_unreachable") from exc
            raw = cache.read_bytes()
        _require(len(raw) <= MAX_SOURCE_BYTES, "source_too_large")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AppPackageError("malformed_source") from exc
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(raw)
        return {
            "id": app_id,
            "version": entry.get("version"),
            "kind": kind,
            "filename": filename,
            "source": text,
            "package_sha256": (entry.get("package") or {}).get("sha256"),
        }

    def import_package(self, raw: bytes) -> dict[str, Any]:
        digest = hashlib.sha256(raw).hexdigest()
        return self._accept(raw, f"local-{digest[:8]}")

    def _accept(self, raw: bytes, cache_key: str, expected_sha: str = "",
                expected_size: int = 0) -> dict[str, Any]:
        _require(len(raw) <= MAX_PACKAGE_BYTES, "package_too_large")
        if expected_size:
            _require(len(raw) == expected_size, "size_mismatch")
        digest = hashlib.sha256(raw).hexdigest()
        if expected_sha:
            _require(digest == expected_sha, "checksum_mismatch")

        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise AppPackageError("malformed_package") from exc
        summary = validate_package(doc)

        path = self._package_path(cache_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)

        summary.update({
            "sha256": digest,
            "size": len(raw),
            "cache_key": cache_key,
            # hex, because file_write_chunk already takes hex -- the frontend
            # should never have to re-encode what it is about to send.
            "data_hex": raw.hex(),
        })
        return summary

    def cached_package(self, cache_key: str) -> dict[str, Any]:
        if "/" in cache_key or "\\" in cache_key or ".." in cache_key:
            raise AppLibraryError("invalid_cache_key")
        path = self._package_path(cache_key)
        if not path.exists():
            raise AppLibraryError("not_cached")
        return self._accept(path.read_bytes(), cache_key)

    # -- helpers --
    def _check_host(self, url: str) -> None:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in self._allowed_hosts:
            raise AppLibraryError("package_host_not_allowed")

    def _expired(self, meta: dict[str, Any]) -> bool:
        import time

        fetched_at = float(meta.get("fetched_at") or 0)
        return (time.time() - fetched_at) > self._ttl_sec

    def _write_meta(self, etag: str | None) -> None:
        import time

        self._cache_root.mkdir(parents=True, exist_ok=True)
        self._meta_path.write_text(
            json.dumps({"etag": etag, "fetched_at": time.time()}), encoding="utf-8"
        )

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any] | None:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - a missing or corrupt cache is not fatal
            return None

    @staticmethod
    def _decorate(index: dict[str, Any], *, source: str, stale: bool,
                  error: str | None = None) -> dict[str, Any]:
        result = dict(index)
        result["source"] = source
        result["stale"] = stale
        if error:
            result["error"] = error
        return result


_library: AppLibrary | None = None
_library_lock = threading.Lock()


def get_library(cache_root: Path | None = None) -> AppLibrary:
    global _library
    with _library_lock:
        if _library is None or cache_root is not None:
            root = cache_root or Path(
                os.getenv("NEWHORIZONS_APP_LIBRARY_DIR",
                          Path(os.getenv("NEWHORIZONS_DATA_ROOT", "data")) / "_app_library")
            )
            _library = AppLibrary(root)
        return _library
