"""Module-level names service.py and its mixins share.

Re-exported by service.py, which is where api.py and ws.py import them from.
"""
from __future__ import annotations


DEVICE_CONTROL_UNAVAILABLE = "device_control_unavailable"
DEVICE_CONTROL_UNAVAILABLE_MESSAGE = "Device control is reconnecting; try again in a few seconds."
DEVICE_BOOTING = "device_booting"
DEVICE_BOOTING_MESSAGE = "Device is rebooting; control will resume when it comes back online."
GATEWAY_CONTROL_UNAVAILABLE = "gateway_control_unavailable"
GATEWAY_CONTROL_UNAVAILABLE_MESSAGE = "This Hub/Gateway isn't connected right now; try again once it's online."


def command_error_message(code: str) -> str:
    if code == DEVICE_BOOTING:
        return DEVICE_BOOTING_MESSAGE
    if code == DEVICE_CONTROL_UNAVAILABLE:
        return DEVICE_CONTROL_UNAVAILABLE_MESSAGE
    if code == GATEWAY_CONTROL_UNAVAILABLE:
        return GATEWAY_CONTROL_UNAVAILABLE_MESSAGE
    return code


DEFAULT_DEVICE_NAME_PREFIX = "NHOS-"
# Firmware before v1.0.0 reported "New Horizons OS-<UID>" as its default name.
# Those devices stay in the field (and on show) long after the desktop updates,
# so the old prefix must keep counting as "still the default name" -- otherwise
# their card would show the factory name over a nickname the user had set.
LEGACY_DEFAULT_DEVICE_NAME_PREFIXES = ("New Horizons OS-",)
DEFAULT_DEVICE_NAME_PREFIXES = (
    DEFAULT_DEVICE_NAME_PREFIX,
) + LEGACY_DEFAULT_DEVICE_NAME_PREFIXES


# The mock seeds the v1.1+ app slot/package model, so it has to report a
# firmware new enough for the UI to show it; v0.5.0 hid the whole Apps UI.
MOCK_FIRMWARE_VERSION = "v1.2.2"
