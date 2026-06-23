# 电源管理与充电

v2.3.D GCU LTS 包含 BQ25180 充电芯片，但**没有物理操作按钮**。所有电源状态切换均通过命令驱动。

## 电源状态

| 状态 | CPU 频率 | 说明 |
|-------|--------------|-------------|
| Normal | 240 MHz | 所有子系统处于活动状态 |
| SoftOffBattery | 80 MHz | 电池供电下挂起，每 5 秒进入轻度睡眠 |
| SoftOffCharging | 80 MHz | 充电中挂起，每 2 秒进入轻度睡眠 |

## 远程电源控制

由于没有物理按钮，软关机和唤醒只能通过控制命令触发：

```json
{"command": "power_set_state", "protocol": "NHO/Arduino/1", "state": "soft_off"}
```

```json
{"command": "power_set_state", "protocol": "NHO/Arduino/1", "state": "normal"}
```

## 软关机模式 (Soft-Off)

在软关机状态下，固件以降频运行，并暂停扫描、WiFi 和 IMU。

**软关机（充电中）时：**
- SK6812 显示 `SoftOffCharging`（橙色）或 `SoftOffChargeDone`（青蓝色）
- 轻度睡眠间隔：2 秒

**软关机（电池供电）时：**
- SK6812 熄灭
- 轻度睡眠间隔：5 秒

## 充电

### 充电状态

| 状态 | LED | 含义 |
|-------|-----|---------|
| `NotCharging` | —（跟随运行状态） | 电池供电运行，无充电器 |
| `ChargingOrMissing` | 橙色常亮 | 充电器已连接并正在充电，或未检测到电池 |
| `ChargeDone` | 青蓝色常亮 | 电池已充满 |

### 充电配置文件

| 配置文件 | 说明 |
|---------|-------------|
| `Balanced` | 默认，适合日常使用 |
| `Fast` | 更高充电电流，发热更多 |
| `Slow` | 保守模式，适合过夜充电 |
| `UltraSlow` | 最小电流，适合老旧电池 |
| `Extreme` | 最大电流 — 请谨慎使用 |

```json
{
  "command": "set_charge_profile",
  "protocol": "NHO/Arduino/1",
  "profile": "Balanced"
}
```

### 传感器数据包中的电池数据

当数据包头部中 `BATTERY_FLAG` (0x02) 置位时：

| 字节 | 字段 | 说明 |
|------|-------|-------------|
| 0 | `status` | BQ25180 状态寄存器 |
| 1 | `fault` | BQ25180 故障寄存器 |
| 2–3 | `vbat_mv` | 电池电压（毫伏，LE uint16） |
