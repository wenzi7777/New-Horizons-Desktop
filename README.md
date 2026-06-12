# New Horizons

Independent New Horizons WebUI/backend package.

```bash
./scripts/start_local.sh --build
```

Open `http://127.0.0.1:5051/newhorizons`.

The LAN relay is a separate app. Start it from:

```bash
cd ../New-Horizons-Gateway
./scripts/start.sh
```

The Gateway is host-only so device UDP control and FindMe use the real LAN peer
address. The Desktop WebUI/backend may continue to run in Docker.

See `docs/local_docker.md` for the separated WebUI/backend and Gateway flow.
