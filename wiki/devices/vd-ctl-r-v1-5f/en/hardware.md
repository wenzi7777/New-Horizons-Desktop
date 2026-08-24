# VD-CTL/R v1.5.F Hardware Reference

## Evidence and notation

Every item below is transcribed from `pcb/v1.5.F/SCH_Schematic1_1-P1_2026-08-23.png` (`Schematic1`, `P1`, `Ref_PDMS_Sensors_Controller_FPC_1.5.F`). `GPIO`, `GIN`, `SEL`, `VOUT3V3`, `VOUT5V`, `VBAT`, `SDA`, and `SCL` are schematic net names; pin numbers are the numbers shown beside the connector symbols.

> A net name is not an electrical rating or usage guarantee. In particular, `VOUT5V` does not specify an available current, and `BAT_ID` does not define a battery-identification rule.

## Core, analog, and select paths

| Item | Schematic evidence |
|---|---|
| MCU | U13: `ESP32-S3 MINI 1 N8` |
| Analog front end | `ADC Handlers` uses `TLV9064IRUCR`; output nets are `ADC1_0_GPIO1`–`ADC2_13_GPIO14` |
| Analog inputs | `GIN0`–`GIN13` |
| Digital selects | `SEL_0_GPIO17`–`SEL_13_GPIO45` |
| I²C | MCU labels `SDA` on IO40 and `SCL` on IO42 |
| External serial | `EXTERNAL_RX` on IO17 and `EXTERNAL_TX` on IO18 |
| Action button | `ACTION_BUTTON` on IO41; R27 10 kΩ pulls to `VCC_3V3` and SW1 (`B3U-1000P`) switches to ground |
| Status data | `STAT_GPIO46` feeds the system-status WS2812B DIN |

### Analog input mapping

| FPC1 net | ADC net |
|---|---|
| GIN0 | ADC1_0_GPIO1 |
| GIN1 | ADC1_1_GPIO2 |
| GIN2 | ADC1_2_GPIO3 |
| GIN3 | ADC1_3_GPIO4 |
| GIN4 | ADC1_4_GPIO5 |
| GIN5 | ADC1_5_GPIO6 |
| GIN6 | ADC1_6_GPIO7 |
| GIN7 | ADC1_7_GPIO8 |
| GIN8 | ADC1_8_GPIO9 |
| GIN9 | ADC1_9_GPIO10 |
| GIN10 | ADC2_10_GPIO11 |
| GIN11 | ADC2_11_GPIO12 |
| GIN12 | ADC2_12_GPIO13 |
| GIN13 | ADC2_13_GPIO14 |

### Digital-select mapping

| FPC2 net | MCU GPIO |
|---|---|
| SEL_0 | GPIO17 |
| SEL_1 | GPIO18 |
| SEL_2 | GPIO21 |
| SEL_3 | GPIO26 |
| SEL_4 | GPIO47 |
| SEL_5 | GPIO33 |
| SEL_6 | GPIO34 |
| SEL_7 | GPIO48 |
| SEL_8 | GPIO35 |
| SEL_9 | GPIO36 |
| SEL_10 | GPIO37 |
| SEL_11 | GPIO38 |
| SEL_12 | GPIO39 |
| SEL_13 | GPIO45 |

The `Anti-strapping Pull Down` block pulls `SEL_13_GPIO45` to GND through R11 (10 kΩ). Do not add an external pull-up to this path without checking the boot requirement.

## FPC connector pinout

Both connectors are labelled `FPC-05F-20PH20`. Pins 21 and 22 are wired to the ground symbol; only external pins 1–20 are listed. The vertical direction in the schematic symbol is not a promise of the physical board, cable, or enclosure “top”.

### FPC1 — Analog Features

| Pin | Net |
|---|---|
| 1–14 | GIN0–GIN13, in order |
| 15 | LED_ARRAY_GPIO16 |
| 16 | EXTERNAL_RX |
| 17 | EXTERNAL_TX |
| 18 | GND |
| 19 | VOUT3V3 |
| 20 | VOUT5V |

### FPC2 — Digital Features

| Pin | Net |
|---|---|
| 1–14 | SEL_0_GPIO17–SEL_13_GPIO45, in order |
| 15 | Not connected (no-connect mark) |
| 16 | SDA |
| 17 | SCL |
| 18 | GND |
| 19 | VOUT3V3 |
| 20 | VOUT5V |

## Sensors and status indication

| Block | Schematic evidence |
|---|---|
| IMU | U4: `BMI270`; SDX to `SDA`, SCX to `SCL` |
| Magnetometer | U7: `BMM350`; SDA / SCK on the shared I²C nets with `VCC_1V8` and `VCC_3V3` |
| Fuel gauge | U1: `MAX17048X+T10`; CELL and VDD to `VBAT`, SCL / SDA to I²C |
| System LED | U12: `WS2812B-2427-V6`; DIN from `STAT_GPIO46` through R4 (0 Ω) |
| Battery LED | U3: `WS2812B-2427-V6`; chained from U12 DOUT |

The schematic does not define LED colour meanings, sensor ranges, I²C addresses, or firmware polling rates. Confirm those with firmware or component documentation.

## Power, charging, and battery connectors

| Block | Schematic evidence |
|---|---|
| USB | `USB TypeC`, `Overcurrent Protection`, and `Native USB` blocks; native USB D+ / D− route to IO20 / IO19 |
| Charging | A `Battery Charger` block is present; charge current, termination voltage, and supported chemistry are not asserted here |
| Main 3.3 V | U8 `TLV75733PDRVR` in `Main Power Supply LDO & Switch` produces `VCC_3V3` |
| 1.8 V | U6 `TPS7A0218PDQNR` produces `VCC_1V8` from `VCC_3V3` |
| 5 V output | `5V_OUT Protection` includes D5 `1N5819HW-7-F` and F2 `SMD0805-010-33`; output net is `VOUT5V` |

### Main battery connector U9

U9 is labelled `YZ92015035T-04025-01`. R12 (10 kΩ) pulls `BAT_ID_ADC2_4_GPIO15` to `VCC_3V3`, with C10 (100 nF) to ground.

| Pin | Net |
|---|---|
| 1 | VBAT |
| 2 | BAT_THERMAL |
| 3 | GND |
| 4 | BAT_ID |

### Backup battery connector

CN2 is labelled `XH-2AWT` and is wired to `VBAT` and GND. The schematic does not define its operating role, battery type, or whether it may be used with the main battery.

## Not inferred from this schematic

- Physical FPC orientation, mating cable, or enclosure details.
- Available current, inrush capability, and external protection requirements of `VOUT3V3` / `VOUT5V`.
- Battery capacity, chemistry, or the actual `BAT_THERMAL` / `BAT_ID` interpretation.
- USB-C role, power negotiation, firmware behaviour, and button interactions.
- Sensor calibration, LED colours, or communication protocols not labelled in the sheet.
