# SK6812 状态 LED 参考

板载 SK6812 LED（GPIO 38）提供实时系统状态反馈。每种状态映射到特定的颜色和动画模式。

## 动画模式

| 模式 | 说明 |
|---------|-------------|
| `Off` | LED 完全关闭 |
| `Solid` | 常亮，颜色稳定 |
| `Breathe` | 平滑淡入淡出 |
| `BlinkBurst` | 短促快速闪烁后暂停 |

## 颜色参考

| 名称 | R | G | B | 外观 |
|------|---|---|---|------------|
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

## 状态参考

| 信号 | 颜色 | 模式 | 间隔 | 含义 |
|--------|-------|---------|----------|---------|
| `Boot` | 暗蓝色 | Breathe | 2200 ms | 固件启动初始化中 |
| `WifiSetup` | 琥珀色 | Breathe | 1800 ms | WiFi 设置门户已激活 |
| `WifiConnecting` | 黄琥珀色 | Breathe | 1800 ms | 正在尝试连接已保存的 WiFi |
| `FindMePending` | 青色 | Breathe | 1500 ms | WiFi 已连接，正在搜索网关 |
| `Online` | 绿色 | Solid | — | 完全运行并正在向网关传输数据 |
| `Maintenance` | 橙色 | Solid | — | 维护模式已激活 |
| `SafeMode` | 品红色 | Solid | — | 安全维护模式 |
| `OtaActive` | 青色 | Breathe | 1300 ms | OTA 固件下载进行中 |
| `OtaSuccess` | 绿色 | BlinkBurst | 700 ms · 900 ms | OTA 已成功应用，正在重启 |
| `OtaError` | 红色 | Solid | — | OTA 下载或验证失败 |
| `Error` | 红色 | Solid | — | 不可恢复的运行时错误 |
| `ScanWarning` | 黄橙色 | Breathe | 1200 ms | 检测到矩阵扫描超限 |
| `RamDanger` | 黄橙色 | Breathe | 800 ms | 可用堆内存严重不足 |
| `CommandReceived` | 白色 | 短闪 | — | 收到控制命令数据包 |
| `CommandSuccess` | 绿色 | 短闪 | — | 命令执行成功 |
| `CommandFailed` | 红色 | 短闪 | — | 命令执行失败 |

> 此主板无 BQ25180 充电器，因此与充电相关的信号（`ChargingOrMissing`、`ChargeDone`、`SoftOff*`）不适用。
