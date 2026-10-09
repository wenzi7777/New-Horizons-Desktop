#!/usr/bin/env bash
# Copy the NHOS App SDK (compiler, validator, simulator) from the App Library
# checkout beside this repository into frontend/src/sdk/, together with the
# authoring guide and a few example apps, which App Studio's "AI prompt"
# hands to a language model as its reference.
#
# Vendored rather than depended on: the Docker build context is this
# repository alone, so a path or git dependency on the sibling would not
# resolve there. frontend/tests/appSdkSync.test.mjs fails when the copy and
# the library drift apart, whenever the library is checked out.
#
# Usage: scripts/sync_app_sdk.sh [path/to/NHOS-App-Library]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LIBRARY="${1:-${APP_DIR}/../NHOS-App-Library}"
SOURCE="${LIBRARY}/sdk"
TARGET="${APP_DIR}/frontend/src/sdk"
# Small apps that between them show regions, events, emits, the status LED,
# the OLED, the button, persisted counters, the IMU and gated pages; and both
# readouts, which between them use every section kind. Keep this list in step
# with frontend/src/lib/sdkPrompt.ts and frontend/tests/appSdkSync.test.mjs.
EXAMPLE_FLOWS=(steps tilt mat_view)
EXAMPLE_READOUTS=(sysmon sensors)

if [[ ! -f "${SOURCE}/lib/index.mjs" ]]; then
  echo "No SDK at ${SOURCE}; pass the App Library checkout as the first argument." >&2
  exit 1
fi
for app in "${EXAMPLE_FLOWS[@]}"; do
  [[ -f "${LIBRARY}/apps/${app}/app.nhs" ]] || { echo "No example app ${LIBRARY}/apps/${app}/app.nhs" >&2; exit 1; }
done
for app in "${EXAMPLE_READOUTS[@]}"; do
  [[ -f "${LIBRARY}/apps/${app}/readout.json" ]] || { echo "No example readout ${LIBRARY}/apps/${app}/readout.json" >&2; exit 1; }
done

rm -rf "${TARGET}"
mkdir -p "${TARGET}/lib"
cp "${SOURCE}"/lib/*.mjs "${TARGET}/lib/"
# Beside index.mjs as index.d.mts, TypeScript resolves the SDK's types without
# allowJs, and the implementation stays plain JavaScript.
cp "${SOURCE}/index.d.ts" "${TARGET}/lib/index.d.mts"
cp "${SOURCE}/package.json" "${TARGET}/package.json"
mkdir -p "${TARGET}/docs" "${TARGET}/examples"
cp "${LIBRARY}/docs/authoring.md" "${TARGET}/docs/authoring.md"
for app in "${EXAMPLE_FLOWS[@]}"; do
  cp "${LIBRARY}/apps/${app}/app.nhs" "${TARGET}/examples/${app}.nhs"
done
for app in "${EXAMPLE_READOUTS[@]}"; do
  cp "${LIBRARY}/apps/${app}/readout.json" "${TARGET}/examples/${app}.readout.json"
done

commit="$(git -C "${LIBRARY}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
dirty=""
if [[ -n "$(git -C "${LIBRARY}" status --porcelain -- sdk docs apps 2>/dev/null)" ]]; then
  dirty=" (with uncommitted changes)"
fi
cat > "${TARGET}/SOURCE" <<EOF
Vendored from NHOS-App-Library at ${commit}${dirty}: lib/ from sdk/,
docs/ from docs/, examples/ from apps/.
Do not edit these files here: change the library, then run scripts/sync_app_sdk.sh.
EOF

echo "Synced SDK from ${SOURCE} (${commit}${dirty}) into ${TARGET}"
