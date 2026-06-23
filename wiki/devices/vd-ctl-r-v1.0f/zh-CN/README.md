# VD-CTL/R v1.0.F 2026.4

VD-CTL/R v1.0.F 2026.4 是 New Horizons 系列中的主要消费硬件版本。它配备全尺寸按键矩阵、内置状态 LED、外部可寻址 LED 灯带、OLED 显示屏、BMI270 IMU、实体操作按钮以及基于 BQ25180 的充电电路。

## 规格参数

| 项目 | 值 |
|------|-------|
| MCU | ESP32-S3 Mini 1 N8 |
| Flash | 8 MB |
| 主板版本 | VD-CTL/R v1.0.F 2026.4 |
| 按键矩阵 | 10 行 × 21 列（210 个传感器） |
| 状态 LED | SK6812（板载，GPIO 11） |
| 外部 LED | WS2812B 兼容灯带（GPIO 12，3 像素） |
| OLED | SSD1306 128×64，I2C |
| IMU | BMI270 加速度计 + 陀螺仪；不含 BMM150 磁力计 |
| I2C | SCL GPIO 42 · SDA GPIO 45 · 400 kHz |
| 操作按钮 | GPIO 46 |
| 充电芯片 | BQ25180 |
| 协议 | NHO/Arduino/1 |
| 固件 | New Horizons OS Arduino v0.9.0 |
| OTA 清单 | `arduino-v10f-latest.json` |

## OTA 清单 URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v10f-latest.json
```

## 支持的功能

- 板载 SK6812 状态 LED，支持完整动画功能
- 外部 WS2812B LED 灯带（3 像素，可配置模式和亮度）
- SSD1306 OLED 显示屏（可配置页面、对比度、旋转方向、刷新率）
- 实体操作按钮，用于唤醒、进入维护模式和 WiFi 设置
- BQ25180 电池充电，支持可选充电配置
- 软关机 / 软唤醒电源转换，带动画效果
- BMI270 IMU 遥测；此主板未安装 BMM150 磁力计
- 完整 `DeviceConfig` 支持：扫描时序、流缓冲区、日志、OTA
