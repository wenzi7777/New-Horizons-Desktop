# New Horizons 本機開發

New Horizons 現在是獨立專案，來源目錄固定在：

```text
/Users/nickxu/Documents/vd-ctl-r-os-lts/apps/newhorizons
```

Desktop WebUI/backend 本地開發預設使用 Docker，不需要啟動 `mqtt_test`。
Gateway 必須直接運行在 LAN host，不使用 Docker。

## Docker 啟動

啟動 WebUI/backend：

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/apps/newhorizons
./scripts/start_local.sh --build
```

開啟：

- `http://127.0.0.1:5051/newhorizons`

在 host 啟動 Gateway 中繼 app：

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Gateway
./scripts/start.sh
```

兩者永遠分開啟動。Gateway 可以跑在同一台電腦，也可以跑在與板子同一個 LAN 的另一台電腦。

預設監聽：

- WebUI / API / WebSocket: `0.0.0.0:5051`
- Gateway UDP data: `0.0.0.0:13250`
- Gateway UDP FindMe: `0.0.0.0:22346`
- Gateway WebUI: `0.0.0.0:5052`

開啟 Gateway WebUI：

- `http://127.0.0.1:5052/`

Gateway WebUI 可以查看正在服務的設備、最近 FindMe request、UDP control/data 狀態、
upstream 狀態，也可以拒絕或允許特定設備。板子端只需要設定 Wi-Fi，不需要再設定
server host/port；Gateway 會負責 production/local/manual 目標伺服器。

如果 Gateway 跑在另一台電腦，設定 backend URL：

```bash
export NEWHORIZONS_GATEWAY_SERVER_URL=ws://<backend-ip>:5051/newhorizons/gateway/ws
./scripts/start.sh
```

Gateway host process 直接接收 FindMe、heartbeat、sensor data 與 command
response，確保記錄真實設備 IP 並能將 offer/command 回送至設備。

停止 WebUI/backend：

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/apps/newhorizons
docker compose down
```

停止 Gateway：

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Gateway
./scripts/stop.sh
```

## 前端單獨驗證

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/apps/newhorizons/frontend
npm install
npm run build
```

Vite base 固定為 `/newhorizons/`，所以本地與之後掛到實驗室伺服器時路徑一致。

## Python 測試

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts
python -m unittest discover -s apps/newhorizons/tests
```

如果本機 Python 沒有 Flask 依賴，請用專案 Docker 驗證，或安裝：

```bash
python -m pip install -r apps/newhorizons/requirements.txt
```
