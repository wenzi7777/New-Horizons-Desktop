# VD-CTL/R v2.1 GCU LTS

The VD-CTL/R v2.1 GCU LTS is a compact GCU (General Control Unit) variant in the New Horizons family. It features a 10×12 pressure sensor matrix, BMI270 IMU with BMM150 magnetometer, and a single on-board status LED. It has no physical action button, no external LED strip, and no OLED display.

## Specifications

| Item | Value |
|------|-------|
| MCU | ESP32-S3 |
| Flash | 4 MB |
| Board revision | VD-CTL/R v2.1 GCU LTS |
| Key matrix | 10 rows × 12 columns (120 sensors) |
| Status LED | SK6812 (on-board, GPIO 38) |
| External LED | None |
| OLED | None |
| I2C | SCL GPIO 47 · SDA GPIO 48 · 1 MHz |
| Action button | None |
| IMU | BMI270 + BMM150 |
| Charger | None (BQ25180 not present) |
| Protocol | NHO/Arduino/1 |
| Firmware | New Horizons OS Arduino v0.9.0 |
| OTA manifest | `arduino-gcu-v21-lts-latest.json` |

## OTA Manifest URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v21-lts-latest.json
```

## Supported Features

- On-board SK6812 status LED
- BMI270 6-axis IMU (accelerometer + gyroscope) at 100 Hz
- BMM150 3-axis magnetometer (additional 3-float payload block)
- Remote power control via `power_set_state` command (no physical button)
- Full `DeviceConfig` support: scan timing, stream buffer, logging, OTA
- No charging management (no BQ25180)
- No external LED or OLED
