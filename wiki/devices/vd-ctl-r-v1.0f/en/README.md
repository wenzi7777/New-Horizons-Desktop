# VD-CTL/R v1.0.F 2026.4

The VD-CTL/R v1.0.F 2026.4 is the primary consumer hardware revision in the New Horizons family. It features a full-size key matrix, built-in status LED, external addressable LED strip, OLED display, physical action button, and BQ25180-based charging circuitry.

## Specifications

| Item | Value |
|------|-------|
| MCU | ESP32-S3 Mini 1 N8 |
| Flash | 8 MB |
| Board revision | VD-CTL/R v1.0.F 2026.4 |
| Key matrix | 10 rows × 21 columns (210 sensors) |
| Status LED | SK6812 (on-board, GPIO 11) |
| External LED | WS2812B-compatible strip (GPIO 12, 3 pixels) |
| OLED | SSD1306 128×64, I2C |
| I2C | SCL GPIO 42 · SDA GPIO 45 · 400 kHz |
| Action button | GPIO 46 |
| Charger | BQ25180 |
| Protocol | NHO/Arduino/1 |
| Firmware | New Horizons OS Arduino v0.9.0 |
| OTA manifest | `arduino-v10f-latest.json` |

## OTA Manifest URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v10f-latest.json
```

## Supported Features

- On-board SK6812 status LED with full animation support
- External WS2812B LED strip (3 pixels, configurable mode and brightness)
- SSD1306 OLED display (configurable page, contrast, rotation, update rate)
- Physical action button for wake, maintenance entry, and WiFi setup
- BQ25180 battery charging with selectable charge profiles
- Soft-off / soft-wake power transitions with animations
- IMU is not present on this board
- Full `DeviceConfig` support: scan timing, stream buffer, logging, OTA
