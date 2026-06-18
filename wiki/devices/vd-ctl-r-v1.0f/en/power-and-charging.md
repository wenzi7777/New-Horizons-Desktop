# Power Management and Charging

## Power States

| State | CPU Frequency | Description |
|-------|--------------|-------------|
| Normal | 240 MHz | All subsystems active |
| SoftOffBattery | 80 MHz | Suspended on battery, light sleep every 5 s |
| SoftOffCharging | 80 MHz | Suspended while charging, light sleep every 2 s |

## Action Button Behavior

| Input | Duration | Action |
|-------|----------|--------|
| Short press | 50–500 ms | Wake from soft-off; in normal mode, no-op |
| Long press | ≥ 1500 ms | From normal: trigger shutdown animation → soft-off; from soft-off: no effect (wake is short-press only) |

## Soft-Off Mode

Soft-off is a low-power suspended state — the firmware continues running at reduced frequency but pauses scanning, WiFi, and IMU.

**Entering soft-off:**
1. Long-press the action button in Normal mode.
2. The `PowerTransitionShutdown` LED animation plays (white fade-out).
3. After animation completes, the device enters `SoftOffBattery` or `SoftOffCharging` depending on charger state.

**While in soft-off:**
- Battery: SK6812 is off; device light-sleeps for 5-second intervals.
- Charging: SK6812 shows `SoftOffCharging` (orange) or `SoftOffChargeDone` (teal); light-sleep is 2 seconds.

**Waking from soft-off:**
1. Short-press the action button.
2. The `PowerTransitionWake` LED animation plays (white rise).
3. All subsystems resume; device returns to Normal mode.

**Remote power control (via command):**
```json
{"command": "power_set_state", "protocol": "NHO/Arduino/1", "state": "soft_off"}
```
```json
{"command": "power_set_state", "protocol": "NHO/Arduino/1", "state": "normal"}
```

## Charging

The BQ25180 IC manages battery charging. Charge state is reflected in the status LED and reported in sensor packets (`battery` field).

### Charge States

| State | LED | Meaning |
|-------|-----|---------|
| `NotCharging` | — (follows runtime state) | Running on battery, no charger connected |
| `ChargingOrMissing` | Orange solid | Charger connected and charging; or battery not detected |
| `ChargeDone` | Teal solid | Battery fully charged |

### Charge Profiles

Set via `set_charge_profile` command:

| Profile | Description |
|---------|-------------|
| `Balanced` | Default, safe for everyday use |
| `Fast` | Higher charge current, more heat |
| `Slow` | Conservative, good for overnight charging |
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

When the `BATTERY_FLAG` (0x02) is set in the packet header, the payload contains:

| Byte | Field | Description |
|------|-------|-------------|
| 0 | `status` | BQ25180 status register |
| 1 | `fault` | BQ25180 fault register |
| 2–3 | `vbat_mv` | Battery voltage in millivolts (little-endian uint16) |
