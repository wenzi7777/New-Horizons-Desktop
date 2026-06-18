# OTA Firmware Update

The device supports over-the-air firmware updates using a JSON manifest file hosted on GitHub.

## Manifest URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v23d-lts-latest.json
```

## Auto-Update on Boot

By default (`autoApplyOnBoot: true`), the device checks the manifest URL on every boot (after WiFi connects). If a newer version is available, it downloads and flashes the firmware automatically, then reboots.

LED during update: **Cyan breathing** (`OtaActive`)
LED on success: **Green blink burst** (`OtaSuccess`)
LED on failure: **Red solid** (`OtaError`)

## Manual Update via Control Command

```json
{"command": "check_update", "protocol": "NHO/Arduino/1"}
```

```json
{"command": "apply_update", "protocol": "NHO/Arduino/1"}
```

## Configuring OTA

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
