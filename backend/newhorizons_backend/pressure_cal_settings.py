from __future__ import annotations

import json
from pathlib import Path

_SETTINGS_PATH = Path(__file__).resolve().parents[2] / "data" / "pressure_cal_settings.json"

BUILTIN_PRESETS: dict[str, dict[str, str]] = {
    "lab_pi": {
        "label": "Lab Pi Server",
        "url": "https://pressure-cal.1205.moe",
        "token": "pcapi-QwJ7-NaiwqNwMPuusvwN7vsm2neLjGy6",
    },
}


def load_settings() -> dict:
    """Return stored settings: {preset, url, token}. Defaults to lab_pi."""
    try:
        with _SETTINGS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError
        # Migrate old format {url, token} → {preset: "custom", url, token}
        if "url" in data and "preset" not in data:
            return {"preset": "custom", "url": str(data.get("url", "")), "token": str(data.get("token", ""))}
        return {
            "preset": str(data.get("preset", "lab_pi")),
            "url": str(data.get("url", "")),
            "token": str(data.get("token", "")),
        }
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        pass
    return {"preset": "lab_pi", "url": "", "token": ""}


def save_settings(preset: str, url: str = "", token: str = "") -> None:
    """Persist preset and optional custom credentials."""
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _SETTINGS_PATH.open("w", encoding="utf-8") as f:
        json.dump({"preset": preset, "url": url, "token": token}, f, ensure_ascii=False, indent=2)


def resolve_credentials() -> tuple[str, str]:
    """Return (url, token) for the active preset or custom entry."""
    settings = load_settings()
    preset = settings.get("preset", "lab_pi")
    if preset in BUILTIN_PRESETS:
        p = BUILTIN_PRESETS[preset]
        return p["url"], p["token"]
    return settings.get("url", ""), settings.get("token", "")
