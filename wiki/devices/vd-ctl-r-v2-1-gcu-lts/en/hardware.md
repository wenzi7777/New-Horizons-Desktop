# Hardware Reference

## Board Overview

| Item | Detail |
|------|--------|
| MCU | ESP32-S3 (dual-core Xtensa LX7, 240 MHz) |
| Flash | 4 MB |
| PSRAM | None |
| Board | VD-CTL/R v2.1 GCU LTS |

## Key Matrix

| Parameter | Value |
|-----------|-------|
| Rows | 10 |
| Columns | 12 |
| Total sensors | 120 |
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
| C0 | 18 | C4 | 36 | C8 | 41 |
| C1 | 19 | C5 | 37 | C9 | 42 |
| C2 | 20 | C6 | 39 | C10 | 45 |
| C3 | 21 | C7 | 40 | C11 | — |

> Actual column pins: `[18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45]` — 12 columns total.

## I2C Bus

| Signal | GPIO | Speed |
|--------|------|-------|
| SCL | 47 | 1 MHz |
| SDA | 48 | 1 MHz |

Devices on the I2C bus: BMI270 IMU, BMM150 magnetometer.

## GPIO Assignment Summary

| GPIO | Function |
|------|----------|
| 1–10 | Matrix row ADC inputs |
| 18–21, 35–42, 45 | Matrix column select (MUX) |
| 38 | Status SK6812 LED (data) |
| 47 | I2C SCL |
| 48 | I2C SDA |

## Peripherals

### SK6812 Status LED
- GPIO: 38
- Single addressable LED for system status feedback (see `led-status.md`)

### BMI270 IMU
- Interface: I2C
- Axes: 3-axis accelerometer + 3-axis gyroscope
- Sample rate: 100 Hz
- Data in UDP packet: 7 floats (`acc[3]`, `gyro[3]`, `temperature_c`)

### BMM150 Magnetometer
- Interface: I2C (auxiliary to BMI270)
- Axes: 3-axis
- Data in UDP packet: additional 3 floats (`mag[3]`) when `MAG_FLAG` (0x04) is set

> There is no physical action button, external LED strip, OLED display, or BQ25180 charger on this board.
