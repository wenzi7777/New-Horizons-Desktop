from __future__ import annotations

from typing import Any


# Older firmware reports these same boards as "VD-CTL/R ..." (before v1.8.0)
# or "TIA-CTL/R ..." (v1.8.0); normalize_hardware_model() folds both in.
V1_HARDWARE_MODEL = "TIA-CTL v1.0.F 2026.4"
V15F_HARDWARE_MODEL = "TIA-CTL v1.5.F 2026.7"
V21_GCU_HARDWARE_MODEL = "TIA-CTL v2.1 GCU LTS"
V22C_GCU_HARDWARE_MODEL = "TIA-CTL v2.2.C GCU LTS"
GCU_HARDWARE_MODEL = "TIA-CTL v2.3.D GCU LTS"

DEFAULT_BOARD_PROFILE = {
    "hardware_model": V1_HARDWARE_MODEL,
    "supports_external_led": True,
    "supports_oled": True,
    "supports_local_button_wake": True,
    "supports_charge_control": True,
    "power_ux": "local_button",
    "external_led_count": 3,
    "external_led_pin": 12,
}

V15F_BOARD_PROFILE = {
    "hardware_model": V15F_HARDWARE_MODEL,
    "supports_external_led": True,
    "supports_oled": True,
    "supports_local_button_wake": True,
    "supports_charge_control": True,
    "power_ux": "local_button",
    "default_manifest_url": "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v15f-latest.json",
    "default_analog_pins": list(range(1, 15)),
    "default_select_pins": [17, 18, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 45],
    "external_led_count": 9,
    "external_led_pin": 16,
}

V21_GCU_BOARD_PROFILE = {
    "hardware_model": V21_GCU_HARDWARE_MODEL,
    "supports_external_led": False,
    "supports_oled": False,
    "supports_local_button_wake": False,
    "supports_charge_control": False,
    "power_ux": "remote_only",
}

V22C_GCU_BOARD_PROFILE = {
    "hardware_model": V22C_GCU_HARDWARE_MODEL,
    "supports_external_led": False,
    "supports_oled": False,
    "supports_local_button_wake": False,
    "supports_charge_control": False,
    "power_ux": "remote_only",
}

GCU_BOARD_PROFILE = {
    "hardware_model": GCU_HARDWARE_MODEL,
    "supports_external_led": False,
    "supports_oled": False,
    "supports_local_button_wake": False,
    "supports_charge_control": True,
    "power_ux": "remote_only",
}

KNOWN_PROFILES = [
    V21_GCU_BOARD_PROFILE,
    V22C_GCU_BOARD_PROFILE,
    GCU_BOARD_PROFILE,
    V15F_BOARD_PROFILE,
    DEFAULT_BOARD_PROFILE,
]


def normalize_hardware_model(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    for legacy in ("vd-ctl/r", "tia-ctl/r"):
        if normalized.startswith(legacy):
            return "tia-ctl" + normalized[len(legacy):]
    return normalized


def board_profile_for_hardware_model(value: Any) -> dict[str, Any]:
    normalized = normalize_hardware_model(value)
    for profile in KNOWN_PROFILES:
        if normalize_hardware_model(profile["hardware_model"]) == normalized:
            return dict(profile)
    return dict(DEFAULT_BOARD_PROFILE)
