# VD-CTL/R v1.0.F

This wiki directory is the device-level documentation entry for the `VD-CTL/R v1.0.F 2026.4` hardware family.

## Key References
- `sk6812-status.md` covers the board `SK6812` indicator meanings.
- The device uses `New Horizons OS Arduino` with protocol `NHO/Arduino/1`.
- External `WS2812B`, OLED, and soft power transitions follow the current firmware release behavior.

## Current Behavior Notes
- Short press from soft-off wakes the device and shows a wake animation.
- Long press from normal mode plays a shutdown animation before entering soft-off.
- Persistent log storage defaults to `enabled`, `standard`, and `error`, while Serial still prints all runtime logs.
