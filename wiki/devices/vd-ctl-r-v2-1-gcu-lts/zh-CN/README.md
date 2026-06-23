# VD-CTL/R v2.1 GCU LTS

VD-CTL/R v2.1 GCU LTS 是 New Horizons 系列中的紧凑型 GCU（通用控制单元）变体。它配备 10×12 压力传感器矩阵、BMI270 IMU 与 BMM150 磁力计，以及一个板载状态 LED。该设备无物理操作按钮、无外部 LED 灯带、无 OLED 显示屏。

## 规格参数

| 项目 | 值 |
|------|-------|
| MCU | ESP32-S3 |
| Flash | 4 MB |
| 主板版本 | VD-CTL/R v2.1 GCU LTS |
| 按键矩阵 | 10 行 × 12 列（120 个传感器） |
| 状态 LED | SK6812（板载，GPIO 38） |
| 外部 LED | 无 |
| OLED | 无 |
| I2C | SCL GPIO 47 · SDA GPIO 48 · 1 MHz |
| 操作按钮 | 无 |
| IMU | BMI270 + BMM150 |
| 充电器 | 无（未配备 BQ25180） |
| 协议 | NHO/Arduino/1 |
| 固件 | New Horizons OS Arduino v0.9.0 |
| OTA 清单 | `arduino-gcu-v21-lts-latest.json` |

## OTA 清单 URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v21-lts-latest.json
```

## 支持的功能

- 板载 SK6812 状态 LED
- BMI270 6 轴 IMU（加速度计 + 陀螺仪），采样率 100 Hz
- BMM150 3 轴磁力计（额外的 3 浮点数负载块）
- 通过 `power_set_state` 命令进行远程电源控制（无物理按钮）
- 完整的 `DeviceConfig` 支持：扫描时序、流缓冲区、日志记录、OTA
- 无充电管理（无 BQ25180）
- 无外部 LED 或 OLED
