# IMU — BMI270 + BMM150

v2.3.D GCU LTS ボードには、I2C 経由（1 MHz）で接続された BMI270 6 軸 IMU と BMM150 3 軸磁力計が搭載されています。

## センサー仕様

| センサー | モデル | 軸数 | サンプリングレート |
|---------|------|------|----------------|
| 加速度計 + ジャイロスコープ | BMI270 | 6（3+3） | 100 Hz |
| 磁力計 | BMM150 | 3 | IMU と同期 |

## UDP パケット内のデータ形式

IMU データは、パケットヘッダーのフラグバイトに `IMU_FLAG`（0x01）が設定されている場合、センサーフレームのペイロードに追加されます。

### IMU ブロック（28 バイト、7 × float32 LE）

| インデックス | フィールド | 単位 | 説明 |
|-----------|-----------|------|------|
| 0 | `acc[0]` | m/s² | 加速度計 X |
| 1 | `acc[1]` | m/s² | 加速度計 Y |
| 2 | `acc[2]` | m/s² | 加速度計 Z |
| 3 | `gyro[0]` | rad/s | ジャイロスコープ X |
| 4 | `gyro[1]` | rad/s | ジャイロスコープ Y |
| 5 | `gyro[2]` | rad/s | ジャイロスコープ Z |
| 6 | `temperature_c` | °C | ダイ温度 |

### 磁力計ブロック（12 バイト、3 × float32 LE）

`IMU_FLAG`（0x01）と `MAG_FLAG`（0x04）の両方が設定されている場合、IMU ブロックの直後に追加されます。

| インデックス | フィールド | 単位 | 説明 |
|-----------|-----------|------|------|
| 0 | `mag[0]` | µT | 磁場 X |
| 1 | `mag[1]` | µT | 磁場 Y |
| 2 | `mag[2]` | µT | 磁場 Z |

## IMU の有効化 / 無効化

```json
{"command": "set_imu", "protocol": "NHO/Arduino/1", "enabled": true}
```

## Python パース例

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
