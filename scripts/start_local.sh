#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

BUILD=0

for arg in "$@"; do
  case "${arg}" in
    --build)
      BUILD=1
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      echo "Usage: $0 [--build]" >&2
      echo "Gateway is a separate app. Start it from ../newhorizons-gateway." >&2
      exit 2
      ;;
  esac
done

cd "${APP_DIR}"

UP_ARGS=(up)
if [[ "${BUILD}" -eq 1 ]]; then
  UP_ARGS+=(--build)
fi
UP_ARGS+=(-d)

docker compose "${UP_ARGS[@]}"

echo "New Horizons is available at http://127.0.0.1:5051/newhorizons"
echo "WebUI/backend only. Start the LAN relay separately from ../newhorizons-gateway."
