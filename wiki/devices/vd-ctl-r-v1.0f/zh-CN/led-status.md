# SK6812 状态 LED 参考

板载 SK6812 LED（GPIO 11）提供实时系统状态反馈。每种状态对应特定的颜色和动画模式。

## 动画模式

| 模式 | 说明 |
|---------|-------------|
| `Off` | LED 完全关闭 |
| `Solid` | 持续常亮颜色 |
| `Breathe` | 平滑淡入淡出 |
| `BlinkBurst` | 短暂快速闪烁后暂停 |
| `AlternateBurst` | 两种状态交替脉冲 |

## 调色板（RGB）

| 名称 | R | G | B | 外观 |
|------|---|---|---|------------|
| Off | 0 | 0 | 0 | 熄灭 |
| Boot | 0 | 0 | 16 | 暗蓝色 |
| WifiSetup | 32 | 9 | 0 | 琥珀色 |
| WifiConnecting | 24 | 18 | 0 | 黄琥珀色 |
| FindMePending | 0 | 18 | 24 | 青色 |
| Online | 0 | 24 | 0 | 绿色 |
| Maintenance | 32 | 18 | 0 | 橙色 |
| SafeMode | 32 | 0 | 32 | 品红色 |
| Ota | 0 | 18 | 24 | 青色 |
| Error | 32 | 0 | 0 | 红色 |
| Warning | 28 | 18 | 0 | 黄橙色 |
| White | 24 | 24 | 24 | 中性白 |
| ChargeDone | 57 | 197 | 187 | 蓝绿色 |

## 状态参考

| 信号 | 颜色 | 模式 | 间隔 | 含义 |
|--------|-------|---------|----------|---------|
| `Boot` | 暗蓝色 | Breathe | 2200 ms | 启动时固件初始化中 |
| `WifiSetup` | 琥珀色 | Breathe | 1800 ms | WiFi 设置门户已激活（`newhorizons.os`） |
| `WifiConnecting` | 黄琥珀色 | Breathe | 1800 ms | 正在尝试连接已保存的 WiFi 网络 |
| `FindMePending` | 青色 | Breathe | 1500 ms | 已连接 WiFi，正在搜索网关 |
| `Online` | 绿色 | Solid | — | 完全运行，正在向网关发送数据流 |
| `Maintenance` | 橙色 | Solid | — | 维护模式已激活 |
| `SafeMode` | 品红色 | Solid | — | 安全维护模式（多次启动失败后触发） |
| `OtaActive` | 青色 | Breathe | 1300 ms | OTA 固件下载进行中 |
| `OtaSuccess` | 绿色 | BlinkBurst | 700 ms · 900 ms | OTA 应用成功，正在重启 |
| `OtaError` | 红色 | Solid | — | OTA 下载或验证失败 |
| `Error` | 红色 | Solid | — | 不可恢复的运行时错误或严重启动失败 |
| `ScanWarning` | 黄橙色 | Breathe | 1200 ms | 检测到矩阵扫描超限 — 性能下降 |
| `RamDanger` | 黄橙色 | Breathe | 800 ms | 可用堆内存严重不足 |
| `ChargingOrMissing` | 橙色 | Solid | — | 电池正在充电，或未检测到电池 |
| `ChargeDone` | 蓝绿色 | Solid | — | 电池已充满 |
| `SoftOffTransition` | 白色 | 短暂脉冲后淡出 | — | 正在进入软关机（关机动画） |
| `SoftOffCharging` | 橙色 | Solid | — | 软关机状态下充电中 |
| `SoftOffChargeDone` | 蓝绿色 | Solid | — | 软关机状态下，电池已满 |
| `SoftOffChargeIdle` | Off | — | — | 软关机状态下，未充电 |
| `PowerTransitionShutdown` | 白色 | 淡出 | — | 软关机前播放关机动画 |
| `PowerTransitionWake` | 白色 | 渐亮后交接 | — | 软开机后播放唤醒动画 |
| `CommandReceived` | 白色 | 短闪 | — | 已收到控制命令数据包 |
| `CommandSuccess` | 绿色 | 短闪 | — | 命令执行成功 |
| `CommandFailed` | 红色 | 短闪 | — | 命令执行失败 |

## 外部 LED 灯带

外部 WS2812B 灯带（3 像素，GPIO 12）与板载 SK6812 状态灯独立工作。它通过 `set_indicators.external_led` 配置，模式只有 `off` / `enabled`。

| 字段 | 默认值 | 选项 / 范围 | 说明 |
|------|--------|-------------|------|
| `mode` | `"off"` | `off`, `enabled` | 彻底关闭灯带，或让所选预设运行 |
| `preset` | `"system_status"` | `system_status`, `connectivity`, `pressure_meter`, `stream_heartbeat`, `calibration_auto`, `solid_marker`, `identify`, `off` | 选择灯带行为 |
| `color` | `"teal"` | `teal`, `green`, `blue`, `purple`, `amber`, `red`, `white` | `solid_marker` 使用的标记颜色 |
| `brightness` | `0.35` | `0.0`–`1.0` | 灯带全局亮度 |

### 预设参考

| 预设 | 行为 | 说明 |
|------|------|------|
| `system_status` | 3 个像素作为一个整体状态灯工作。`Error` / `OtaError` / `RamDanger` 使用红色双闪脉冲，`Maintenance` / `SafeMode` 使用橙色脉冲，`WifiSetup` / `WifiConnecting` / `FindMePending` / `ChargeDone` / `ChargingOrMissing` 则使用对应调色板颜色常亮。 | `Online` 默认为绿色常亮；如果最近出现 UDP 发送失败或扫描超限，会暂时切换为 Warning 黄橙色。 |
| `connectivity` | 像素 0 显示 Wi-Fi 状态，像素 1 显示网关连接，像素 2 显示实时串流活动。 | Wi-Fi 忙碌显示 Warning，未连接显示 Error；串流像素只有在已连到网关但当前空闲时才显示 Warning。 |
| `pressure_meter` | 按当前归一化压力点亮 0–3 个像素。 | 点亮部分会从 Online 绿色逐步过渡到 Error 红色。 |
| `stream_heartbeat` | 最近有帧发送时短暂显示青色心跳。 | 串流空闲时完全熄灭。 |
| `calibration_auto` | 仅在自动校准进行中缓慢橙色脉冲。 | 校准停止后熄灭。 |
| `solid_marker` | 3 个像素全部保持所选 `color` 的纯色常亮。 | 可选颜色为 `teal`, `green`, `blue`, `purple`, `amber`, `red`, `white`。 |
| `identify` | 3 个像素依次显示白色追逐效果。 | 既可作为常驻预设，也可被一次性 identify/test 触发使用。 |
| `off` | 灯带保持熄灭。 | 即使 `mode` 仍为 `enabled`，该预设也会被保存在配置中。 |

### 高优先级覆盖

- 软关机休眠时，灯带会被强制关闭，直到主板再次唤醒。
- 电源切换动画优先于当前预设：关机时播放白色步进/淡出，唤醒时播放青色填充交接。
- 一次性 `identify` 触发会暂时覆盖当前预设，追逐动画结束后再回到原始预设。

### 设计说明

- 严重错误和维护警告被刻意集中在 `system_status` 中，其他预设各自只承担单一职责。
- 板载 SK6812 状态灯仍会作为后备继续显示核心错误，因此板载 LED 与外部灯带是分离的两套状态界面。
