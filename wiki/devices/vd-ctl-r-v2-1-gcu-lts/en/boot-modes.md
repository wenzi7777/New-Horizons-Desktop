# Boot Modes

The firmware supports three operating modes. Because the v2.1 GCU LTS has **no physical action button**, mode entry uses an alternative method.

## Mode Summary

| Mode | LED Color | Description |
|------|-----------|-------------|
| Normal | Green (Online) after boot | Full operation: scanning, WiFi, IMU, streaming |
| Maintenance | Orange (solid) | Configuration, calibration, file transfer |
| Safe Maintenance | Magenta (solid) | Emergency fallback after repeated boot failures |

## Normal Mode

The default operating mode. All subsystems run: key matrix scanning, WiFi, BMI270+BMM150 IMU, UDP streaming, OTA, and the control server.

## Maintenance Mode

Enables calibration, file management, and layout change commands. This board has no button, so Maintenance cannot be entered by hardware — use the control command.

### Entering Maintenance Mode

**Via control command (only method for this board):**
```json
{"command": "enter_maintenance", "protocol": "NHO/Arduino/1"}
```

**Alternative — multi-cycle boot trigger:**
Power-cycle the device **5 consecutive times** within the startup window. On the 5th cycle the device enters Maintenance mode automatically. This allows recovery when the network is unavailable.

### Exiting Maintenance Mode

```json
{"command": "exit_maintenance", "protocol": "NHO/Arduino/1"}
```

Or reboot — the device returns to Normal by default.

## Safe Maintenance Mode

Entered automatically when the firmware detects **3 or more consecutive boot failures**. Only a subset of commands are available (WiFi setup, OTA, basic status).

### Recovery Steps

1. Connect to the device via TCP on port **22345**.
2. Check status: `{"command": "status", "protocol": "NHO/Arduino/1"}`
3. If configuration is corrupt, reset via file commands or `set_matrix_layout`.
4. Reboot: `{"command": "reboot", "protocol": "NHO/Arduino/1"}`

## WiFi Setup Mode

**Multi-cycle trigger (no button):** Power-cycle the device **5 consecutive times** within the 3-second startup detection window. On the 5th cycle the device broadcasts a WiFi setup AP.

- SSID: `NewHorizonsOS-<device_uid>`
- URL: `http://newhorizons.os` (or `http://192.168.4.1`)
