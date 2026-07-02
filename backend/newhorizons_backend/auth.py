from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from flask import session
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash


SESSION_USERNAME_KEY: Final[str] = "newhorizons_username"
SESSION_ROLE_KEY: Final[str] = "newhorizons_role"
DEFAULT_SESSION_LIFETIME_SEC: Final[int] = 12 * 60 * 60
DEFAULT_TOKEN_EXPIRY_SEC: Final[int] = 24 * 60 * 60
TOKEN_SALT: Final[str] = "newhorizons-api-token"


@dataclass(frozen=True)
class AuthUser:
    username: str
    role: str


class AuthManager:
    DEFAULT_USERS: Final[dict[str, dict[str, object]]] = {
        "admin": {"role": "admin", "passwords": ("admin", "uoacnlab2026")},
        "user": {"role": "user", "passwords": ("9227f4f37950df", "uoacnlab2026")},
    }

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

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

    @staticmethod
    def _serializer(secret_key: str) -> URLSafeTimedSerializer:
        return URLSafeTimedSerializer(secret_key, salt=TOKEN_SALT)


def user_payload(user: AuthUser) -> dict[str, object]:
    return {
        "authenticated": True,
        "username": user.username,
        "role": user.role,
    }
