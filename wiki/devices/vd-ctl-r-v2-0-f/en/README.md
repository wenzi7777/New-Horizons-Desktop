# TIA-CTL v2.0.F

Hardware reference for TIA-CTL v2.0.F (silkscreen `TIA-CTL/A v2.0.F 2026.10`). Only facts checked against the final EasyEDA export (PCB netlist, 2026-11-11) are listed; procedures and measured values are not assumed.

## Same as v1.5.F

- ESP32-S3 MINI-1 N8; 14 × 14 matrix: rows GPIO1–14, columns GPIO17, 18, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 45.
- BQ25180 charger, MAX17048 (TDFN), BMI270, BMM350, Action Button, two status WS2812B (System / Battery), nine external LEDs (GPIO16).
- The firmware shares v1.5.F's pin table.

## New or changed in v2.0.F

| Item | Detail |
|---|---|
| Vref | MCP4725 DAC (I²C 0x60, A0 to GND) → 1 kΩ → Vref node (op-amp non-inverting inputs, 100 nF). Fixed at 330 mV after power-on and every reboot; **no pin can read Vref back**. |
| Calibration switch | PCA9536 (I²C 0x41) IO0 → Q1 (DMG1012T, gate pulled down by 2.2 kΩ). With Q1 on, fourteen 10 kΩ 0.1 % resistors tie each GIN to CAL. IO1–IO3 are unconnected. |
| Rfb | Rfb0–Rfb13 0805 pads on the back, not populated at the factory; the value is the user's choice. |
| GPIO45 | R27 100 kΩ pull-down (boot strap). With Vref above about 0.8 V a reboot can fail to boot. |
| Battery | Side-pressure spring contact on the back (1 GND / 2 VBAT / 3 BAT_ID); a spare JST on the front (CN2, not fitted by default). BAT_ID is GPIO15 with R3 + R5 = 200 kΩ pull-up; ID resistors on the battery side of 39 k / 68 k / 100 k / 150 k mean 200 / 400 / 500 / 600 mAh, and without one (JST) the battery is set by hand. |
| USB | One USB-C (USB2); the USB-C for the battery module on the back is gone. |

The firmware reads BAT_ID once at boot (GPIO15 is on ADC2, shared with Wi-Fi).
