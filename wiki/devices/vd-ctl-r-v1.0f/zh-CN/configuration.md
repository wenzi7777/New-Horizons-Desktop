# 设备配置参考

所有配置持久化存储于设备闪存的 `/config/device.json`，每次启动时加载。除非另有说明，更改立即生效。

## 扫描时序

控制按键矩阵采样速率及数据发送频率。

| 参数 | 默认值 | 范围 | 说明 |
|-----------|---------|-------|-------------|
| `target_fps` | 60 | 1–90 | 目标矩阵扫描速率（帧/秒） |
| `settle_us` | 20 | — | 激活列后等待 ADC 读取的微秒数 |
| `send_every_n_frames` | 1 | 1–N | 每 N 个扫描帧发送一个 UDP 数据包 |

```json
{
  "command": "set_scan_timing",
  "protocol": "NHO/Arduino/1",
  "target_fps": 60,
  "settle_us": 20,
  "send_every_n_frames": 1
}
```

## 流缓冲区（环形缓冲区）

扫描环形缓冲区在 UDP 发送失败时将数据包排队等待重试。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| `enabled` | true | 启用环形缓冲区队列 |
| `mode` | `"standard"` | 缓冲区模式：`standard`（3 帧）或 `extended`（5 帧） |

```json
{
  "command": "set_stream_buffer",
  "protocol": "NHO/Arduino/1",
  "enabled": true,
  "mode": "standard"
}
```

## IMU

v1.0.F 主板包含 BMI270 加速度计 + 陀螺仪。`imu.enabled` 标志控制实时数据包中的 BMI270 遥测数据。此主板未安装 BMM150 磁力计，因此 `MAG_FLAG` 和 `mag` 载荷不可用。

## 外部 LED 灯带

| 参数 | 默认值 | 选项 | 说明 |
|-----------|---------|---------|-------------|
| `mode` | `"off"` | `off`、`on`、`auto` | LED 灯带运行模式 |
| `preset` | `"stream_health"` | `stream_health` | `auto` 模式下的视觉预设 |
| `brightness` | 0.35 | 0.0–1.0 | 灯带亮度 |

```json
{
  "command": "set_indicators",
  "protocol": "NHO/Arduino/1",
  "external_led": {"mode": "auto", "preset": "stream_health", "brightness": 0.35}
}
```

## OLED 显示屏

| 参数 | 默认值 | 选项/范围 | 说明 |
|-----------|---------|--------------|-------------|
| `mode` | `"off"` | `off`、`on`、`auto` | 显示屏 开/关/自动 |
| `page` | `"live_status"` | `live_status`、`sensor_snapshot`、`log_status` | 显示内容 |
| `update_hz` | 1 | 1–N | 显示屏刷新率 |
| `contrast` | 128 | 0–255 | 显示亮度 |
| `rotation` | 0 | 0、1、2、3 | 显示旋转（×90°） |

```json
{
  "command": "set_indicators",
  "protocol": "NHO/Arduino/1",
  "oled": {"mode": "on", "page": "live_status", "update_hz": 1, "contrast": 128, "rotation": 0}
}
```

## 日志

| 参数 | 默认值 | 选项 | 说明 |
|-----------|---------|---------|-------------|
| `enabled` | true | true/false | 启用持久日志存储 |
| `level` | `"info"` | `error`、`warn`、`info`、`debug` | 存储的最低日志级别 |
| `mode` | `"standard"` | `standard`（12 KB）、`extended`（24 KB） | 日志存储大小 |

```json
{
  "command": "set_log",
  "protocol": "NHO/Arduino/1",
  "enabled": true,
  "level": "info",
  "mode": "standard"
}
```

无论此设置如何，串口输出始终记录所有级别的日志。

## OTA 配置

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| `auto_apply_on_boot` | true | 启动时自动检查并应用更新 |
| `manifest_url` | GitHub URL | 清单 JSON URL |

完整 OTA 参考请参见 `ota-update.md`。

## 矩阵布局

高级：覆盖行和列的默认 GPIO 引脚分配。通常设置为主板默认值，除非使用自定义硬件，否则不应更改。

```json
{
  "command": "set_matrix_layout",
  "protocol": "NHO/Arduino/1",
  "analog_pins": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  "select_pins": [13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 40, 41]
}
```
