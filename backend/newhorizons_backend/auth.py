from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Final

from flask import session
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash


SESSION_USERNAME_KEY: Final[str] = "newhorizons_username"
SESSION_ROLE_KEY: Final[str] = "newhorizons_role"
DEFAULT_SESSION_LIFETIME_SEC: Final[int] = 12 * 60 * 60
DEFAULT_TOKEN_EXPIRY_SEC: Final[int] = 24 * 60 * 60
TOKEN_SALT: Final[str] = "newhorizons-api-token"
# App tokens: one per NH Studio / NH Pocket install, made by an admin. The
# token is `nhapp_<id>_<secret>`; only a SHA-256 of the whole string is
# stored, the id is there so a lookup needs no scan.
APP_TOKEN_PREFIX: Final[str] = "nhapp_"
APP_CLIENT_TYPES: Final[tuple[str, ...]] = ("studio", "pocket")
APP_TOKEN_ROLES: Final[tuple[str, ...]] = ("admin", "user")
_APP_TOKEN_PATTERN = re.compile(r"^nhapp_([a-f0-9]{12})_([A-Za-z0-9_-]{32,64})$")
# Revoked tokens stay listed this long, then are deleted.
_REVOKED_TOKEN_KEEP_MS: Final[int] = 30 * 24 * 60 * 60 * 1000
# A token in use is stamped at most this often, not on every request.
_LAST_USED_WRITE_INTERVAL_MS: Final[int] = 60_000


@dataclass(frozen=True)
class AuthUser:
    username: str
    role: str
    # Set only for a principal that came in with an app token: which app
    # (its token id) and what kind. The shared admin login is never an
    # identity; these are.
    app_id: str = ""
    client_type: str = ""

    @property
    def is_app(self) -> bool:
        return bool(self.app_id)


def bearer_token(headers: object, args: object | None = None) -> str:
    """The token in `Authorization: Bearer`, or (WebSockets only, where a
    browser cannot set headers) in `?token=`."""
    auth_header = str(getattr(headers, "get")("Authorization") or "")
    if auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    if args is not None:
        return str(getattr(args, "get")("token") or "").strip()
    return ""


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now_ms() -> int:
    return int(time.time() * 1000)


