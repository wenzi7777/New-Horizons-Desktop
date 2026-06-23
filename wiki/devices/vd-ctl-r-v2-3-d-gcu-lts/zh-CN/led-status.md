# SK6812 状态 LED 参考

板载 SK6812 LED（GPIO 38）提供实时系统状态反馈。每种状态对应特定的颜色和动画模式。

## 动画模式

| 模式 | 说明 |
|---------|-------------|
| `Off` | LED 完全熄灭 |
| `Solid` | 恒定常亮颜色 |
| `Breathe` | 平滑淡入淡出 |
| `BlinkBurst` | 短暂快速闪烁后暂停 |

## 状态参考

| 信号 | 颜色 (RGB) | 模式 | 间隔 | 含义 |
|--------|-------------|---------|----------|---------|
| `Boot` | 蓝色 (0,0,16) | Breathe | 2200 ms | 固件启动初始化中 |
| `WifiSetup` | 琥珀色 (32,9,0) | Breathe | 1800 ms | WiFi 设置门户已激活 |
| `WifiConnecting` | 黄琥珀色 (24,18,0) | Breathe | 1800 ms | 正在尝试连接已保存的 WiFi |
| `FindMePending` | 青色 (0,18,24) | Breathe | 1500 ms | WiFi 已连接，正在搜索网关 |
| `Online` | 绿色 (0,24,0) | Solid | — | 完全运行并正在传输数据 |
| `Maintenance` | 橙色 (32,18,0) | Solid | — | 维护模式已激活 |
| `SafeMode` | 品红色 (32,0,32) | Solid | — | 安全维护模式 |
| `OtaActive` | 青色 (0,18,24) | Breathe | 1300 ms | OTA 固件下载进行中 |
| `OtaSuccess` | 绿色 | BlinkBurst | 700 ms · 900 ms | OTA 应用成功，正在重启 |
| `OtaError` | 红色 (32,0,0) | Solid | — | OTA 下载或验证失败 |
| `Error` | 红色 (32,0,0) | Solid | — | 不可恢复的运行时错误 |
| `ScanWarning` | 黄橙色 (28,18,0) | Breathe | 1200 ms | 检测到矩阵扫描超限 |
| `RamDanger` | 黄橙色 (28,18,0) | Breathe | 800 ms | 可用堆内存严重不足 |
| `ChargingOrMissing` | 橙色 (32,18,0) | Solid | — | 电池充电中，或未检测到电池 |
| `ChargeDone` | 青蓝色 (57,197,187) | Solid | — | 电池已充满 |
| `SoftOffCharging` | 橙色 | Solid | — | 软关机状态下充电中 |
| `SoftOffChargeDone` | 青蓝色 | Solid | — | 软关机状态，电池已满 |
| `SoftOffChargeIdle` | Off | — | — | 软关机状态，未充电 |
| `CommandReceived` | 白色 (24,24,24) | 短闪 | — | 收到控制命令数据包 |
| `CommandSuccess` | 绿色 | 短闪 | — | 命令执行成功 |
| `CommandFailed` | 红色 | 短闪 | — | 命令执行失败 |

> 与 v1.0f 不同，本主板没有物理按钮，也没有 `PowerTransitionShutdown` / `PowerTransitionWake` 动画 — 电源状态切换仅通过命令驱动。
