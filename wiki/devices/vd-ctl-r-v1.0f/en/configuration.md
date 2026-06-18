# Device Configuration Reference

All configuration is persisted to `/config/device.json` on the device flash and loaded on every boot. Changes take effect immediately unless otherwise noted.

## Scan Timing

Controls how fast the key matrix is sampled and how data is sent.

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `target_fps` | 60 | 1–90 | Target matrix scan rate (frames per second) |
| `settle_us` | 20 | — | Microseconds to wait after activating a column before reading ADC |
| `send_every_n_frames` | 1 | 1–N | Send a UDP packet every N scanned frames |

```json
{
  "command": "set_scan_timing",
  "protocol": "NHO/Arduino/1",
  "target_fps": 60,
  "settle_us": 20,
  "send_every_n_frames": 1
}
```

## Stream Buffer (Ring Buffer)

The scan ring buffer queues packets for retry when a UDP send fails.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enabled` | true | Enable the ring buffer queue |
| `mode` | `"standard"` | Buffer mode: `standard` (3 frames) or `extended` (5 frames) |

```json
{
  "command": "set_stream_buffer",
  "protocol": "NHO/Arduino/1",
  "enabled": true,
  "mode": "standard"
}
```

## IMU

The v1.0.F board includes a BMI270 accelerometer + gyroscope. The `imu.enabled` flag controls BMI270 telemetry in live packets. A BMM150 magnetometer is not populated on this board, so `MAG_FLAG` and the `mag` payload are not available.

## External LED Strip

| Parameter | Default | Options | Description |
|-----------|---------|---------|-------------|
| `mode` | `"off"` | `off`, `on`, `auto` | LED strip operating mode |
| `preset` | `"stream_health"` | `stream_health` | Visual preset in `auto` mode |
| `brightness` | 0.35 | 0.0–1.0 | Strip brightness |

```json
{
  "command": "set_indicators",
  "protocol": "NHO/Arduino/1",
  "external_led": {"mode": "auto", "preset": "stream_health", "brightness": 0.35}
}
```

## OLED Display

| Parameter | Default | Options/Range | Description |
|-----------|---------|--------------|-------------|
| `mode` | `"off"` | `off`, `on`, `auto` | Display on/off/auto |
| `page` | `"live_status"` | `live_status`, `sensor_snapshot`, `log_status` | Content shown |
| `update_hz` | 1 | 1–N | Display refresh rate |
| `contrast` | 128 | 0–255 | Display brightness |
| `rotation` | 0 | 0, 1, 2, 3 | Display rotation (×90°) |

```json
{
  "command": "set_indicators",
  "protocol": "NHO/Arduino/1",
  "oled": {"mode": "on", "page": "live_status", "update_hz": 1, "contrast": 128, "rotation": 0}
}
```

## Logging

| Parameter | Default | Options | Description |
|-----------|---------|---------|-------------|
| `enabled` | true | true/false | Enable persistent log storage |
| `level` | `"info"` | `error`, `warn`, `info`, `debug` | Minimum log level to store |
| `mode` | `"standard"` | `standard` (12 KB), `extended` (24 KB) | Log storage size |

```json
{
  "command": "set_log",
  "protocol": "NHO/Arduino/1",
  "enabled": true,
  "level": "info",
  "mode": "standard"
}
```

Serial output always logs all levels regardless of this setting.

## OTA Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `auto_apply_on_boot` | true | Automatically check and apply updates at boot |
| `manifest_url` | GitHub URL | Manifest JSON URL |

See `ota-update.md` for the full OTA reference.

## Matrix Layout

Advanced: override the default GPIO pin assignments for rows and columns. This is normally set to board defaults and should not be changed unless you have custom hardware.

```json
{
  "command": "set_matrix_layout",
  "protocol": "NHO/Arduino/1",
  "analog_pins": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  "select_pins": [13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 40, 41]
}
```
