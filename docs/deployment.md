# New Horizons 部署

New Horizons 已從 `mqtt_test` 拆出。部署時以獨立 app 為準：

```text
/Users/nickxu/Documents/vd-ctl-r-os-lts/apps/newhorizons
```

## 本地 Docker

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/apps/newhorizons
./scripts/start_local.sh --build
```

服務路徑：

- WebUI: `/newhorizons`
- REST API: `/newhorizons/api/*`
- WebUI WebSocket: `/newhorizons/ws`
- Gateway WebSocket: `/newhorizons/gateway/ws`

本地設備連線由獨立 Gateway app 提供：

- UDP data: `13250/udp`
- UDP FindMe: `22346/udp`
- Gateway WebUI: `5052/tcp`

Gateway 目錄：

```text
/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Gateway
```

Gateway 必須直接運行於設備所在 LAN 的 host，不能部署在 Docker Desktop。
Docker Desktop 會改寫 UDP peer 位址，使 FindMe offer 與控制封包無法可靠
回送。Desktop WebUI/backend 仍可使用 Docker。

## 實驗室伺服器部署方向

之後要掛到 `https://isensing-s1.u-aizu.ac.jp/newhorizons` 時，再新增 `mqtt_test` integration 或 Nginx mount。現在本地獨立版不依賴 `mqtt_test/web/app.py`。

建議的遠端拓撲：

```text
Device <-> Local Gateway            Gateway <-> Lab Server
FindMe + UDP data/control           WSS over 443
```

板子只設定 Wi-Fi，透過 New Horizons FindMe 自動找到 LAN 內 Gateway。遠端
production/local/manual upstream URL、Gateway token、拒絕設備策略都由 Gateway 管理。

伺服器需要支援 WebSocket upgrade：

- `/newhorizons/ws`
- `/newhorizons/gateway/ws`

如果 WSS over 443 不可用，再考慮 MQTT/TLS fallback。

## Release URL

Arduino firmware release 仍固定使用 GitHub latest manifest，不由本地 WebUI 目錄提供 release：

```text
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-latest.json
```
