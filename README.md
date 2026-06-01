# New Horizons

Independent New Horizons WebUI/backend package.

```bash
./scripts/start_local.sh --build
```

Open `http://127.0.0.1:5051/newhorizons`.

The LAN relay is a separate app. Start it from:

```bash
cd ../newhorizons-gateway
./scripts/start_gateway.sh --build
```

On macOS this starts the Gateway on the host through the `ctl-board` conda
environment, so device UDP control uses the real LAN peer address.

See `docs/local_docker.md` for the separated WebUI/backend and Gateway flow.
