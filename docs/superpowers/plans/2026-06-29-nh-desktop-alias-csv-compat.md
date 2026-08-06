# NH Desktop Alias And Legacy CSV Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent device alias editing to New Horizons Desktop, make the CSV export surface fully compatible with legacy `mqtt_test` storage layout, and ensure recorded CSV data remains visible across redeploys.

**Architecture:** Keep the legacy on-disk CSV layout as the source of truth, add a Desktop-managed metadata layer for alias and last-known device labels, and change the CSV page to browse a merged catalog of live devices plus offline recorded-device folders. Switch Docker persistence from an opaque named volume workflow to a repo-visible host data directory so copied legacy folders and future recordings survive `git pull && docker-compose up --build -d` in the same location.

**Tech Stack:** Flask backend, React + TypeScript frontend, Docker Compose, filesystem-backed metadata JSON under `NEWHORIZONS_DATA_ROOT`, existing Desktop unit/static tests.

## Global Constraints

- Legacy folders copied from old `mqtt_test/backend/mqtt_store` must be readable without renaming, reindexing in PostgreSQL, or requiring the device to come online.
- New recordings must keep the legacy directory shape `mqtt_store/<device-key>/<YYYYMMDD>/<HHMMSS>.csv`.
- The deployment workflow to support is the real server workflow the user described: `git pull` followed by `docker-compose up --build -d`.
- CSV visibility after redeploy must not depend on `svc.list_devices()` or any live device heartbeat.
- Device alias persistence must be owned by NH Desktop and stored in the Desktop data area, not in the legacy `mqtt_test` database.
- Existing `timestamp_ms` epoch-millisecond CSV semantics must remain unchanged.

---

## Summary

- Add an explicit device alias editor to [DeviceSettingsPage.tsx](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/frontend/src/pages/DeviceSettingsPage.tsx) using the already-existing nickname API, and make nickname updates emit device update events immediately.
- Add a backend recorded-device catalog that merges:
  - live devices from `NewHorizonsService`
  - offline device folders found under `NEWHORIZONS_DATA_ROOT`
  - persisted last-known device names and aliases
- Make the CSV page load this recorded-device catalog instead of only the live `/api/devices` list.
- Change Docker persistence from the current named volume-only approach to a host-visible `./data` bind mount, with a one-time migration path for servers that already have data in `newhorizons_data`.
- Refresh the CSV page UI into a three-part workspace: recorded device list, folder/file explorer, and preview/details panel.

## Public Interfaces And Data Contracts

- Add `GET /newhorizons/api/files/devices`
  - Returns recorded-device entries even when devices are offline.
  - Each item should include at least:
    - `device_uid: string`
    - `device_name: string`
    - `nickname: string`
    - `display_name: string`
    - `is_live: boolean`
    - `has_files: boolean`
    - `file_count: number`
    - `latest_recorded_at?: string`
    - `latest_date?: string`
    - `total_bytes: number`
- Add Desktop-managed metadata file under `NEWHORIZONS_DATA_ROOT`:
  - `_newhorizons_device_catalog.json`
  - One entry per device folder, storing last-known label metadata for offline rendering.
- Keep existing nickname persistence file location unchanged:
  - `_newhorizons_device_nicknames.json` under `NEWHORIZONS_DATA_ROOT`
- Keep CSV file contract unchanged for existing readers:
  - path shape remains `<device-key>/<YYYYMMDD>/<HHMMSS>.csv`
  - first column remains `timestamp_ms`

## Implementation Changes

### Task 1: Make Data Persistence Repo-Visible And Redeploy-Stable

**Files:**
- Modify: [docker-compose.yml](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/docker-compose.yml)
- Modify: [docs/deployment.md](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/docs/deployment.md)
- Modify: [README.md](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/README.md)
- Create: [scripts/migrate_named_volume_data.sh](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/scripts/migrate_named_volume_data.sh)

