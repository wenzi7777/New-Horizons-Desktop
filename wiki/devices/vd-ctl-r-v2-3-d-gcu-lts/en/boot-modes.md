# Boot Modes

The firmware supports three operating modes. Because the v2.3.D GCU LTS has **no physical action button**, mode entry uses command or multi-cycle boot methods.

## Mode Summary

| Mode | LED Color | Description |
|------|-----------|-------------|
| Normal | Green (Online) after boot | Full operation: scanning, WiFi, IMU, streaming |
| Maintenance | Orange (solid) | Configuration, calibration, file transfer |
| Safe Maintenance | Magenta (solid) | Emergency fallback after repeated boot failures |

## Normal Mode

The default operating mode. All subsystems run: key matrix scanning (15×15), WiFi, BMI270+BMM150 IMU, UDP streaming, OTA, and the control server.

## Maintenance Mode

### Entering Maintenance Mode

**Via control command (primary method):**
```json
{"command": "enter_maintenance", "protocol": "NHO/Arduino/1"}
```

**Multi-cycle boot trigger (offline recovery):**
Power-cycle the device **5 consecutive times** within the 3-second startup window. On the 5th cycle the device enters Maintenance automatically.

### Exiting Maintenance Mode

```json
{"command": "exit_maintenance", "protocol": "NHO/Arduino/1"}
```

Or reboot — the device returns to Normal by default.

## Safe Maintenance Mode

Triggered automatically after **3 consecutive boot failures**. Limited to WiFi setup, OTA, and basic status commands.

### Recovery Steps

1. Connect via TCP on port **22345**.
2. Check status: `{"command": "status", "protocol": "NHO/Arduino/1"}`
3. Reset configuration or delete `/config/device.json` via file commands if needed.
4. Reboot: `{"command": "reboot", "protocol": "NHO/Arduino/1"}`

## WiFi Setup Mode

**Multi-cycle trigger:** Power-cycle the device **5 consecutive times** within the 3-second startup window. On the 5th cycle the device broadcasts a WiFi setup AP.

- SSID: `NewHorizonsOS-<device_uid>`
- URL: `http://newhorizons.os` (or `http://192.168.4.1`)
