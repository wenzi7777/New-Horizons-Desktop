# VD-CTL/R v2.3.D GCU LTS

This wiki directory is the device-level documentation entry for the `VD-CTL/R v2.3.D GCU LTS` hardware family.

## Runtime Notes

- The device uses `New Horizons OS Arduino` with protocol `NHO/Arduino/1`.
- Matrix default layout is `15 x 15`.
- IMU packets keep the base 7-float payload and may append a 3-float `mag` block.
- This board does not expose the legacy local action button, external LED strip, or OLED path.
- OTA should point at the GCU-specific manifest track: `releases/arduino-gcu-v23d-lts-latest.json`.
