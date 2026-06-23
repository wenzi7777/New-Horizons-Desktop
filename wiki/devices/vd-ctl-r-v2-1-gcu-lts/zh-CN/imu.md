# IMU — BMI270 + BMM150

v2.1 GCU LTS 主板包含一个 BMI270 6 轴 IMU（加速度计 + 陀螺仪）和一个通过 I2C 连接的 BMM150 3 轴磁力计。

## 传感器规格

| 传感器 | 型号 | 轴数 | 采样率 |
|--------|-------|------|------------|
| 加速度计 + 陀螺仪 | BMI270 | 6 (3+3) | 100 Hz |
| 磁力计 | BMM150 | 3 | 与 IMU 同步 |

## UDP 数据包中的数据格式

当数据包头部标志字节中的 `IMU_FLAG` (0x01) 置位时，IMU 数据会附加到传感器帧负载中。

### IMU 数据块（28 字节，7 × float32 LE）

| 索引 | 字段 | 单位 | 说明 |
|-------|-------|------|-------------|
| 0 | `acc[0]` | m/s² | 加速度计 X 轴 |
| 1 | `acc[1]` | m/s² | 加速度计 Y 轴 |
| 2 | `acc[2]` | m/s² | 加速度计 Z 轴 |
| 3 | `gyro[0]` | rad/s | 陀螺仪 X 轴 |
| 4 | `gyro[1]` | rad/s | 陀螺仪 Y 轴 |
| 5 | `gyro[2]` | rad/s | 陀螺仪 Z 轴 |
| 6 | `temperature_c` | °C | 芯片温度 |

### 磁力计数据块（12 字节，3 × float32 LE）

当 **同时**置位 `IMU_FLAG` (0x01) 和 `MAG_FLAG` (0x04) 时，紧接在 IMU 数据块之后附加。

| 索引 | 字段 | 单位 | 说明 |
|-------|-------|------|-------------|
| 0 | `mag[0]` | µT | 磁场 X 轴 |
| 1 | `mag[1]` | µT | 磁场 Y 轴 |
| 2 | `mag[2]` | µT | 磁场 Z 轴 |

## 启用/禁用 IMU

可通过 `set_imu` 命令切换 IMU：
```json
{"command": "set_imu", "protocol": "NHO/Arduino/1", "enabled": true}
```

禁用后，传出数据包中将不会出现 `IMU_FLAG` 和 `MAG_FLAG`。

## Python 解析示例

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