**Changes:**
- Replace the Compose named volume mount `newhorizons_data:/data` with a bind mount `./data:/data`.
- Keep `NEWHORIZONS_DATA_ROOT=/data/mqtt_store` and `NEWHORIZONS_PROFILES_DIR=/data/profiles` unchanged so application code does not need a storage root rewrite.
- Document a one-time migration path for servers that already have CSVs in the Docker named volume:
  - copy `/data/mqtt_store` and `/data/profiles` out of the old container/volume into repo-local `./data/`
  - then redeploy with the updated bind mount compose
- Explicitly document that `git pull && docker-compose up --build -d` preserves CSVs only if the data lives in `./data` or an intentionally preserved Docker volume.

**Acceptance:**
- After redeploy, container path `/data/mqtt_store` resolves to repo path `New-Horizons-Desktop/data/mqtt_store`.
- Legacy copied folders remain present after rebuild without requiring `docker volume` inspection.

### Task 2: Add A Recorded-Device Catalog Independent Of Live Device Discovery

**Files:**
- Modify: [backend/newhorizons_backend/service.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/backend/newhorizons_backend/service.py)
- Modify: [backend/newhorizons_backend/api.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/backend/newhorizons_backend/api.py)
- Modify: [tests/test_backend_gateway.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/tests/test_backend_gateway.py)
- Modify: [tests/test_files_api.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/tests/test_files_api.py)

**Changes:**
- In `NewHorizonsService`, add persisted catalog support:
  - load/save `_newhorizons_device_catalog.json`
  - update catalog when a device is seen from status/result/parsed traffic
  - update catalog when a CSV write occurs for a device
- Persist at least:
  - `device_uid`
  - `last_device_name`
  - `last_seen_at`
  - `latest_recorded_at`
- Add a service method to enumerate recorded devices by merging:
  - current `self._devices`
  - top-level directories under `self._data_root`
  - nickname file
  - catalog metadata
- Exclude metadata files beginning with `_newhorizons_` from recorded-device folder enumeration.
- Add `GET /api/files/devices` in `api.py`.
- Keep existing `/api/files`, `/api/files/preview`, and `/api/files/download` path behavior unchanged once a `device_uid` is chosen.

**Acceptance:**
- A copied legacy folder such as `data/mqtt_store/3CDC7545CCD0/20250628/*.csv` appears in `/api/files/devices` even when the device is offline.
- A device that was once live keeps a readable display label after backend restart.
- Metadata files do not appear as fake devices or folders in the CSV browser.

### Task 3: Finish Alias Support And Make It Work For Offline Recorded Devices

**Files:**
- Modify: [backend/newhorizons_backend/service.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/backend/newhorizons_backend/service.py)
- Modify: [frontend/src/pages/DeviceSettingsPage.tsx](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/frontend/src/pages/DeviceSettingsPage.tsx)
- Modify: [frontend/src/lib/api.ts](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/frontend/src/lib/api.ts)
- Modify: [frontend/src/i18n.tsx](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/frontend/src/i18n.tsx)
- Modify: [tests/test_backend_gateway.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/tests/test_backend_gateway.py)
- Modify: [tests/test_device_settings_page_static.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/tests/test_device_settings_page_static.py)

**Changes:**
- Reuse the existing `PUT /api/devices/<device_uid>/nickname` endpoint instead of inventing a second alias API.
- Add nickname draft state, save action, and clear action to the Overview section of `DeviceSettingsPage.tsx`, adjacent to the existing custom group editor.
- Make `set_device_nickname()` emit a `device_update` event just like `set_device_group()` so the rest of the app reflects alias changes immediately.
- Allow nickname saves for device IDs that exist only as recorded-device folders, not only currently live devices.
- Use alias precedence consistently:
  - `nickname`
  - `last_device_name`
  - live `device_name`
  - folder/device UID

**Acceptance:**
- Alias changes survive backend restart and Docker rebuild.
- An offline device folder with a saved alias renders that alias in the CSV page without the device reconnecting.
- Launchpad, visualization, and CSV device pickers all resolve the same `display_name` precedence.

