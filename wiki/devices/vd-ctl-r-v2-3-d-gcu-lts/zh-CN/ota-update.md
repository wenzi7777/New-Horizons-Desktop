# OTA 固件更新

设备支持通过托管在 GitHub 上的 JSON 清单文件进行空中固件更新。

## 清单 URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v23d-lts-latest.json
```

## 启动时自动更新

默认情况下（`autoApplyOnBoot: true`），设备在每次启动时（WiFi 连接后）检查清单 URL。如果有新版本可用，会自动下载并刷写固件，然后重启。

更新中 LED：**青色呼吸** (`OtaActive`)
更新成功 LED：**绿色闪烁脉冲** (`OtaSuccess`)
更新失败 LED：**红色常亮** (`OtaError`)

## 通过控制命令手动更新

```json
{"command": "check_update", "protocol": "NHO/Arduino/1"}
```

```json
{"command": "apply_update", "protocol": "NHO/Arduino/1"}
```

## 配置 OTA

```json
{
  "command": "set_ota_config",
  "protocol": "NHO/Arduino/1",
  "auto_apply_on_boot": false,
  "manifest_url": "https://example.com/custom-manifest.json"
}
```

## 下载超时参数

| 参数 | 值 |
|-----------|-------|
| 块大小 | 4096 字节 |
| 空闲超时 | 15 000 ms |
| 总超时 | 180 000 ms（3 分钟） |
