# VD-CTL/R v1.5.F

This is the hardware reference entry for VD-CTL/R v1.5.F. It records only connections, parts, and net names that can be checked in the schematic; operating procedures, ratings, I²C addresses, battery compatibility, and mechanical orientation are intentionally not inferred.

## Source and scope

- Schematic: workspace `pcb/v1.5.F/SCH_Schematic1_1-P1_2026-08-23.png`
- Sheet: `Schematic1`, page `P1`; title-block reference: `Ref_PDMS_Sensors_Controller_FPC_1.5.F`.
- This wiki treats that schematic as the source of hardware truth. Update it before user-facing guidance when the PCB or schematic changes.

## What the schematic explicitly shows

| Block | Verifiable content |
|---|---|
| MCU | `ESP32-S3 MINI 1 N8` |
| Analog inputs | `GIN0`–`GIN13`, routed as `ADC1_0_GPIO1`–`ADC2_13_GPIO14` |
| Digital selects | `SEL_0_GPIO17`–`SEL_13_GPIO45` |
| FPC | Two `FPC-05F-20PH20` connectors: FPC1 Analog Features and FPC2 Digital Features |
| Sensors | `BMI270` and `BMM350` on `SDA` / `SCL` |
| Battery | Main and backup battery connectors, `MAX17048X+T10` fuel gauge, and a Battery Charger block |
| Status LEDs | Two `WS2812B-2427-V6` devices labelled System Status and Battery Status |

See [Hardware reference](hardware.md) for GPIO, connector pins, power nets, and explicit limits of this document.
