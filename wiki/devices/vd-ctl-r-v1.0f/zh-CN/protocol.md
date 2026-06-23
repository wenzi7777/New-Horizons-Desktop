# NHO/Arduino/1 协议参考

设备使用 `NHO/Arduino/1` 协议通过 UDP 进行传感器数据流通信，并通过 JSON-over-TCP 通道进行控制命令通信。

## 网络端口

| 端口 | 协议 | 方向 | 用途 |
|------|----------|-----------|---------|
| 13250 | UDP | 设备 → 网关/后端 | 二进制传感器数据流 |
| 22346 | UDP | 设备 ↔ 网络 | FindMe 设备发现 |
| 22345 | TCP | 桌面端 → 设备 | JSON 控制命令 |

## 二进制数据包格式（传感器流）

### 头部（20 字节，固定长度）

| 偏移 | 大小 | 类型 | 值/说明 |
|--------|------|------|------------------|
| 0–1 | 2 | u16 LE | 魔数 `0xA55A` |
| 2 | 1 | u8 | 数据包版本 `3` |
| 3 | 1 | u8 | 标志位（见下文） |
| 4–9 | 6 | bytes | 设备 UID（十六进制字符串字节，例如 `3CDC7545CCD0`） |
| 10–13 | 4 | u32 LE | 帧 ID（序列号） |
| 14–17 | 4 | u32 LE | 时间戳（启动以来的毫秒数） |
| 18–19 | 2 | u16 LE | 载荷长度（头部之后的字节数） |

### 标志位字节（偏移 3）

| 位 | 值 | 名称 | 含义 |
|-----|-------|------|---------|
| 0 | 0x01 | `IMU_FLAG` | 载荷包含 BMI270 IMU 数据（7 个浮点数） |
| 1 | 0x02 | `BATTERY_FLAG` | 载荷包含电池数据（4 字节） |
| 2 | 0x04 | `MAG_FLAG` | 载荷包含 BMM150 磁力计数据（3 个浮点数，仅当 IMU_FLAG 置位时；v1.0.F 不发送） |
| 6 | 0x40 | `HMAC_FLAG` | 载荷包含 HMAC-SHA256（16 字节）— 保留，当前未使用 |
| 7 | 0x80 | `HEARTBEAT_FLAG` | 心跳数据包 — 无载荷数据 |

### 载荷布局（按顺序）

1. **矩阵数据** — `sensor_count × 4` 字节，每个值为 IEEE 754 float32 LE（行优先顺序）
2. **BMI270 IMU 数据** — 28 字节，仅当 `IMU_FLAG` 置位时：
   - `acc[3]` — 加速度计 X、Y、Z（各为 float32）
   - `gyro[3]` — 陀螺仪 X、Y、Z（各为 float32）
   - `temperature_c` — 温度，°C（float32）
3. **BMM150 磁力计数据** — 12 字节，仅当 `IMU_FLAG` 和 `MAG_FLAG` 同时置位时。v1.0.F 未安装 BMM150，因此该主板上不会出现此数据块：
   - `mag[3]` — 磁场 X、Y、Z（各为 float32）
4. **电池数据** — 4 字节，仅当 `BATTERY_FLAG` 置位时：
   - `status`（u8）、`fault`（u8）、`vbat_mv`（u16 LE）

### 心跳数据包

每 5 000 ms 发送一次。仅含头部 — 无载荷。标志位中设置 `HEARTBEAT_FLAG`（0x80）。网关和后端用于检测设备在线状态。

## JSON 控制协议（TCP 端口 22345）

### 请求格式

```json
{"command": "<cmd>", "protocol": "NHO/Arduino/1", "request_id": "<optional>", ...params}
```

请求为换行符终止的 UTF-8 JSON。`protocol` 字段为必填项。

### 响应格式

```json
{"ok": true, "cmd": "<cmd>", "message": "<msg>", "data": {...}, "error": ""}
```

### 常用命令

| 命令 | 模式 | 说明 |
|---------|------|-------------|
| `status` | Any | 完整设备状态快照 |
| `scan_health` | Any | 矩阵扫描性能指标 |
| `memory_status` | Any | 可用堆内存和内存信息 |
| `storage_status` | Any | 闪存存储使用情况 |
| `log_tail` | Any | 读取最近的日志条目 |
| `log_clear` | Any | 清除已存储的日志 |
| `check_update` | Any | 检查 OTA 更新 |
| `apply_update` | Any | 应用待处理的 OTA 更新 |
| `reboot` | Any | 重启设备 |
| `set_scan_timing` | Normal | 更新扫描 FPS 和稳定时间 |
| `set_stream_buffer` | Normal | 配置环形缓冲区 |
| `set_matrix_layout` | Normal | 覆盖 GPIO 引脚分配 |
| `set_indicators` | Normal | 配置外部 LED 和 OLED |
| `set_charge_profile` | Normal | 设置 BQ25180 充电配置 |
| `power_set_state` | Normal | 触发软关机或唤醒 |
| `enter_maintenance` | Normal | 切换到 Maintenance 模式 |
| `exit_maintenance` | Maintenance | 返回 Normal 模式 |
| `calibration_*` | Maintenance | 校准会话命令 |
| `file_*` | Any/Maintenance | 文件读/写/列表/删除 |

## FindMe 发现协议（UDP 端口 22346）

设备定期广播 `findme_discover` 数据包。网关响应 `findme_offer`。设备根据优先级和 `preferred_gateway_id` 选择最佳网关。

```json
{"type": "findme_discover", "device_uid": "3CDC7545CCD0", "current_gateway_id": "...", "preferred_gateway_id": "...", "claim_id": "..."}
```