class AuthManager:
    DEFAULT_USERS: Final[dict[str, dict[str, object]]] = {
        "admin": {"role": "admin", "passwords": ("admin", "uoacnlab2026")},
        "user": {"role": "user", "passwords": ("9227f4f37950df", "uoacnlab2026")},
    }

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # Open WebSockets per app token, closed when the token is revoked:
        # a token is only checked when a socket connects, so revoking it
        # must also end the sockets it already opened.
        self._sessions_lock = threading.Lock()
        self._app_sessions: dict[str, dict[int, Callable[[], None]]] = {}
        self._session_seq = 0
        self._initialize()

    def track_app_session(self, app_id: str, close: Callable[[], None]) -> Callable[[], None]:
        """Remember an open socket of app token `app_id`; returns the
        function that forgets it (call it when the socket ends)."""
        app_id = str(app_id or "")
        if not app_id:
            return lambda: None
        with self._sessions_lock:
            self._session_seq += 1
            key = self._session_seq
            self._app_sessions.setdefault(app_id, {})[key] = close

        def untrack() -> None:
            with self._sessions_lock:
                sessions = self._app_sessions.get(app_id)
                if sessions is not None:
                    sessions.pop(key, None)
                    if not sessions:
                        self._app_sessions.pop(app_id, None)

        return untrack

    def close_app_sessions(self, app_id: str) -> int:
        """Closes every open socket of app token `app_id`; returns how many."""
        with self._sessions_lock:
            closers = list((self._app_sessions.pop(str(app_id or ""), None) or {}).values())
        for close in closers:
            try:
                close()
            except Exception:
                pass
        return len(closers)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    username TEXT PRIMARY KEY,
                    role TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS credentials (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    FOREIGN KEY (username) REFERENCES users (username) ON DELETE CASCADE
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS app_tokens (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    client_type TEXT NOT NULL,
                    role TEXT NOT NULL,
                    token_hash TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    created_by TEXT NOT NULL DEFAULT '',
                    last_used_at_ms INTEGER,
                    revoked_at_ms INTEGER
                )
                """
            )
            for username, config in self.DEFAULT_USERS.items():
                connection.execute(
                    """
                    INSERT INTO users (username, role, active)
                    VALUES (?, ?, 1)
                    ON CONFLICT(username) DO UPDATE SET role = excluded.role, active = 1
                    """,
                    (username, str(config["role"])),
                )
                hashes = [
                    row["password_hash"]
                    for row in connection.execute(
                        "SELECT password_hash FROM credentials WHERE username = ?",
                        (username,),
                    ).fetchall()
                ]
                for password in config["passwords"]:
                    if any(check_password_hash(password_hash, str(password)) for password_hash in hashes):
                        continue
                    connection.execute(
                        "INSERT INTO credentials (username, password_hash) VALUES (?, ?)",
                        (username, generate_password_hash(str(password))),
                    )
            connection.commit()

    def authenticate(self, username: str, password: str) -> AuthUser | None:
        normalized = (username or "").strip()
        if not normalized or not password:
            return None
        with self._connect() as connection:
            row = connection.execute(
                "SELECT username, role, active FROM users WHERE username = ?",
                (normalized,),
            ).fetchone()
            if row is None or not bool(row["active"]):
                return None
            hashes = connection.execute(
                "SELECT password_hash FROM credentials WHERE username = ?",
                (normalized,),
            ).fetchall()
        if not any(check_password_hash(item["password_hash"], password) for item in hashes):
            return None
        return AuthUser(username=str(row["username"]), role=str(row["role"]))

    def current_user(self) -> AuthUser | None:
        username = str(session.get(SESSION_USERNAME_KEY) or "").strip()
        role = str(session.get(SESSION_ROLE_KEY) or "").strip()
        if not username or not role:
            return None
        with self._connect() as connection:
            row = connection.execute(
                "SELECT username, role, active FROM users WHERE username = ?",
                (username,),
            ).fetchone()
        if row is None or not bool(row["active"]):
            return None
        if str(row["role"]) != role:
            role = str(row["role"])
            session[SESSION_ROLE_KEY] = role
        return AuthUser(username=username, role=role)

    def request_user(self, headers: object, args: object | None = None) -> AuthUser | None:
        """Who is making this request: the cookie session as before, else an
        app token. A bearer token that is not an app token is ignored here
        (the signed /api/token ones are for /stream/ws only)."""
        user = self.current_user()
        if user is not None:
            return user
        token = bearer_token(headers, args)
        if not token.startswith(APP_TOKEN_PREFIX):
            return None
        return self.authenticate_app_token(token)

    def login(self, user: AuthUser) -> None:
        session.permanent = True
        session[SESSION_USERNAME_KEY] = user.username
        session[SESSION_ROLE_KEY] = user.role

    def logout(self) -> None:
        session.pop(SESSION_USERNAME_KEY, None)
        session.pop(SESSION_ROLE_KEY, None)

    def issue_token(self, user: AuthUser, secret_key: str) -> str:
        return self._serializer(secret_key).dumps({"username": user.username, "role": user.role})

    def authenticate_token(self, token: str, secret_key: str, max_age: int = DEFAULT_TOKEN_EXPIRY_SEC) -> AuthUser | None:
        raw = str(token or "").strip()
        if not raw:
            return None
        try:
            data = self._serializer(secret_key).loads(raw, max_age=max_age)
        except (BadSignature, SignatureExpired, KeyError):
            return None
        username = str(data.get("username") or "").strip()
        role = str(data.get("role") or "").strip()
        if not username or not role:
            return None
        with self._connect() as connection:
            row = connection.execute(
                "SELECT username, role, active FROM users WHERE username = ?",
                (username,),
            ).fetchone()
        if row is None or not bool(row["active"]):
            return None
        return AuthUser(username=str(row["username"]), role=str(row["role"]))

    # ── App tokens ────────────────────────────────────────────────────────

    def create_app_token(self, name: str, client_type: str, role: str = "admin", created_by: str = "") -> tuple[str, dict[str, object]]:
        """A new token and its listing entry. The token itself is returned
        only here; afterwards only its hash exists."""
        name = str(name or "").strip()
        client_type = str(client_type or "").strip().lower()
        role = str(role or "admin").strip().lower()
        if not name:
            raise ValueError("name_required")
        if len(name) > 64:
            raise ValueError("name_too_long")
        if client_type not in APP_CLIENT_TYPES:
            raise ValueError("client_type_invalid")
        if role not in APP_TOKEN_ROLES:
            raise ValueError("role_invalid")
        token_id = secrets.token_hex(6)
        token = f"{APP_TOKEN_PREFIX}{token_id}_{secrets.token_urlsafe(32)}"
        now = _now_ms()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO app_tokens (id, name, client_type, role, token_hash, created_at_ms, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (token_id, name, client_type, role, _hash_token(token), now, str(created_by or "")),
            )
            connection.commit()
            row = connection.execute("SELECT * FROM app_tokens WHERE id = ?", (token_id,)).fetchone()
        return token, self._app_token_item(row)

    def list_app_tokens(self) -> list[dict[str, object]]:
        with self._connect() as connection:
            # Each sign-in makes a token and signing out revokes it, so the
            # revoked ones pile up: they are dropped after a month.
            connection.execute(
                "DELETE FROM app_tokens WHERE revoked_at_ms IS NOT NULL AND revoked_at_ms < ?",
                (_now_ms() - _REVOKED_TOKEN_KEEP_MS,),
            )
            connection.commit()
            rows = connection.execute("SELECT * FROM app_tokens ORDER BY created_at_ms DESC, id").fetchall()
        return [self._app_token_item(row) for row in rows]

    def revoke_app_token(self, token_id: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE app_tokens SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL",
                (_now_ms(), str(token_id or "")),
            )
            connection.commit()
            found = bool(cursor.rowcount) or (
                # Revoking twice is not an error, revoking nothing is.
                connection.execute("SELECT 1 FROM app_tokens WHERE id = ?", (str(token_id or ""),)).fetchone() is not None
            )
        if found:
            self.close_app_sessions(str(token_id or ""))
        return found

    def authenticate_app_token(self, token: str) -> AuthUser | None:
        match = _APP_TOKEN_PATTERN.fullmatch(str(token or "").strip())
        if match is None:
            return None
        token_id = match.group(1)
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM app_tokens WHERE id = ?", (token_id,)).fetchone()
            if row is None or row["revoked_at_ms"] is not None:
                return None
            if not hmac.compare_digest(str(row["token_hash"]), _hash_token(match.group(0))):
                return None
            role = str(row["role"])
            created_by = str(row["created_by"] or "")
            if created_by:
                # A token made by signing in is that account's: it ends when
                # the account is deactivated or gone, and never outranks it.
                owner = connection.execute(
                    "SELECT role, active FROM users WHERE username = ?",
                    (created_by,),
                ).fetchone()
                if owner is None or not bool(owner["active"]):
                    return None
                if str(owner["role"]) != "admin":
                    role = "user"
            now = _now_ms()
            if row["last_used_at_ms"] is None or now - int(row["last_used_at_ms"]) >= _LAST_USED_WRITE_INTERVAL_MS:
                connection.execute("UPDATE app_tokens SET last_used_at_ms = ? WHERE id = ?", (now, token_id))
                connection.commit()
        return AuthUser(
            username=f"app:{token_id}",
            role=role,
            app_id=token_id,
            client_type=str(row["client_type"]),
        )

    def app_token_info(self, token_id: str) -> dict[str, object] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM app_tokens WHERE id = ?", (str(token_id or ""),)).fetchone()
        return None if row is None else self._app_token_item(row)

    @staticmethod
    def _app_token_item(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": str(row["id"]),
            "name": str(row["name"]),
            "client_type": str(row["client_type"]),
            "role": str(row["role"]),
            "created_at_ms": int(row["created_at_ms"]),
            "created_by": str(row["created_by"] or ""),
            "last_used_at_ms": None if row["last_used_at_ms"] is None else int(row["last_used_at_ms"]),
            "revoked_at_ms": None if row["revoked_at_ms"] is None else int(row["revoked_at_ms"]),
            "active": row["revoked_at_ms"] is None,
            # Enough to tell tokens apart in a list; never the secret.
            "token_hint": f"{APP_TOKEN_PREFIX}{row['id']}_…",
        }

    @staticmethod
    def _serializer(secret_key: str) -> URLSafeTimedSerializer:
        return URLSafeTimedSerializer(secret_key, salt=TOKEN_SALT)


def user_payload(user: AuthUser) -> dict[str, object]:
    payload: dict[str, object] = {
        "authenticated": True,
        "username": user.username,
        "role": user.role,
    }
    if user.is_app:
        payload["app_id"] = user.app_id
        payload["client_type"] = user.client_type
    return payload
