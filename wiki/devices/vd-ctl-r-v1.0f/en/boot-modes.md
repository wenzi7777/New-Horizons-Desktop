# Boot Modes

The firmware supports three operating modes. The active mode is determined at startup and persists until the next reboot.

## Mode Summary

| Mode | LED Color | Description |
|------|-----------|-------------|
| Normal | Green (Online) after boot | Full operation: scanning, WiFi, streaming |
| Maintenance | Orange (solid) | Configuration, calibration, file transfer |
| Safe Maintenance | Magenta (solid) | Emergency fallback after repeated boot failures |

## Normal Mode

The default operating mode. All subsystems run: key matrix scanning, WiFi, IMU (if present), UDP streaming, OTA, and the control server. LED progresses from Boot → WifiConnecting → FindMePending → Online as the device comes up.

## Maintenance Mode

Enables additional commands for calibration, file management, and layout changes. Scanning and UDP streaming continue but are secondary to maintenance operations.

### Entering Maintenance Mode (from Normal)

**Via action button:**
- Press and hold the action button for **≥ 1500 ms** (long press) while the device is powered on.

**Via control command:**
```json
{"command": "enter_maintenance", "protocol": "NHO/Arduino/1"}
```

### Exiting Maintenance Mode

```json
{"command": "exit_maintenance", "protocol": "NHO/Arduino/1"}
```

Or simply reboot the device — it returns to Normal by default.

## Safe Maintenance Mode

Entered automatically when the firmware detects **3 or more consecutive boot failures**. This prevents a bad configuration from rendering the device unrecoverable. Only a subset of commands are available (WiFi setup, OTA, basic status).

### How It Is Triggered

A boot failure counter is incremented each time the device starts. The counter is reset only after a fully successful boot (matrix scanning active). If it reaches **3**, the next boot enters Safe Maintenance instead of Normal.

### Recovery Steps

1. Connect to the device via the Desktop app or a TCP client on port **22345**.
2. Check status: `{"command": "status", "protocol": "NHO/Arduino/1"}`
3. If configuration is corrupt, reset it: `{"command": "set_matrix_layout", ...}` or delete `/config/device.json` via file commands.
4. Reboot: `{"command": "reboot", "protocol": "NHO/Arduino/1"}`

## WiFi Setup Mode

Used when no WiFi credentials are stored, or explicitly triggered.

**Trigger via button:** Press and hold the action button during the **first 3 seconds** of boot (setup detection window). The LED turns amber (WifiSetup) and the device broadcasts an AP named `NewHorizonsOS-<UID>`.

**Connect to portal:**
- SSID: `NewHorizonsOS-<device_uid>`
- URL: `http://newhorizons.os` (or `http://192.168.4.1`)
