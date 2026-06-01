# 實驗室伺服器整合備忘

目前不要修改 `mqtt_test`。New Horizons 本地開發與驗證都使用獨立專案：

```text
/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop
```

之後真的要部署到實驗室伺服器時，再做 mount/integration。

## 需要掛載的路徑

- `/newhorizons` -> New Horizons SPA
- `/newhorizons/api/*` -> New Horizons REST API
- `/newhorizons/ws` -> WebUI WebSocket
- `/newhorizons/gateway/ws` -> Gateway WebSocket

## Nginx 重點

`/newhorizons/ws` 與 `/newhorizons/gateway/ws` 都需要 WebSocket upgrade header。

Gateway endpoint 目前不再依賴獨立 gateway token；改由既有連線與管理流程控制權限。

## 板端 command / transport

主要檔案仍在 firmware repo：

- `NewHorizonsOS-OTA/device/recovery/recovery_app.py`
- `NewHorizonsOS-OTA/device/recovery/os_writer.py`
- `NewHorizonsOS-OTA/device/os/app.py`
- `NewHorizonsOS-OTA/device/os/runtime_config.py`

如果只改 WebUI/backend，不會自動改到板子；板端仍需 OTA 或 Thonny 更新。
