# 启动模式

固件支持三种运行模式。由于 v2.3.D GCU LTS **没有物理操作按钮**，模式切换通过命令或多次重启方式实现。

## 模式概览

| 模式 | LED 颜色 | 说明 |
|------|-----------|-------------|
| 正常 (Normal) | 启动后绿色（在线） | 全功能运行：扫描、WiFi、IMU、数据流 |
| 维护 (Maintenance) | 橙色（常亮） | 配置、校准、文件传输 |
| 安全维护 (Safe Maintenance) | 品红色（常亮） | 多次启动失败后的紧急回退模式 |

## 正常模式 (Normal)

默认运行模式。所有子系统均运行：按键矩阵扫描（15×15）、WiFi、BMI270+BMM150 IMU、UDP 数据流、OTA 以及控制服务器。

## 维护模式 (Maintenance)

### 进入维护模式

**通过控制命令（主要方式）：**
```json
{"command": "enter_maintenance", "protocol": "NHO/Arduino/1"}
```

**多次重启触发（离线恢复）：**
在 3 秒启动窗口内**连续上电 5 次**。第 5 次上电时设备自动进入维护模式。

### 退出维护模式

```json
{"command": "exit_maintenance", "protocol": "NHO/Arduino/1"}
```

或重启 — 设备默认返回正常模式。

## 安全维护模式 (Safe Maintenance)

在**连续 3 次启动失败**后自动触发。功能受限，仅支持 WiFi 设置、OTA 和基本状态命令。

### 恢复步骤

1. 通过 TCP 连接端口 **22345**。
2. 检查状态：`{"command": "status", "protocol": "NHO/Arduino/1"}`
3. 如需，重置配置或通过文件命令删除 `/config/device.json`。
4. 重启：`{"command": "reboot", "protocol": "NHO/Arduino/1"}`

## WiFi 设置模式

**多次重启触发：**在 3 秒启动窗口内**连续上电 5 次**。第 5 次上电时设备广播 WiFi 设置 AP。

- SSID：`NewHorizonsOS-<device_uid>`
- URL：`http://newhorizons.os`（或 `http://192.168.4.1`）
