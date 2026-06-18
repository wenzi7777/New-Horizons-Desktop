# Power Management and Charging

The v2.3.D GCU LTS includes a BQ25180 charger but has **no physical action button**. All power state transitions are command-driven.

## Power States

| State | CPU Frequency | Description |
|-------|--------------|-------------|
| Normal | 240 MHz | All subsystems active |
| SoftOffBattery | 80 MHz | Suspended on battery, light sleep every 5 s |
| SoftOffCharging | 80 MHz | Suspended while charging, light sleep every 2 s |

## Remote Power Control

Because there is no physical button, soft-off and wake are triggered only via control commands:

```json
{"command": "power_set_state", "protocol": "NHO/Arduino/1", "state": "soft_off"}
```

```json
{"command": "power_set_state", "protocol": "NHO/Arduino/1", "state": "normal"}
```

## Soft-Off Mode

While in soft-off, the firmware runs at reduced frequency and pauses scanning, WiFi, and IMU.

**While in soft-off (charging):**
- SK6812 shows `SoftOffCharging` (orange) or `SoftOffChargeDone` (teal)
- Light-sleep interval: 2 seconds

**While in soft-off (on battery):**
- SK6812 is off
- Light-sleep interval: 5 seconds

## Charging

### Charge States

| State | LED | Meaning |
|-------|-----|---------|
| `NotCharging` | — (follows runtime state) | Running on battery, no charger |
| `ChargingOrMissing` | Orange solid | Charger connected and charging, or battery not detected |
| `ChargeDone` | Teal solid | Battery fully charged |

### Charge Profiles

| Profile | Description |
|---------|-------------|
| `Balanced` | Default, safe for everyday use |
| `Fast` | Higher charge current, more heat |
| `Slow` | Conservative, good for overnight |
| `UltraSlow` | Minimal current, ideal for old cells |
| `Extreme` | Maximum current — use with caution |

```json
{
  "command": "set_charge_profile",
  "protocol": "NHO/Arduino/1",
  "profile": "Balanced"
}
```

### Battery Data in Sensor Packets

When `BATTERY_FLAG` (0x02) is set in the packet header:

| Byte | Field | Description |
|------|-------|-------------|
| 0 | `status` | BQ25180 status register |
| 1 | `fault` | BQ25180 fault register |
| 2–3 | `vbat_mv` | Battery voltage in millivolts (LE uint16) |
