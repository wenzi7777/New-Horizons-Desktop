# NHO/Arduino/1 Protocol Reference

The device communicates over UDP using the `NHO/Arduino/1` protocol for sensor data streaming, and a JSON-over-TCP channel for control commands.

## Network Ports

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 13250 | UDP | Device → Gateway/Backend | Binary sensor data stream |
| 22346 | UDP | Device ↔ Network | FindMe device discovery |
| 22345 | TCP | Desktop → Device | JSON control commands |

## Binary Packet Format (Sensor Stream)

### Header (20 bytes, fixed)

| Offset | Size | Type | Value/Description |
|--------|------|------|------------------|
| 0–1 | 2 | u16 LE | Magic `0xA55A` |
| 2 | 1 | u8 | Packet version `3` |
| 3 | 1 | u8 | Flags (see below) |
| 4–9 | 6 | bytes | Device UID (hex string bytes, e.g. `3CDC7545CCD0`) |
| 10–13 | 4 | u32 LE | Frame ID (sequence number) |
| 14–17 | 4 | u32 LE | Timestamp (milliseconds since boot) |
| 18–19 | 2 | u16 LE | Payload length (bytes after header) |

### Flags Byte (offset 3)

| Bit | Value | Name | Meaning |
|-----|-------|------|---------|
| 0 | 0x01 | `IMU_FLAG` | Payload includes IMU data (7 floats) |
| 1 | 0x02 | `BATTERY_FLAG` | Payload includes battery data (4 bytes) |
| 2 | 0x04 | `MAG_FLAG` | Payload includes magnetometer data (3 floats, only if IMU_FLAG is set) |
| 6 | 0x40 | `HMAC_FLAG` | Payload includes HMAC-SHA256 (16 bytes) — reserved, not currently used |
| 7 | 0x80 | `HEARTBEAT_FLAG` | Heartbeat packet — no payload data |

### Payload Layout (in order)

1. **Matrix data** — `sensor_count × 4` bytes, each value is IEEE 754 float32 LE (row-major order)
2. **IMU data** — 28 bytes, only if `IMU_FLAG` set:
   - `acc[3]` — accelerometer X, Y, Z (float32 each)
   - `gyro[3]` — gyroscope X, Y, Z (float32 each)
   - `temperature_c` — temperature in °C (float32)
3. **Magnetometer data** — 12 bytes, only if both `IMU_FLAG` and `MAG_FLAG` set:
   - `mag[3]` — magnetic field X, Y, Z (float32 each)
4. **Battery data** — 4 bytes, only if `BATTERY_FLAG` set:
   - `status` (u8), `fault` (u8), `vbat_mv` (u16 LE)

### Heartbeat Packet

Sent every 5 000 ms. Header only — no payload. `HEARTBEAT_FLAG` (0x80) is set in flags. Used by gateways and backends to detect device presence.

## JSON Control Protocol (TCP port 22345)

### Request Format

```json
{"command": "<cmd>", "protocol": "NHO/Arduino/1", "request_id": "<optional>", ...params}
```

Requests are newline-terminated UTF-8 JSON. The `protocol` field is required.

### Response Format

```json
{"ok": true, "cmd": "<cmd>", "message": "<msg>", "data": {...}, "error": ""}
```

### Common Commands

| Command | Mode | Description |
|---------|------|-------------|
| `status` | Any | Full device status snapshot |
| `scan_health` | Any | Matrix scan performance metrics |
| `memory_status` | Any | Free heap and memory info |
| `storage_status` | Any | Flash storage usage |
| `log_tail` | Any | Read recent log entries |
| `log_clear` | Any | Clear stored log |
| `check_update` | Any | Check for OTA update |
| `apply_update` | Any | Apply pending OTA update |
| `reboot` | Any | Reboot the device |
| `set_scan_timing` | Normal | Update scan FPS and settle time |
| `set_stream_buffer` | Normal | Configure ring buffer |
| `set_matrix_layout` | Normal | Override GPIO pin assignments |
| `set_indicators` | Normal | Configure external LED and OLED |
| `set_charge_profile` | Normal | Set BQ25180 charge profile |
| `power_set_state` | Normal | Trigger soft-off or wake |
| `enter_maintenance` | Normal | Switch to Maintenance mode |
| `exit_maintenance` | Maintenance | Return to Normal mode |
| `calibration_*` | Maintenance | Calibration session commands |
| `file_*` | Any/Maintenance | File read/write/list/delete |

## FindMe Discovery Protocol (UDP port 22346)

The device periodically broadcasts a `findme_discover` packet. Gateways respond with `findme_offer`. The device selects the best gateway based on priority and `preferred_gateway_id`.

```json
{"type": "findme_discover", "device_uid": "3CDC7545CCD0", "current_gateway_id": "...", "preferred_gateway_id": "...", "claim_id": "..."}
```
