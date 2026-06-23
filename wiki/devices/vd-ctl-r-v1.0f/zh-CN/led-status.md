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

外部 WS2812B 灯带（3 像素，GPIO 12）独立运行，可通过 `set_indicators` 命令设置为 `off`、`on` 或 `auto` 模式。在 `auto` 模式下，`stream_health` 预设使用相同的 Online / Warning / Error 颜色语义反映 UDP 流健康状态。
