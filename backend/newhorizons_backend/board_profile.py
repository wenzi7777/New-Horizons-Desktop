from __future__ import annotations

from typing import Any


V1_HARDWARE_MODEL = "VD-CTL/R v1.0.F 2026.4"
V15F_HARDWARE_MODEL = "VD-CTL/R v1.5.F 2026.7"
V21_GCU_HARDWARE_MODEL = "VD-CTL/R v2.1 GCU LTS"
GCU_HARDWARE_MODEL = "VD-CTL/R v2.3.D GCU LTS"

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
    GCU_BOARD_PROFILE,
    V15F_BOARD_PROFILE,
    DEFAULT_BOARD_PROFILE,
]


def board_profile_for_hardware_model(value: Any) -> dict[str, Any]:
    normalized = str(value or "").strip().lower()
    for profile in KNOWN_PROFILES:
        if str(profile["hardware_model"]).strip().lower() == normalized:
            return dict(profile)
    return dict(DEFAULT_BOARD_PROFILE)
