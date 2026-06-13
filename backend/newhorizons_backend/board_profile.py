from __future__ import annotations

from typing import Any


V1_HARDWARE_MODEL = "VD-CTL/R v1.0.F 2026.4"
V21_GCU_HARDWARE_MODEL = "VD-CTL/R v2.1 GCU LTS"
GCU_HARDWARE_MODEL = "VD-CTL/R v2.3.D GCU LTS"

DEFAULT_BOARD_PROFILE = {
    "hardware_model": V1_HARDWARE_MODEL,
    "supports_external_led": True,
    "supports_oled": True,
    "supports_local_button_wake": True,
    "supports_charge_control": True,
    "power_ux": "local_button",
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
    DEFAULT_BOARD_PROFILE,
]


def board_profile_for_hardware_model(value: Any) -> dict[str, Any]:
    normalized = str(value or "").strip().lower()
    for profile in KNOWN_PROFILES:
        if str(profile["hardware_model"]).strip().lower() == normalized:
            return dict(profile)
    return dict(DEFAULT_BOARD_PROFILE)
