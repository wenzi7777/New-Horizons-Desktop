# 启动模式

固件支持三种运行模式。活动模式在启动时确定，并持续到下次重启。

## 模式概览

| 模式 | LED 颜色 | 说明 |
|------|-----------|-------------|
| Normal（正常） | 启动后绿色（Online） | 完整运行：扫描、WiFi、数据流 |
| Maintenance（维护） | 橙色（常亮） | 配置、校准、文件传输 |
| Safe Maintenance（安全维护） | 品红色（常亮） | 多次启动失败后的应急回退模式 |

## Normal 模式

默认运行模式。所有子系统运行：按键矩阵扫描、WiFi、IMU（如存在）、UDP 数据流、OTA 和控制服务器。LED 在设备启动过程中依次经历 Boot → WifiConnecting → FindMePending → Online 状态。

## Maintenance 模式

启用额外的校准、文件管理和布局更改命令。扫描和 UDP 数据流继续运行，但优先级低于维护操作。

### 进入 Maintenance 模式（从 Normal）

**通过操作按钮：**
- 设备开机状态下，按住操作按钮 **≥ 1500 ms**（长按）。

**通过控制命令：**
```json
{"command": "enter_maintenance", "protocol": "NHO/Arduino/1"}
```

### 退出 Maintenance 模式

```json
{"command": "exit_maintenance", "protocol": "NHO/Arduino/1"}
```

或直接重启设备 — 默认返回 Normal 模式。

## Safe Maintenance 模式

当固件检测到 **连续 3 次或以上启动失败** 时自动进入。此机制防止错误配置导致设备无法恢复。仅部分命令可用（WiFi 设置、OTA、基本状态）。

### 触发方式

每次设备启动时，启动失败计数器递增。仅当完全成功启动（按键矩阵扫描激活）后计数器才会重置。若计数器达到 **3**，下次启动将进入 Safe Maintenance 而非 Normal。

### 恢复步骤

1. 通过桌面应用或 TCP 客户端连接设备端口 **22345**。
2. 检查状态：`{"command": "status", "protocol": "NHO/Arduino/1"}`
3. 若配置损坏，重置配置：`{"command": "set_matrix_layout", ...}` 或通过文件命令删除 `/config/device.json`。
4. 重启：`{"command": "reboot", "protocol": "NHO/Arduino/1"}`

## WiFi 设置模式

当未存储 WiFi 凭证或显式触发时使用。

**通过按钮触发：** 在启动的 **前 3 秒**（设置检测窗口）内按住操作按钮。LED 变为琥珀色（WifiSetup），设备广播名为 `NewHorizonsOS-<UID>` 的 AP。

**连接设置门户：**
- SSID：`NewHorizonsOS-<device_uid>`
- URL：`http://newhorizons.os`（或 `http://192.168.4.1`）
