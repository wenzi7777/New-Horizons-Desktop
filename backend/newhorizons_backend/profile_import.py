from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


DEFAULT_MATRIX_ROWS = 10
DEFAULT_MATRIX_COLS = 21
DEFAULT_PRESSURE_MIN = 300
DEFAULT_PRESSURE_MAX = 1000
DEFAULT_DOT_SIZE = 1.0


def sanitize_profile_name(value: str) -> str:
    text = (value or "").strip() or "profile"
    return "".join(char if char.isalnum() or char in {"_", "-"} else "_" for char in text)


def _number_or(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _infer_profile_shape(profile_stem: str) -> tuple[str, int, int]:
    lowered = profile_stem.lower()
    device_type = "glove" if "glove" in lowered else "insole" if "insole" in lowered else "custom"
    match = re.search(r"_(\d+)_(\d+)$", profile_stem)
    if not match:
        return device_type, DEFAULT_MATRIX_ROWS, DEFAULT_MATRIX_COLS
    rows = max(1, int(match.group(1)))
    cols = max(1, int(match.group(2)))
    return device_type, rows, cols


def normalize_legacy_profile(data: dict[str, Any], *, profile_stem: str) -> dict[str, Any]:
    background = data.get("background")
    background = background if isinstance(background, dict) else {}
    display = data.get("display")
    display = display if isinstance(display, dict) else {}
    sensors = data.get("sensors")
    sensors = sensors if isinstance(sensors, list) else []

    device_type, rows, cols = _infer_profile_shape(profile_stem)
    pressure_min = int(_number_or(display.get("pressureMin", display.get("pressure_min")), DEFAULT_PRESSURE_MIN))
    pressure_max = int(_number_or(display.get("pressureMax", display.get("pressure_max")), DEFAULT_PRESSURE_MAX))
    pressure_max = max(pressure_max, pressure_min + 1)
    dot_size = _clamp(_number_or(display.get("dotSize", display.get("dot_size")), DEFAULT_DOT_SIZE), 0.5, 4.0)

    normalized_sensors: list[dict[str, Any]] = []
    for index, raw_sensor in enumerate(sensors):
        sensor = raw_sensor if isinstance(raw_sensor, dict) else {}
        normalized_sensors.append(
            {
                "index": max(0, int(_number_or(sensor.get("index"), index))),
                "x": round(_clamp(_number_or(sensor.get("x"), 0.5), 0.0, 1.0), 6),
                "y": round(_clamp(_number_or(sensor.get("y"), 0.5), 0.0, 1.0), 6),
                "label": str(sensor.get("label") or f"P{index}"),
                "enabled": sensor.get("enabled", True) is not False,
            }
        )

    return {
        "version": max(1, int(_number_or(data.get("version"), 1))),
        "name": str(data.get("name") or profile_stem),
        "deviceType": str(data.get("deviceType") or device_type),
        "matrix": {
            "rows": rows,
            "cols": cols,
        },
        "activeRows": list(data.get("activeRows") or []),
        "activeCols": list(data.get("activeCols") or []),
        "background": {
            "imageData": str(background.get("imageData") or ""),
            "aspectRatio": max(0.01, _number_or(background.get("aspectRatio"), 1.0)),
        },
        "sensors": normalized_sensors,
        "display": {
            "mode": "2d" if display.get("mode") == "2d" else "3d",
            "pressureMin": pressure_min,
            "pressureMax": pressure_max,
            "dotSize": round(dot_size, 2),
        },
        "notes": str(data.get("notes") or ""),
    }


def import_legacy_profiles(source_dir: Path, target_dir: Path) -> list[dict[str, Any]]:
    imported: list[dict[str, Any]] = []
    target_dir.mkdir(parents=True, exist_ok=True)
    for source_path in sorted(source_dir.glob("*.json")):
        data = json.loads(source_path.read_text(encoding="utf-8"))
        profile_name = sanitize_profile_name(source_path.stem)
        normalized = normalize_legacy_profile(data, profile_stem=source_path.stem)
        target_path = target_dir / f"{profile_name}.json"
        target_path.write_text(json.dumps(normalized, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        imported.append(
            {
                "source": str(source_path),
                "target": str(target_path),
                "name": normalized["name"],
                "sensor_count": len(normalized["sensors"]),
            }
        )
    return imported
