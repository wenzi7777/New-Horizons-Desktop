from __future__ import annotations

import csv
import json
import re
import secrets
import shutil
import uuid
from functools import wraps
from pathlib import Path
from typing import Any, Callable

from flask import Blueprint, Response, current_app, g, request, send_file

from .auth import AuthManager, DEFAULT_TOKEN_EXPIRY_SEC, user_payload
from .gateway_auth import gateway_expected_token
from .pressure_cal_client import PressureCalError, PressureCalNotConfigured, get_client
from .pressure_cal_settings import BUILTIN_PRESETS, load_settings, save_settings
from .service import DEVICE_BOOTING, DEVICE_CONTROL_UNAVAILABLE, NewHorizonsService, command_error_message, get_service
from .terminal import compile_terminal_command, terminal_help_items, validate_device_command_payload


Decorator = Callable[[Callable[..., Any]], Callable[..., Any]]
JSON_MIMETYPE = "application/json"
GATEWAY_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def json_response(payload: Any) -> Response:
    return Response(json.dumps(payload, separators=(",", ":")), mimetype=JSON_MIMETYPE)


def _request_json_data(default: Any | None = None) -> Any:
    if not request.get_data(cache=True):
        return {} if default is None else default
    data = request.get_json(silent=True)
    if data is None:
        raise ValueError("invalid_json")
    return data


