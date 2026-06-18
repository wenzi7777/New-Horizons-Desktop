# OTA Firmware Update

The device supports over-the-air firmware updates using a JSON manifest file hosted on GitHub.

## Manifest URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v10f-latest.json
```

The manifest is a JSON file containing the firmware version, binary download URL, SHA-256 hash, and file size.

## Auto-Update on Boot

By default (`autoApplyOnBoot: true`), the device checks the manifest URL on every boot (after WiFi connects). If a newer version is available, it downloads and flashes the firmware automatically, then reboots.

LED during update: **Cyan breathing** (`OtaActive`)
LED on success: **Green blink burst** (`OtaSuccess`)
LED on failure: **Red solid** (`OtaError`)

## Manual Update via Control Command

To check for an update without applying it:
```json
{"command": "check_update", "protocol": "NHO/Arduino/1"}
```

Response includes `available`, `version`, `url`, `sha256`, and `size`.

To apply a pending update immediately:
```json
{"command": "apply_update", "protocol": "NHO/Arduino/1"}
```

## Configuring OTA

To change the manifest URL or disable auto-update:
```json
{
  "command": "set_ota_config",
  "protocol": "NHO/Arduino/1",
  "auto_apply_on_boot": false,
  "manifest_url": "https://example.com/custom-manifest.json"
}
```

## Download Timeouts

| Parameter | Value |
|-----------|-------|
| Chunk size | 4096 bytes |
| Idle timeout | 15 000 ms |
| Overall timeout | 180 000 ms (3 minutes) |

If the download stalls for more than 15 seconds, or the total download exceeds 3 minutes, the update is aborted and `OtaError` is displayed.

## Version Format

Firmware versions follow the format `vMAJOR.MINOR.PATCH` (e.g., `v0.9.0`). The device compares the manifest version string against its compiled-in `kFirmwareVersion` constant to decide if an update is needed.
