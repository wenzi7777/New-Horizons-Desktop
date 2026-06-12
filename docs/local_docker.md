# New Horizons Local Docker

New Horizons now runs as an independent app under `New-Horizons-Desktop`.

## Start

Start the WebUI/backend:

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop
./scripts/start_local.sh --build
```

Open:

```text
http://127.0.0.1:5051/newhorizons
```

Start the Gateway relay separately:

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Gateway
./scripts/start.sh
```

The backend and Gateway are intentionally separate apps. This matches the real deployment model where the Gateway can run on any computer in the same LAN as the device.
The Gateway itself must run directly on that host. Docker Gateway deployments
are unsupported because Docker Desktop rewrites UDP source addresses and breaks
FindMe replies and device command routing.

Gateway ports:

- UDP data: `13250`
- UDP FindMe: `22346`
- Gateway WebUI: `5052`

Only configure Wi-Fi on the device. It will use New Horizons FindMe to discover
an allowed Gateway on the LAN.

Open the Gateway WebUI:

```text
http://127.0.0.1:5052/
```

The Gateway UI can reject/allow devices and switch the upstream target between
Production, Local, and Manual. Rejecting a device closes its UDP control session,
returns a FindMe reject, and drops its UDP packets.

## Gateway On Another Computer

Run this on the computer that is in the same LAN as the device:

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Gateway
export NEWHORIZONS_GATEWAY_SERVER_URL=ws://<backend-ip>:5051/newhorizons/gateway/ws
./scripts/start.sh
```

The Gateway forwards to:

```text
ws://<backend-ip>:5051/newhorizons/gateway/ws
```

For lab deployment, set:

```bash
export NEWHORIZONS_GATEWAY_SERVER_URL=wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws
```

## Stop

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop
docker compose down

cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Gateway
./scripts/stop.sh
```

## Notes

- This independent app does not import `mqtt_test/web/app.py`.
- The `/newhorizons` route base is unchanged.
- The Gateway relay is not started by the WebUI/backend script.
- Device-side server host/port setup is no longer needed; the Gateway owns the upstream server URL.
- MQTT is not used by default. MQTT/TLS `8883` is only a future fallback if WSS over `443` is blocked.
