# VD-CTL/R v2.3.D GCU LTS

VD-CTL/R v2.3.D GCU LTS 是 New Horizons 系列中最新款 GCU 型号。它配备 15×15 压力传感器矩阵、BMI270 IMU（集成 BMM150 磁力计）、BQ25180 电池充电管理，以及一颗板载状态 LED。本设备无物理操作按钮、无外部 LED 灯带、无 OLED 显示屏。

## 规格参数

| 项目 | 值 |
|------|-------|
| MCU | ESP32-S3 |
| Flash | 4 MB |
| 主板版本 | VD-CTL/R v2.3.D GCU LTS |
| 按键矩阵 | 15 行 × 15 列（225 个传感器） |
| 状态 LED | SK6812（板载，GPIO 38） |
| 外部 LED | 无 |
| OLED | 无 |
| I2C | SCL GPIO 47 · SDA GPIO 48 · 1 MHz |
| 操作按钮 | 无 |
| IMU | BMI270 + BMM150 |
| 充电芯片 | BQ25180 |
| 协议 | NHO/Arduino/1 |
| 固件 | New Horizons OS Arduino v0.9.0 |
| OTA 清单 | `arduino-gcu-v23d-lts-latest.json` |

## OTA 清单 URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v23d-lts-latest.json
```

## 支持的功能

- 板载 SK6812 状态 LED
- BMI270 6 轴 IMU（加速度计 + 陀螺仪），采样率 100 Hz
- BMM150 3 轴磁力计（附加 3-float 数据块）
- BQ25180 电池充电，支持可选充电配置文件
- 通过 `power_set_state` 命令远程控制电源（无物理按钮）
- 完整 `DeviceConfig` 支持：扫描时序、流缓冲区、日志、OTA
- 无外部 LED 或 OLED