def create_blueprint(
    service: NewHorizonsService | None = None,
    auth_decorator: Decorator | None = None,
    profiles_root: Path | None = None,
    data_root: Path | None = None,
    auth_manager: AuthManager | None = None,
    url_prefix: str = "/newhorizons",
) -> Blueprint:
    svc = service or get_service(autostart=False)
    bp = Blueprint("newhorizons", __name__, url_prefix=_normalize_url_prefix(url_prefix))
    auth = auth_decorator or (lambda fn: fn)
    root_override = profiles_root
    data_dir_override = data_root

    def _auth_user() -> Any | None:
        if auth_manager is None:
            return None
        return auth_manager.current_user()

    def _auth_response(status_code: int, error: str) -> tuple[Response, int]:
        return json_response({"error": error}), status_code

    def _gateway_token_authorized() -> bool:
        expected = gateway_expected_token()
        if not expected:
            return True
        auth_header = str(request.headers.get("Authorization") or "")
        token = ""
        if auth_header.lower().startswith("bearer "):
            token = auth_header.split(" ", 1)[1].strip()
        token = token or str(request.args.get("token") or "").strip()
        return bool(token and token == expected)

    def _require_roles(*roles: str) -> Callable[[Callable[..., Response]], Callable[..., Response]]:
        def decorator(fn: Callable[..., Response]) -> Callable[..., Response]:
            @wraps(fn)
            def wrapped(*args: Any, **kwargs: Any) -> Response:
                if auth_manager is None:
                    return fn(*args, **kwargs)
                user = _auth_user()
                if user is None:
                    return _auth_response(401, "unauthorized")
                if roles and user.role not in roles:
                    return _auth_response(403, "forbidden")
                g.newhorizons_user = user
                return fn(*args, **kwargs)

            return wrapped

        return decorator

    def _profiles_dir() -> Path:
        if root_override is not None:
            return root_override
        configured = current_app.config.get("NEWHORIZONS_PROFILES_DIR")
        return Path(configured) if configured else Path(__file__).resolve().parents[2] / "web" / "profiles"

    def _wiki_root() -> Path:
        configured = current_app.config.get("NEWHORIZONS_WIKI_ROOT")
        return Path(configured) if configured else Path(__file__).resolve().parents[2] / "wiki"

    def _wiki_devices_root() -> Path:
        return _wiki_root() / "devices"

    def _wiki_device_dir(slug: str) -> Path:
        clean_slug = str(slug or "").strip()
        if not GATEWAY_ID_PATTERN.fullmatch(clean_slug):
            raise ValueError("invalid_device")
        return (_wiki_devices_root() / clean_slug).resolve()

    def _resolve_wiki_path(slug: str, raw_path: str) -> tuple[Path, Path]:
        device_dir = _wiki_device_dir(slug)
        relative = Path(str(raw_path or "").strip().strip("/"))
        target = (device_dir / relative).resolve()
        try:
            target.relative_to(device_dir)
        except ValueError as exc:
            raise PermissionError("forbidden") from exc
        return device_dir, target

    def _wiki_item(device_dir: Path, target: Path) -> dict[str, Any] | None:
        relative = target.relative_to(device_dir).as_posix()
        if target.is_dir():
            return {
                "name": target.name,
                "path": relative,
                "is_dir": True,
                "kind": "directory",
            }
        if target.is_file() and target.suffix.lower() == ".md":
            return {
                "name": target.name,
                "path": relative,
                "is_dir": False,
                "kind": "markdown",
                "size": target.stat().st_size,
            }
        return None

    def _wiki_sort_key(path: Path) -> tuple[int, str]:
        name = path.name.lower()
        return (0 if name == "readme.md" else 1, name)

    def _data_dir() -> Path:
        if data_dir_override is not None:
            return data_dir_override
        configured = current_app.config.get("NEWHORIZONS_DATA_ROOT")
        return Path(configured) if configured else svc.files_root()

    def _device_files_root(device_uid: str) -> Path:
        return (_data_dir().resolve() / device_uid).resolve()

    def _resolve_device_path(device_uid: str, raw_path: str) -> tuple[Path, Path]:
        device_root = _device_files_root(device_uid)
        relative = Path(str(raw_path or "").strip().strip("/"))
        target = (device_root / relative).resolve()
        try:
            target.relative_to(device_root)
        except ValueError as exc:
            raise PermissionError("forbidden") from exc
        return device_root, target

    def _path_from_device_root(device_root: Path, target: Path) -> str:
        return target.relative_to(device_root.parent).as_posix()

    def _relative_dir_from_device_root(device_root: Path, target: Path) -> str:
        if target == device_root:
            return ""
        return target.relative_to(device_root).as_posix()

    def _csv_directory_item(device_root: Path, path: Path) -> dict[str, Any] | None:
        if path.is_dir():
            return {
                "name": path.name,
                "path": _path_from_device_root(device_root, path),
                "is_dir": True,
                "size": 0,
                "kind": "directory",
            }
        if path.is_file() and path.suffix.lower() == ".csv":
            return {
                "name": path.name,
                "path": _path_from_device_root(device_root, path),
                "is_dir": False,
                "size": path.stat().st_size,
                "kind": "csv",
            }
        return None

    def _csv_preview_payload(device_root: Path, target: Path, preview_limit: int = 100) -> dict[str, Any]:
        sample = target.read_text(encoding="utf-8", errors="replace")
        has_header = False
        try:
            has_header = csv.Sniffer().has_header(sample[:4096]) if sample else False
        except csv.Error:
            has_header = False

        header: list[str] = []
        rows: list[list[str]] = []
        with target.open("r", encoding="utf-8", errors="replace", newline="") as handle:
            reader = csv.reader(handle)
            for row_index, row in enumerate(reader):
                if row_index == 0 and has_header:
                    header = [str(cell) for cell in row]
                    continue
                rows.append([str(cell) for cell in row])
                if len(rows) >= preview_limit:
                    break
        column_count = max(
            len(header),
            max((len(row) for row in rows), default=0),
        )
        return {
            "path": _path_from_device_root(device_root, target),
            "name": target.name,
            "size": target.stat().st_size,
            "columns": column_count,
            "row_count_previewed": len(rows),
            "has_header": has_header,
            "header": header,
            "rows": rows,
        }

    def _device_uid_from_body() -> str:
        data = _request_json_data({})
        return (data.get("device_uid") or "").strip()

    def _queue_device_command(device_uid: str, payload: dict[str, Any]) -> tuple[Response, int] | Response:
        if not device_uid:
            return json_response({"error": "device_uid_required"}), 400
        payload = dict(payload)
        request_id = str(payload.get("request_id") or uuid.uuid4().hex)
        payload["request_id"] = request_id
        try:
            queued = svc.publish_command(device_uid, payload)
        except RuntimeError as exc:
            return _command_error_response(exc, payload=payload)
        return json_response({"status": "queued", "request_id": request_id, "items": [queued]})

    def _command_error_response(exc: RuntimeError, **extra: Any) -> tuple[Response, int]:
        code = str(exc)
        message = command_error_message(code)
        body: dict[str, Any] = {
            "code": code,
            "error": message,
            "message": message,
            "retryable": code in (DEVICE_CONTROL_UNAVAILABLE, DEVICE_BOOTING),
        }
        body.update(extra)
        return json_response(body), 503 if body["retryable"] else 409

    @bp.post("/api/auth/login")
    @auth
    def auth_login() -> tuple[Response, int] | Response:
        if auth_manager is None:
            return json_response({"error": "auth_unavailable"}), 503
        try:
            data = _request_json_data({})
        except ValueError:
            return json_response({"error": "invalid_json"}), 400
        username = str(data.get("username") or "").strip()
        password = str(data.get("password") or "")
        user = auth_manager.authenticate(username, password)
        if user is None:
            return json_response({"error": "invalid_credentials"}), 401
        auth_manager.login(user)
        return json_response({"status": "ok", "user": user_payload(user)})

    @bp.post("/api/auth/logout")
    @auth
    def auth_logout() -> tuple[Response, int] | Response:
        if auth_manager is not None:
            auth_manager.logout()
        return json_response({"status": "logged_out"})

    @bp.get("/api/auth/me")
    @auth
    def auth_me() -> Response:
        user = _auth_user()
        if user is None:
            return json_response({"authenticated": False})
        return json_response(user_payload(user))

    @bp.post("/api/token")
    @auth
    def api_token() -> tuple[Response, int] | Response:
        if auth_manager is None:
            return json_response({"error": "auth_unavailable"}), 503
        try:
            data = _request_json_data({})
        except ValueError:
            return json_response({"error": "invalid_json"}), 400
        username = str(data.get("username") or "").strip()
        password = str(data.get("password") or "")
        if not username or not password:
            return json_response({"error": "username_and_password_required"}), 400
        user = auth_manager.authenticate(username, password)
        if user is None:
            return json_response({"error": "invalid_credentials"}), 401
        token = auth_manager.issue_token(user, str(current_app.secret_key or ""))
        return json_response({"token": token, "expires_in": DEFAULT_TOKEN_EXPIRY_SEC, "token_type": "Bearer"})

    @bp.get("/api/health")
    @auth
    @_require_roles("admin", "user")
    def health() -> Response:
        return json_response(svc.health())

    @bp.get("/api/devices")
    @auth
    @_require_roles("admin", "user")
    def devices() -> Response:
        return json_response({"items": svc.list_devices()})

    @bp.get("/api/gateways")
    @auth
    @_require_roles("admin")
    def gateways() -> Response:
        return json_response({"items": svc.gateway_snapshot()})

    @bp.post("/api/gateways/suggest-id")
    @auth
    def gateway_suggest_id() -> tuple[Response, int] | Response:
        if auth_manager is not None and not _gateway_token_authorized():
            user = _auth_user()
            if user is None:
                return _auth_response(401, "unauthorized")
            if user.role != "admin":
                return _auth_response(403, "forbidden")
        try:
            data = _request_json_data({})
        except ValueError:
            return json_response({"error": "invalid_json"}), 400
        existing = {
            str(item.get("gateway_id") or "").strip().lower()
            for item in svc.gateway_snapshot()
            if str(item.get("gateway_id") or "").strip()
        }
        requested = str(data.get("gateway_id") or "").strip()
        if requested:
            if not GATEWAY_ID_PATTERN.fullmatch(requested):
                return json_response({"error": "gateway_id_invalid", "available": False}), 400
            available = requested.lower() not in existing
            return json_response({"gateway_id": requested, "available": available}), 200 if available else 409
        for _ in range(64):
            candidate = f"nh-gateway-{secrets.token_hex(3)}"
            if candidate.lower() not in existing:
                return json_response({"gateway_id": candidate})
        return json_response({"error": "gateway_id_unavailable"}), 409

    @bp.delete("/api/gateways/<gateway_id>")
    @auth
    @_require_roles("admin")
    def gateway_delete(gateway_id: str) -> tuple[Response, int] | Response:
        if not svc.delete_gateway(gateway_id):
            return json_response({"error": "gateway_not_found"}), 404
        return json_response({"status": "deleted", "gateway_id": gateway_id})

    @bp.put("/api/devices/<device_uid>/nickname")
    @auth
    @_require_roles("admin")
    def device_nickname(device_uid: str) -> Response:
        data = _request_json_data({})
        try:
            result = svc.set_device_nickname(device_uid, str(data.get("nickname") or ""))
        except ValueError as exc:
            return json_response({"error": str(exc)}), 400
        return json_response(result)

    @bp.get("/api/visualization/latest")
    @auth
    @_require_roles("admin", "user")
    def visualization_latest() -> Response:
        return json_response({"items": svc.latest_visualization()})

    @bp.get("/api/terminal/help")
    @auth
    @_require_roles("admin")
    def terminal_help() -> Response:
        return json_response({"items": terminal_help_items()})

    @bp.get("/api/wiki/devices")
    @auth
    @_require_roles("admin", "user")
    def wiki_devices() -> Response:
        root = _wiki_devices_root()
        if not root.exists():
            return json_response({"items": []})
        items: list[dict[str, Any]] = []
        for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
            if not child.is_dir():
                continue
            markdown_files = [path for path in child.rglob("*.md") if path.is_file()]
            items.append(
                {
                    "slug": child.name,
                    "name": child.name,
                    "path": child.name,
                    "document_count": len(markdown_files),
                }
            )
        return json_response({"items": items})

    @bp.get("/api/wiki")
    @auth
    @_require_roles("admin", "user")
    def wiki_directory() -> tuple[Response, int] | Response:
        slug = str(request.args.get("device") or "").strip()
        if not slug:
            return json_response({"error": "device_required"}), 400
        raw_path = str(request.args.get("path") or "").strip()
        try:
            device_dir, target = _resolve_wiki_path(slug, raw_path)
        except ValueError:
            return json_response({"error": "invalid_device"}), 400
        except PermissionError:
            return json_response({"error": "forbidden"}), 403
        if not device_dir.exists():
            return json_response({"error": "device_not_found"}), 404
        if not target.exists():
            return json_response({"error": "not_found"}), 404
        if not target.is_dir():
            return json_response({"error": "directory_required"}), 400
        directories: list[dict[str, Any]] = []
        files: list[dict[str, Any]] = []
        for child in sorted(target.iterdir(), key=_wiki_sort_key):
            payload = _wiki_item(device_dir, child)
            if payload is None:
                continue
            if payload["is_dir"]:
                directories.append(payload)
            else:
                files.append(payload)
        current_path = target.relative_to(device_dir).as_posix() if target != device_dir else ""
        return json_response(
            {
                "device": slug,
                "path": current_path,
                "items": directories + files,
            }
        )

    @bp.get("/api/wiki/document")
    @auth
    @_require_roles("admin", "user")
    def wiki_document() -> tuple[Response, int] | Response:
        slug = str(request.args.get("device") or "").strip()
        raw_path = str(request.args.get("path") or "").strip()
        if not slug:
            return json_response({"error": "device_required"}), 400
        if not raw_path:
            return json_response({"error": "path_required"}), 400
        try:
            device_dir, target = _resolve_wiki_path(slug, raw_path)
        except ValueError:
            return json_response({"error": "invalid_device"}), 400
        except PermissionError:
            return json_response({"error": "forbidden"}), 403
        if not device_dir.exists():
            return json_response({"error": "device_not_found"}), 404
        if not target.exists():
            return json_response({"error": "not_found"}), 404
        if target.is_dir() or target.suffix.lower() != ".md":
            return json_response({"error": "markdown_required"}), 400
        relative_path = target.relative_to(device_dir).as_posix()
        github_url = f"https://github.com/wenzi7777/New-Horizons-Desktop/blob/main/wiki/devices/{slug}/{relative_path}"
        raw_url = f"https://raw.githubusercontent.com/wenzi7777/New-Horizons-Desktop/main/wiki/devices/{slug}/{relative_path}"
        return json_response(
            {
                "device": slug,
                "path": relative_path,
                "name": target.name,
                "content": target.read_text(encoding="utf-8", errors="replace"),
                "github_url": github_url,
                "raw_url": raw_url,
            }
        )

    @bp.post("/api/terminal/execute")
    @auth
    @_require_roles("admin")
    def terminal_execute() -> Response:
        data = _request_json_data({})
        command_line = (data.get("command_line") or "").strip()
        device_uid = (data.get("device_uid") or "").strip()
        if not command_line:
            return json_response({"error": "command_line_required"}), 400
        if not device_uid:
            return json_response({"error": "device_uid_required"}), 400
        try:
            compiled = compile_terminal_command(command_line)
        except ValueError as exc:
            return json_response({"error": str(exc)}), 400
        request_id = str(data.get("request_id") or uuid.uuid4().hex)
        payload = dict(compiled["payload"])
        payload["request_id"] = request_id
        compiled = dict(compiled)
        compiled["payload"] = payload
        compiled["request_id"] = request_id
        try:
            queued = svc.publish_command(device_uid, payload)
        except RuntimeError as exc:
            return _command_error_response(exc, compiled=compiled)
        return json_response({"status": "queued", "request_id": request_id, "compiled": compiled, "transport": queued})

    @bp.post("/api/device-command")
    @auth
    @_require_roles("admin")
    def device_command() -> Response:
        data = _request_json_data({})
        device_uid = (data.get("device_uid") or "").strip()
        if not device_uid:
            return json_response({"error": "device_uid_required"}), 400
        raw_payload = data.get("payload")
        if not isinstance(raw_payload, dict):
            return json_response({"error": "payload_required"}), 400
        try:
            payload = validate_device_command_payload(raw_payload)
        except ValueError as exc:
            return json_response({"error": str(exc)}), 400
        return _queue_device_command(device_uid, payload)

    @bp.get("/api/profiles")
    @auth
    @_require_roles("admin", "user")
    def profiles_list() -> Response:
        items = []
        for path in sorted(_profiles_dir().glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            items.append({"name": path.stem, "displayName": data.get("name", path.stem)})
        return json_response({"items": items})

    @bp.get("/api/profiles/<name>")
    @auth
    @_require_roles("admin", "user")
    def profile_get(name: str) -> Response:
        path = _profiles_dir() / f"{_sanitize_name(name)}.json"
        if not path.exists():
            return json_response({"error": "profile_not_found"}), 404
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return json_response({"error": "invalid_profile"}), 500
        return json_response(data)

    @bp.post("/api/profiles/<name>")
    @auth
    @_require_roles("admin", "user")
    def profile_save(name: str) -> Response:
        try:
            data = _request_json_data(None)
        except ValueError:
            return json_response({"error": "invalid_json"}), 400
        if data is None:
            return json_response({"error": "invalid_json"}), 400
        path = _profiles_dir() / f"{_sanitize_name(name)}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        return json_response({"status": "saved", "name": path.stem})

    @bp.delete("/api/profiles/<name>")
    @auth
    @_require_roles("admin", "user")
    def profile_delete(name: str) -> Response:
        path = _profiles_dir() / f"{_sanitize_name(name)}.json"
        if not path.exists():
            return json_response({"error": "profile_not_found"}), 404
        path.unlink()
        return json_response({"status": "deleted"})

    @bp.get("/api/files")
    @auth
    @_require_roles("admin")
    def files_list() -> Response:
        device_uid = (request.args.get("device_uid") or "").strip()
        if not device_uid:
            return json_response({"error": "device_uid_required"}), 400
        raw_path = (request.args.get("path") or "").strip()
        try:
            device_root, target = _resolve_device_path(device_uid, raw_path)
        except PermissionError:
            return json_response({"error": "forbidden"}), 403
        if not device_root.exists():
            return json_response({"device_uid": device_uid, "path": "", "parent_path": "", "items": []})
        if not target.exists():
            return json_response({"error": "not_found"}), 404
        if not target.is_dir():
            return json_response({"error": "directory_required"}), 400
        directories: list[dict[str, Any]] = []
        files: list[dict[str, Any]] = []
        for child in sorted(target.iterdir(), key=lambda item: item.name.lower()):
            payload = _csv_directory_item(device_root, child)
            if payload is None:
                continue
            if payload["is_dir"]:
                directories.append(payload)
            else:
                files.append(payload)
        current_path = _relative_dir_from_device_root(device_root, target)
        parent_path = str(Path(current_path).parent).replace("\\", "/") if current_path else ""
        if parent_path == ".":
            parent_path = ""
        return json_response(
            {
                "device_uid": device_uid,
                "path": current_path,
                "parent_path": parent_path,
                "items": directories + files,
            }
        )

    @bp.get("/api/files/preview")
    @auth
    @_require_roles("admin")
    def files_preview() -> tuple[Response, int] | Response:
        device_uid = (request.args.get("device_uid") or "").strip()
        if not device_uid:
            return json_response({"error": "device_uid_required"}), 400
        raw_path = (request.args.get("path") or "").strip()
        if not raw_path:
            return json_response({"error": "path_required"}), 400
        try:
            device_root, target = _resolve_device_path(device_uid, raw_path)
        except PermissionError:
            return json_response({"error": "forbidden"}), 403
        if not target.exists():
            return json_response({"error": "not_found"}), 404
        if target.is_dir():
            return json_response({"error": "preview_requires_file"}), 400
        if target.suffix.lower() != ".csv":
            return json_response({"error": "unsupported_file_type"}), 400
        return json_response(_csv_preview_payload(device_root, target))

    @bp.delete("/api/files")
    @auth
    @_require_roles("admin")
    def files_delete() -> tuple[Response, int] | Response:
        device_uid = (request.args.get("device_uid") or "").strip()
        if not device_uid:
            return json_response({"error": "device_uid_required"}), 400
        raw_path = (request.args.get("path") or "").strip()
        if not raw_path:
            return json_response({"error": "path_required"}), 400
        try:
            device_root, target = _resolve_device_path(device_uid, raw_path)
        except PermissionError:
            return json_response({"error": "forbidden"}), 403
        if not target.exists():
            return json_response({"error": "not_found"}), 404
        deleted_path = _path_from_device_root(device_root, target)
        if target.is_dir():
            shutil.rmtree(target)
            deleted_kind = "directory"
        else:
            if target.suffix.lower() != ".csv":
                return json_response({"error": "unsupported_file_type"}), 400
            target.unlink()
            deleted_kind = "file"
        return json_response({"status": "deleted", "deleted_path": deleted_path, "deleted_kind": deleted_kind})

    @bp.get("/api/files/download")
    @auth
    @_require_roles("admin")
    def files_download() -> Response:
        raw_path = (request.args.get("path") or "").strip().strip("/")
        if not raw_path:
            return json_response({"error": "path_required"}), 400
        root = _data_dir().resolve()
        target = (root / raw_path).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return json_response({"error": "forbidden"}), 403
        if not target.exists():
            return json_response({"error": "not_found"}), 404
        if target.is_dir():
            return json_response({"error": "download_requires_file"}), 400
        return send_file(target, as_attachment=True, download_name=target.name)

    @bp.get("/api/pressure-cal/settings")
    @auth
    @_require_roles("admin")
    def pressure_cal_settings_get() -> Response:
        settings = load_settings()
        preset = settings.get("preset", "lab_pi")
        url = settings.get("url", "")
        token = settings.get("token", "")
        configured = preset in BUILTIN_PRESETS or bool(url and token)
        token_hint = (token[:8] + "...") if token else ""
        preset_list = [
            {"id": k, "label": v["label"], "url": v["url"]}
            for k, v in BUILTIN_PRESETS.items()
        ]
        return json_response({
            "preset": preset,
            "url": url,
            "token_hint": token_hint,
            "configured": configured,
            "presets": preset_list,
        })

    @bp.post("/api/pressure-cal/settings")
    @auth
    @_require_roles("admin")
    def pressure_cal_settings_save() -> tuple[Response, int] | Response:
        try:
            data = _request_json_data({})
        except ValueError:
            return json_response({"error": "invalid_json"}), 400
        preset = str(data.get("preset") or "custom").strip()
        url = str(data.get("url") or "").strip()
        token = str(data.get("token") or "").strip()
        if preset not in BUILTIN_PRESETS and (not url or not token):
            return json_response({"error": "url_and_token_required_for_custom"}), 400
        save_settings(preset, url, token)
        return json_response({"status": "saved"})

    @bp.get("/api/pressure-cal/health")
    @auth
    @_require_roles("admin")
    def pressure_cal_health() -> tuple[Response, int] | Response:
        try:
            client = get_client()
            result = client.health()
        except PressureCalNotConfigured:
            return json_response({"error": "pressure_cal_not_configured"}), 503
        except PressureCalError as exc:
            return json_response({"error": str(exc), "status": exc.status}), 503
        return json_response(result)

    @bp.get("/api/pressure-cal/readings")
    @auth
    @_require_roles("admin")
    def pressure_cal_readings() -> tuple[Response, int] | Response:
        try:
            client = get_client()
            result = client.readings()
        except PressureCalNotConfigured:
            return json_response({"error": "pressure_cal_not_configured"}), 503
        except PressureCalError as exc:
            return json_response({"error": str(exc), "status": exc.status}), 503
        return json_response(result)

    @bp.post("/api/pressure-cal/target")
    @auth
    @_require_roles("admin")
    def pressure_cal_target() -> tuple[Response, int] | Response:
        try:
            data = _request_json_data({})
        except ValueError:
            return json_response({"error": "invalid_json"}), 400
        target_kpa = data.get("target_kpa")
        if target_kpa is None or not isinstance(target_kpa, (int, float)):
            return json_response({"error": "target_kpa_required"}), 422
        target_kpa = float(target_kpa)
        if target_kpa > 45.0:
            return json_response({"error": "target_kpa_exceeds_safety_limit", "limit": 45.0}), 422
        if target_kpa < 0:
            return json_response({"error": "target_kpa_must_be_non_negative"}), 422
        try:
            client = get_client()
            result = client.set_target(target_kpa)
        except PressureCalNotConfigured:
            return json_response({"error": "pressure_cal_not_configured"}), 503
        except PressureCalError as exc:
            return json_response({"error": str(exc), "status": exc.status}), 503
        return json_response(result)

    @bp.post("/api/pressure-cal/stop")
    @auth
    @_require_roles("admin")
    def pressure_cal_stop() -> tuple[Response, int] | Response:
        try:
            client = get_client()
            result = client.stop()
        except PressureCalNotConfigured:
            return json_response({"error": "pressure_cal_not_configured"}), 503
        except PressureCalError as exc:
            return json_response({"error": str(exc), "status": exc.status}), 503
        return json_response(result)

    return bp


def _sanitize_name(name: str) -> str:
    return "".join(char if char.isalnum() or char in {"_", "-"} else "_" for char in name)


def _normalize_url_prefix(value: str) -> str:
    normalized = "/" + str(value or "").strip().strip("/")
    return "" if normalized == "/" else normalized
