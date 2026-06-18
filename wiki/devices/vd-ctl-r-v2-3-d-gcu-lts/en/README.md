# VD-CTL/R v2.3.D GCU LTS

The VD-CTL/R v2.3.D GCU LTS is the latest GCU variant in the New Horizons family. It features a large 15×15 pressure sensor matrix, BMI270 IMU with BMM150 magnetometer, BQ25180 battery charging, and a single on-board status LED. It has no physical action button, no external LED strip, and no OLED display.

## Specifications

| Item | Value |
|------|-------|
| MCU | ESP32-S3 |
| Flash | 4 MB |
| Board revision | VD-CTL/R v2.3.D GCU LTS |
| Key matrix | 15 rows × 15 columns (225 sensors) |
| Status LED | SK6812 (on-board, GPIO 38) |
| External LED | None |
| OLED | None |
| I2C | SCL GPIO 47 · SDA GPIO 48 · 1 MHz |
| Action button | None |
| IMU | BMI270 + BMM150 |
| Charger | BQ25180 |
| Protocol | NHO/Arduino/1 |
| Firmware | New Horizons OS Arduino v0.9.0 |
| OTA manifest | `arduino-gcu-v23d-lts-latest.json` |

## OTA Manifest URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v23d-lts-latest.json
```

## Supported Features

- On-board SK6812 status LED
- BMI270 6-axis IMU (accelerometer + gyroscope) at 100 Hz
- BMM150 3-axis magnetometer (additional 3-float payload block)
- BQ25180 battery charging with selectable charge profiles
- Remote power control via `power_set_state` command (no physical button)
- Full `DeviceConfig` support: scan timing, stream buffer, logging, OTA
- No external LED or OLED
