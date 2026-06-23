# OTA 固件更新

设备支持通过 GitHub 上托管的 JSON 清单文件进行无线固件更新（OTA）。

## 清单 URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v10f-latest.json
```

清单为一个 JSON 文件，包含固件版本、二进制文件下载 URL、SHA-256 哈希和文件大小。

## 启动时自动更新

默认情况下（`autoApplyOnBoot: true`），设备在每次启动时（WiFi 连接后）检查清单 URL。若有新版本可用，将自动下载并刷写固件，然后重启。

更新中 LED：**青色呼吸**（`OtaActive`）
成功时 LED：**绿色脉冲闪烁**（`OtaSuccess`）
失败时 LED：**红色常亮**（`OtaError`）

## 通过控制命令手动更新

仅检查更新而不应用：
```json
{"command": "check_update", "protocol": "NHO/Arduino/1"}
```

响应包含 `available`、`version`、`url`、`sha256` 和 `size`。

立即应用待处理的更新：
```json
{"command": "apply_update", "protocol": "NHO/Arduino/1"}
```

## 配置 OTA

更改清单 URL 或禁用自动更新：
```json
{
  "command": "set_ota_config",
  "protocol": "NHO/Arduino/1",
  "auto_apply_on_boot": false,
  "manifest_url": "https://example.com/custom-manifest.json"
}
```

## 下载超时

| 参数 | 值 |
|-----------|-------|
| 分块大小 | 4096 字节 |
| 空闲超时 | 15 000 ms |
| 总体超时 | 180 000 ms（3 分钟） |

若下载停顿超过 15 秒，或总下载时间超过 3 分钟，更新将中止并显示 `OtaError`。

## 版本格式

固件版本遵循 `vMAJOR.MINOR.PATCH` 格式（例如 `v0.9.0`）。设备将清单版本字符串与其编译的 `kFirmwareVersion` 常量进行比较，以确定是否需要更新。