### Task 4: Keep Legacy CSV Layout As The Storage Source Of Truth

**Files:**
- Modify: [backend/newhorizons_backend/service.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/backend/newhorizons_backend/service.py)
- Modify: [tests/test_files_api.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/tests/test_files_api.py)
- Create: [tests/test_recorded_device_catalog.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/tests/test_recorded_device_catalog.py)

**Changes:**
- Keep `_write_csv_sample()` on the legacy folder convention:
  - top-level folder = canonical device key
  - date folder = `YYYYMMDD`
  - filename = `HHMMSS.csv`
- Add tests that copied legacy folders are readable with no rewrite step.
- Add tests that newly recorded files land beside copied legacy files in the same device/date hierarchy.
- Ensure metadata files remain sidecar files under `mqtt_store` and never change CSV folder naming.

**Acceptance:**
- A legacy tree copied from `server_sample/mqtt_test/backend/mqtt_store` can be browsed directly.
- A new recording for the same device appears in the same `<device>/<date>/` hierarchy.
- The first column in new files remains `timestamp_ms`.

### Task 5: Rebuild The CSV Export UI Around Recorded Devices, Not Live Devices

**Files:**
- Modify: [frontend/src/pages/FilesPage.tsx](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/frontend/src/pages/FilesPage.tsx)
- Modify: [frontend/src/styles.css](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/frontend/src/styles.css)
- Modify: [frontend/src/i18n.tsx](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/frontend/src/i18n.tsx)
- Modify: [tests/test_files_page_static.py](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/tests/test_files_page_static.py)

**Changes:**
- Replace the current device `<select>` fed by `/api/devices` with a recorded-device sidebar fed by `/api/files/devices`.
- Show, per device:
  - `display_name`
  - secondary line with raw device UID / folder name
  - live/offline badge
  - file count and latest recorded date
- Keep the existing folder/file explorer and preview panel, but move them into a clearer three-column workflow:
  - recorded devices
  - folder/file list
  - CSV preview/details/actions
- Add empty-state messaging that distinguishes:
  - no recorded devices at all
  - recorded folders exist but selected folder is empty
  - alias missing, with a shortcut hint to device settings
- Add a top-level note showing the actual storage root and the legacy compatibility statement so operators know copied folders are supported.

**Acceptance:**
- CSV page is usable when zero devices are currently online.
- Operators can identify folders by alias instead of raw MAC only.
- Browsing large recorded-device sets is clearer than the current single dropdown model.

## Test Plan

- Backend:
  - `python3 -m pytest tests/test_files_api.py`
  - `python3 -m pytest tests/test_backend_gateway.py`
  - add coverage for:
    - nickname persistence across service restart
    - offline recorded-device enumeration from copied legacy folders
    - metadata files excluded from browse results
    - live + offline merge ordering
- Frontend:
  - `python3 -m pytest tests/test_files_page_static.py`
  - `python3 -m pytest tests/test_device_settings_page_static.py`
  - `npm run build` in [frontend](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/frontend)
- Deployment validation:
  - start from a server checkout with copied `data/mqtt_store/<legacy-device>/...`
  - run `docker-compose up --build -d`
  - verify CSV page still shows the copied folders before any device reconnects
  - save an alias, rebuild again, verify alias and CSV visibility remain

## Assumptions And Defaults

- The real server deployment uses this repo’s current [docker-compose.yml](/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/docker-compose.yml), confirmed by the user.
- The old `mqtt_test` “device alias” behavior that matters for CSV browsing is effectively the persistent label associated with a device, not a field embedded in CSV filenames.
- For real hardware, the legacy folder key and new Desktop device key are both the normalized device UID / MAC-like identifier, so no folder renaming layer is required.
- Alias persistence should stay local to NH Desktop and must not depend on the old PostgreSQL `device_info` table being reachable.
