# IMU — BMI270 + BMM150

The v2.1 GCU LTS board includes a BMI270 6-axis IMU (accelerometer + gyroscope) and a BMM150 3-axis magnetometer connected via I2C.

## Sensor Specifications

| Sensor | Model | Axes | Sample Rate |
|--------|-------|------|------------|
| Accelerometer + Gyroscope | BMI270 | 6 (3+3) | 100 Hz |
| Magnetometer | BMM150 | 3 | Synchronized with IMU |

## Data Format in UDP Packets

IMU data is appended to the sensor frame payload when the `IMU_FLAG` (0x01) is set in the packet header flags byte.

### IMU Block (28 bytes, 7 × float32 LE)

| Index | Field | Unit | Description |
|-------|-------|------|-------------|
| 0 | `acc[0]` | m/s² | Accelerometer X |
| 1 | `acc[1]` | m/s² | Accelerometer Y |
| 2 | `acc[2]` | m/s² | Accelerometer Z |
| 3 | `gyro[0]` | rad/s | Gyroscope X |
| 4 | `gyro[1]` | rad/s | Gyroscope Y |
| 5 | `gyro[2]` | rad/s | Gyroscope Z |
| 6 | `temperature_c` | °C | Die temperature |

### Magnetometer Block (12 bytes, 3 × float32 LE)

Appended immediately after the IMU block when **both** `IMU_FLAG` (0x01) and `MAG_FLAG` (0x04) are set.

| Index | Field | Unit | Description |
|-------|-------|------|-------------|
| 0 | `mag[0]` | µT | Magnetic field X |
| 1 | `mag[1]` | µT | Magnetic field Y |
| 2 | `mag[2]` | µT | Magnetic field Z |

## Enabling / Disabling IMU

The IMU can be toggled via the `set_imu` command:
```json
{"command": "set_imu", "protocol": "NHO/Arduino/1", "enabled": true}
```

When disabled, neither `IMU_FLAG` nor `MAG_FLAG` will appear in outgoing packets.

## Python Parsing Example

```python
import struct

IMU_FLAG = 0x01
MAG_FLAG = 0x04

def parse_imu(payload_bytes, offset, flags):
    imu = {}
    if flags & IMU_FLAG:
        acc = struct.unpack_from("<fff", payload_bytes, offset)
        gyro = struct.unpack_from("<fff", payload_bytes, offset + 12)
        temp = struct.unpack_from("<f", payload_bytes, offset + 24)[0]
        imu["acc"] = list(acc)
        imu["gyro"] = list(gyro)
        imu["temperature_c"] = temp
        offset += 28
        if flags & MAG_FLAG:
            mag = struct.unpack_from("<fff", payload_bytes, offset)
            imu["mag"] = list(mag)
            offset += 12
    return imu, offset
```
