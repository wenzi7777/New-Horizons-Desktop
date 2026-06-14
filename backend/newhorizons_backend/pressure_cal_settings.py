from __future__ import annotations

import json
from pathlib import Path

_SETTINGS_PATH = Path(__file__).resolve().parents[2] / "data" / "pressure_cal_settings.json"

_DEFAULT: dict[str, str] = {"url": "", "token": ""}


def load_settings() -> dict[str, str]:
    """Read pressure calibration API settings from JSON file.

    Returns a dict with keys ``url`` and ``token``.
    If the settings file does not exist, returns empty strings for both.
    """
    if not _SETTINGS_PATH.exists():
        return dict(_DEFAULT)
    try:
        with _SETTINGS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return {
            "url": str(data.get("url", "")),
            "token": str(data.get("token", "")),
        }
    except (json.JSONDecodeError, OSError):
        return dict(_DEFAULT)


def save_settings(url: str, token: str) -> None:
    """Save pressure calibration API settings to JSON file.

    Creates parent directories if they do not exist.
    """
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _SETTINGS_PATH.open("w", encoding="utf-8") as f:
        json.dump({"url": url, "token": token}, f, ensure_ascii=False, indent=2)
