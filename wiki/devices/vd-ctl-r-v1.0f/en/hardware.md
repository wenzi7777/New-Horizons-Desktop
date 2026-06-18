# Hardware Reference

## Board Overview

| Item | Detail |
|------|--------|
| MCU | ESP32-S3 Mini 1 N8 (dual-core Xtensa LX7, 240 MHz) |
| Flash | 8 MB |
| PSRAM | None |
| Board | VD-CTL/R v1.0.F 2026.4 |
| FQBN | `esp32:esp32:esp32s3:FlashSize=8M,PartitionScheme=default_8MB` |

## Key Matrix

| Parameter | Value |
|-----------|-------|
| Rows | 10 |
| Columns | 21 |
| Total sensors | 210 |
| Scan method | Column-select (MUX) + row ADC |

### Row ADC Pins (GPIO)

| Row | GPIO |
|-----|------|
| R0 | 1 |
| R1 | 2 |
| R2 | 3 |
| R3 | 4 |
| R4 | 5 |
| R5 | 6 |
| R6 | 7 |
| R7 | 8 |
| R8 | 9 |
| R9 | 10 |

### Column Select Pins (GPIO)

| Col | GPIO | Col | GPIO | Col | GPIO |
|-----|------|-----|------|-----|------|
| C0 | 13 | C7 | 33 | C14 | 38 |
| C1 | 14 | C8 | 34 | C15 | 39 |
| C2 | 15 | C9 | 48 | C16 | 40 |
| C3 | 16 | C10 | 35 | C17 | 41 |
| C4 | 17 | C11 | 36 | C18 | — |
| C5 | 18 | C12 | 37 | C19 | — |
| C6 | 26 | C13 | 47 | C20 | — |

> Note: Actual column pins are `[13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 40, 41]` — 21 columns total.

## I2C Bus

| Signal | GPIO | Speed |
|--------|------|-------|
| SCL | 42 | 400 kHz |
| SDA | 45 | 400 kHz |

Devices on the I2C bus: SSD1306 OLED, BMI270 IMU, BQ25180 charger. A BMM150 magnetometer is not populated on v1.0.F.

## GPIO Assignment Summary

| GPIO | Function |
|------|----------|
| 1–10 | Matrix row ADC inputs |
| 11 | Status SK6812 LED (data) |
| 12 | External WS2812B LED strip (data) |
| 13–21, 26, 33–41, 47–48 | Matrix column select (MUX) |
| 42 | I2C SCL |
| 45 | I2C SDA |
| 46 | Action button (active-low) |

## Peripherals

### SK6812 Status LED
- GPIO: 11
- Single addressable LED for system status feedback (see `led-status.md`)

### External WS2812B LED Strip
- GPIO: 12
- 3 addressable pixels
- Configurable via `set_indicators` command (mode: `off`, `on`, `auto`)

### SSD1306 OLED
- Interface: I2C (address 0x3C typical)
- Resolution: 128×64 pixels
- Configurable via `DeviceConfig.oled`: mode, page, update Hz, contrast, rotation

### BMI270 IMU
- Interface: I2C
- Provides accelerometer, gyroscope, and temperature telemetry
- BMM150 magnetometer is not populated on v1.0.F, so magnetometer payload is unavailable

### Action Button
- GPIO: 46, active-low
- Short press (50–500 ms): wake from soft-off
- Long press (≥ 1500 ms): enter/trigger maintenance or shutdown
- Press during boot window (first 3 s): enter WiFi setup

### BQ25180 Charger
- Interface: I2C
- Charge profiles: `Balanced`, `Fast`, `UltraSlow`, `Slow`, `Extreme`
- Status: `NotCharging`, `ChargingOrMissing`, `ChargeDone`
