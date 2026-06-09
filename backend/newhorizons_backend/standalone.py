from __future__ import annotations

import os
from pathlib import Path
from datetime import timedelta

from flask import Flask, Response, redirect, send_file, send_from_directory

from .api import create_blueprint
from .auth import AuthManager, DEFAULT_SESSION_LIFETIME_SEC
from .service import NewHorizonsService
from .gateway_ws import register_gateway_websocket_routes
from .stream_ws import register_stream_websocket_routes
from .ws import register_websocket_routes


PROJECT_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
MOCK_ROOT = PROJECT_ROOT / "mock_data"
MOCK_PROFILES_ROOT = MOCK_ROOT / "profiles"
MOCK_DATA_ROOT = MOCK_ROOT / "mqtt_store"
DEFAULT_PROFILES_ROOT = PROJECT_ROOT / "data" / "profiles"
DEFAULT_DATA_ROOT = PROJECT_ROOT / "data" / "mqtt_store"
DEFAULT_AUTH_DB = PROJECT_ROOT / "data" / "auth.sqlite3"
DEFAULT_WIKI_ROOT = PROJECT_ROOT / "wiki"


def create_standalone_app() -> Flask:
    mock_mode = os.getenv("NEWHORIZONS_MOCK_MODE", "0") == "1"
    autostart = os.getenv("NEWHORIZONS_AUTOSTART", "1") != "0"
    profiles_root = Path(os.getenv("NEWHORIZONS_PROFILES_DIR", str(MOCK_PROFILES_ROOT if mock_mode else DEFAULT_PROFILES_ROOT)))
    data_root = Path(os.getenv("NEWHORIZONS_DATA_ROOT", str(MOCK_DATA_ROOT if mock_mode else DEFAULT_DATA_ROOT)))
    wiki_root = Path(os.getenv("NEWHORIZONS_WIKI_ROOT", str(DEFAULT_WIKI_ROOT)))
    frontend_dist = Path(os.getenv("NEWHORIZONS_FRONTEND_DIST", str(FRONTEND_DIST)))
    auth_db = Path(os.getenv("NEWHORIZONS_AUTH_DB", str(DEFAULT_AUTH_DB)))
    base_path = _normalize_base_path(os.getenv("NEWHORIZONS_BASE_PATH", "/newhorizons"))
    service = NewHorizonsService(autostart=autostart and not mock_mode, mock_mode=mock_mode)
    auth_manager = AuthManager(auth_db)

    app = Flask(
        __name__,
        static_folder=str(frontend_dist / "assets"),
        static_url_path=_join_base_path(base_path, "assets"),
    )
    app.secret_key = os.getenv("NEWHORIZONS_SECRET_KEY") or os.urandom(24).hex()
    app.permanent_session_lifetime = timedelta(seconds=DEFAULT_SESSION_LIFETIME_SEC)
    app.config["NEWHORIZONS_PROFILES_DIR"] = str(profiles_root)
    app.config["NEWHORIZONS_DATA_ROOT"] = str(data_root)
    app.config["NEWHORIZONS_WIKI_ROOT"] = str(wiki_root)
    app.config["NEWHORIZONS_AUTH_DB"] = str(auth_db)
    app.config["NEWHORIZONS_BASE_PATH"] = base_path
    app.config["NEWHORIZONS_SERVICE"] = service
    app.config["NEWHORIZONS_AUTH_MANAGER"] = auth_manager
    app.register_blueprint(
        create_blueprint(
            service=service,
            profiles_root=profiles_root,
            data_root=data_root,
            auth_manager=auth_manager,
            url_prefix=base_path,
        )
    )
    register_websocket_routes(app, service, auth_manager=auth_manager, url_prefix=base_path)
    register_stream_websocket_routes(app, service, auth_manager=auth_manager, url_prefix=base_path)
    register_gateway_websocket_routes(app, service, url_prefix=base_path)

    @app.get("/")
    def index() -> Response:
        return redirect(_join_base_path(base_path, ""))

    def newhorizons_spa(relative_path: str = "") -> Response:
        if relative_path.startswith(("api/", "ota/")):
            return Response(status=404)
        if relative_path:
            target = frontend_dist / relative_path
            if target.is_file():
                return send_from_directory(frontend_dist, relative_path)
        return send_file(frontend_dist / "index.html")

    spa_root = _join_base_path(base_path, "")
    spa_root_compact = spa_root.rstrip("/") or "/"
    app.add_url_rule(spa_root_compact, endpoint=f"newhorizons_spa_root_{base_path or 'root'}", view_func=newhorizons_spa)
    app.add_url_rule(spa_root, endpoint=f"newhorizons_spa_slash_{base_path or 'root'}", view_func=newhorizons_spa)
    app.add_url_rule(
        _join_base_path(base_path, "<path:relative_path>"),
        endpoint=f"newhorizons_spa_path_{base_path or 'root'}",
        view_func=newhorizons_spa,
    )

    return app


def main() -> None:
    app = create_standalone_app()
    host = os.getenv("NEWHORIZONS_HOST", "127.0.0.1")
    port = int(os.getenv("NEWHORIZONS_PORT", "5051"))
    debug = os.getenv("NEWHORIZONS_DEBUG", "1") != "0"
    use_reloader = os.getenv("NEWHORIZONS_USE_RELOADER", "0") == "1"
    app.run(host=host, port=port, debug=debug, use_reloader=use_reloader)

def _normalize_base_path(value: str) -> str:
    stripped = str(value or "").strip().strip("/")
    return f"/{stripped}" if stripped else ""


def _join_base_path(base_path: str, suffix: str) -> str:
    clean_suffix = str(suffix or "").lstrip("/")
    if not base_path:
        return "/" if not clean_suffix else f"/{clean_suffix}"
    if not clean_suffix:
        return f"{base_path}/"
    return f"{base_path}/{clean_suffix}"


if __name__ == "__main__":
    main()
