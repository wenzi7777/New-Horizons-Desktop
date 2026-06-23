# 电源管理与充电

## 电源状态

| 状态 | CPU 频率 | 说明 |
|-------|--------------|-------------|
| Normal | 240 MHz | 所有子系统激活 |
| SoftOffBattery | 80 MHz | 电池供电下挂起，每 5 s 轻度休眠 |
| SoftOffCharging | 80 MHz | 充电中挂起，每 2 s 轻度休眠 |

## 操作按钮行为

| 输入 | 持续时间 | 动作 |
|-------|----------|--------|
| 短按 | 50–500 ms | 从软关机唤醒；在正常模式下无操作 |
| 长按 | ≥ 1500 ms | 正常模式下：触发关机动画 → 软关机；软关机状态下：无效果（唤醒仅限短按） |

## 软关机模式

软关机是一种低功耗挂起状态 — 固件继续以降低的频率运行，但暂停扫描、WiFi 和 IMU。

**进入软关机：**
1. 在 Normal 模式下长按操作按钮。
2. 播放 `PowerTransitionShutdown` LED 动画（白色淡出）。
3. 动画完成后，设备根据充电器状态进入 `SoftOffBattery` 或 `SoftOffCharging`。

**软关机期间：**
- 电池供电：SK6812 关闭；设备每 5 秒轻度休眠一次。
- 充电中：SK6812 显示 `SoftOffCharging`（橙色）或 `SoftOffChargeDone`（蓝绿色）；轻度休眠间隔为 2 秒。

**从软关机唤醒：**
1. 短按操作按钮。
2. 播放 `PowerTransitionWake` LED 动画（白色渐亮）。
3. 所有子系统恢复；设备返回 Normal 模式。

**远程电源控制（通过命令）：**
```json
{"command": "power_set_state", "protocol": "NHO/Arduino/1", "state": "soft_off"}
```
```json
{"command": "power_set_state", "protocol": "NHO/Arduino/1", "state": "normal"}
```

## 充电

BQ25180 IC 管理电池充电。充电状态反映在状态 LED 中，并在传感器数据包（`battery` 字段）中报告。

### 充电状态

| 状态 | LED | 含义 |
|-------|-----|---------|
| `NotCharging` | —（跟随运行时状态） | 电池供电运行，未连接充电器 |
| `ChargingOrMissing` | 橙色常亮 | 充电器已连接并充电中；或未检测到电池 |
| `ChargeDone` | 蓝绿色常亮 | 电池已充满 |

### 充电配置

通过 `set_charge_profile` 命令设置：

| 配置 | 说明 |
|---------|-------------|
| `Balanced` | 默认，适用于日常使用 |
| `Fast` | 更高充电电流，发热更多 |
| `Slow` | 保守，适合过夜充电 |
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

当数据包头部设置了 `BATTERY_FLAG`（0x02）时，载荷包含：

| 字节 | 字段 | 说明 |
|------|-------|-------------|
| 0 | `status` | BQ25180 状态寄存器 |
| 1 | `fault` | BQ25180 故障寄存器 |
| 2–3 | `vbat_mv` | 电池电压，毫伏（小端序 uint16） |
