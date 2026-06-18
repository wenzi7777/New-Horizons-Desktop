# Hardware Reference

## Board Overview

| Item | Detail |
|------|--------|
| MCU | ESP32-S3 (dual-core Xtensa LX7, 240 MHz) |
| Flash | 4 MB |
| PSRAM | None |
| Board | VD-CTL/R v2.3.D GCU LTS |

## Key Matrix

| Parameter | Value |
|-----------|-------|
| Rows | 15 |
| Columns | 15 |
| Total sensors | 225 |
| Scan method | Column-select (MUX) + row ADC |

### Row ADC Pins (GPIO)

| Row | GPIO | Row | GPIO | Row | GPIO |
|-----|------|-----|------|-----|------|
| R0 | 1 | R5 | 6 | R10 | 11 |
| R1 | 2 | R6 | 7 | R11 | 12 |
| R2 | 3 | R7 | 8 | R12 | 13 |
| R3 | 4 | R8 | 9 | R13 | 14 |
| R4 | 5 | R9 | 10 | R14 | 15 |

### Column Select Pins (GPIO)

| Col | GPIO | Col | GPIO | Col | GPIO |
|-----|------|-----|------|-----|------|
| C0 | 16 | C5 | 21 | C10 | 41 |
| C1 | 17 | C6 | 35 | C11 | 42 |
| C2 | 18 | C7 | 36 | C12 | 45 |
| C3 | 19 | C8 | 37 | C13 | 46 |
| C4 | 20 | C9 | 39 | C14 | — |

> Actual column pins: `[16, 17, 18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45, 46]` — 15 columns total.

## I2C Bus

| Signal | GPIO | Speed |
|--------|------|-------|
| SCL | 47 | 1 MHz |
| SDA | 48 | 1 MHz |

Devices on the I2C bus: BMI270 IMU, BMM150 magnetometer, BQ25180 charger.

## GPIO Assignment Summary

| GPIO | Function |
|------|----------|
| 1–15 | Matrix row ADC inputs |
| 16–21, 35–42, 45–46 | Matrix column select (MUX) |
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
- Data in UDP packet: 3 floats (`mag[3]`) when `MAG_FLAG` (0x04) is set

### BQ25180 Charger
- Interface: I2C
- Charge profiles: `Balanced`, `Fast`, `UltraSlow`, `Slow`, `Extreme`
- Status: `NotCharging`, `ChargingOrMissing`, `ChargeDone`
- Note: no physical button on this board; power state is managed via `power_set_state` command

> There is no physical action button, external LED strip, or OLED display on this board.
