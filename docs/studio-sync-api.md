# NH Studio / NH Pocket ⇄ Desktop server: sync API

What the server offers the two apps (the TS engine's client side). All
paths are under the base path (`/newhorizons` by default). Every JSON error
is `{"error": "<code>", ...}`.

## Authentication: app tokens

An admin signed in to the web page (cookie session) makes one token per app
install on the Relays page, or through the API:

| Route | Body / reply |
|---|---|
| `POST /api/app-tokens` | `{name, client_type: "studio"\|"pocket", role?: "admin"\|"user"}` → `{token, token_type: "Bearer", item}` — the token is shown only here |
| `GET /api/app-tokens` | `{items: [item]}` |
| `DELETE /api/app-tokens/<id>` | `{status: "revoked", item}` |

`item = {id, name, client_type, role, created_at_ms, created_by, last_used_at_ms, revoked_at_ms, active, token_hint}`.
Only a session admin can use these; an app token gets 403.

The token looks like `nhapp_<12 hex id>_<secret>`; the server stores only
its SHA-256. The app sends it as `Authorization: Bearer <token>` on:

- every REST route (same role checks as a logged-in user of that role;
  `role: "admin"` is what syncing needs);
- `GET /ws` (the browser WebSocket) — header, or `?token=` where a header
  cannot be set;
- `GET /gateway/ws` (the relay WebSocket) — header, or `?token=`.

`GET /api/auth/me` with a token answers `{authenticated, username: "app:<id>", role, app_id, client_type}`.
The cookie login is unchanged.

## Relay: `/gateway/ws`

Same protocol as the Python Gateway (`gateway_ws.py`). In `hello`,
`client_type` is `"studio"` or `"pocket"` (also `"gateway"`, `"hub"`;
anything else counts as `"gateway"`).

- With an app token: the token decides `client_type` (whatever hello says)
  and, if hello has no `gateway_id`, it becomes `nh-<client_type>-<app id>`.
  A wrong or revoked `nhapp_` token is refused (`{"type":"error","code":"unauthorized"}`)
  and the socket closes.
- Without a token, studio/pocket are accepted (unauthenticated) unless the
  server sets `NEWHORIZONS_REQUIRE_APP_TOKEN=1` → `{"type":"error","code":"app_token_required"}`.
- `gateway_hello_ack` gains `client_type` and (with a token) `app_id`;
  `latest_gateway_version` is sent only to `"gateway"`.
- The relay entry (`/api/gateways`, `gateway_update` events) gains
  `app_id`, `authenticated`, `legacy` (true for the Python Gateway).
- `gateway_command` reaches a studio/pocket relay only if its hello lists
  `"gateway_command"` in `capabilities` (as for the Gateway), with the
  Gateway's command set.

## Recording upload (chunked, resumable, idempotent)

Lands in the server's own layout `<data_root>/<UID>/<YYYYMMDD>/<HHMMSS>/`
(`<HHMMSS>-2` if taken), files renamed to `<base>.data.csv`,
`<base>.events.csv`, `<base>.meta.json`.

1. **Begin / resume** `POST /api/sync/recordings`
   ```json
   {"recording_id": "…8–128 chars [A-Za-z0-9._:-]…",
    "device_uid": "3CDC7545CCD0",
    "started_at": "2026-11-10T06:27:56.120Z",
    "files": [{"role": "data",   "size": 123, "sha256": "<hex>"},
              {"role": "events", "size": 45,  "sha256": "<hex>"},
              {"role": "meta",   "size": 67,  "sha256": "<hex>"}]}
   ```
   `data` is required, `events`/`meta` optional. `started_at` (time zone
   required) is the first frame; it names the folder, in UTC.
   Reply while uploading:
   `{"status":"uploading","recording_id","files":[{"role","size","received"}],"max_chunk_bytes":8388608}`.
   - same id + same files → the same upload (resume from `received`);
   - same id + different files while uploading → starts over;
   - same id already complete → `{"status":"complete","recording_id","path","device_uid","completed_at_ms"}`
     (no duplicate); with different files → 409 `recording_id_conflict`.
   - A completed recording later deleted on the server can be uploaded again.
2. **Status** `GET /api/sync/recordings/<recording_id>` → same reply as begin; 404 `upload_not_found`.
3. **Chunk** `PUT /api/sync/recordings/<recording_id>/files/<role>?offset=<n>`, body = raw bytes (≤ 8 MiB).
   `offset` must equal the bytes received so far, else 409
   `{"error":"offset_mismatch","role","received"}` — continue from `received`.
   Reply `{"recording_id","role","received","size"}`. Errors: `chunk_exceeds_size`, `chunk_too_large` (413),
   `upload_already_complete` (409).
4. **Complete** `POST /api/sync/recordings/<recording_id>/complete` → the "complete" reply.
   409 `upload_incomplete` `{files: {role: {received, size}}}`; 422 `checksum_mismatch` `{roles}` (those files are
   reset to 0 bytes: send them again); 422 `meta_invalid` (meta is not a JSON object).

The server adds to the meta: `source = {app_id, client_type, app_name, recording_id, uploaded_at}`
(`{client_type: "browser", uploaded_by}` when uploaded with a cookie session), `files` (the new names),
`device.uid`, `transport.path` (= client_type, if the app left it empty), `recording.started_at`.

**List** `GET /api/sync/recordings?device_uid=&since_ms=&limit=(1–1000, 200)&offset=` →
`{server_time_ms, total, offset, next_offset|null, items: [{path, device_uid, recording_id|null,
source, started_at, stopped_at, size, modified_ms, files: [{role, name, size}]}]}`, newest first. It lists every
recording folder, the server's own too (`source = {"client_type": "server"}`). `since_ms` compares `modified_ms`.

**Download** `GET /api/sync/recordings/file?path=<UID>/<YYYYMMDD>/<dir>&role=data|events|meta` — the file;
`Range` works (206), so a download can resume.

## Labels (nickname, group): last writer wins per field

`GET /api/sync/labels?since_ms=` →
`{server_time_ms, items: [{device_uid, nickname, nickname_updated_ms, group, group_updated_ms}]}`
(`since_ms=0`: all). A cleared label stays listed with `""` and its time (a tombstone). Labels from before sync
have time 0.

`PUT /api/sync/labels` `{items: [{device_uid, nickname?, nickname_updated_ms?, group?, group_updated_ms?}]}` —
each field sent needs its `*_updated_ms` (> 0); it is applied only if later than the stored time (a tie keeps the
server's). Reply: the resulting items, each with `applied: ["nickname"|"group"...]`. Edits made on the web page are
stamped with the server's clock. Max 64 chars. Errors: `items_required`, `device_uid_invalid`,
`nickname_updated_ms_required`, `group_too_long`, ...

## Profiles: last writer wins per profile

`GET /api/sync/profiles?since_ms=` → `{server_time_ms, items: [{name, updated_ms, deleted: false, sha256, profile}
| {name, updated_ms, deleted: true}]}`. A profile with no sync record counts as changed at its file's mtime.

`PUT /api/sync/profiles` `{items: [{name, updated_ms, deleted?, profile?}]}` — `name` is the file stem (letters,
digits, `_`, `-`), `profile` an object (required unless `deleted`). Applied only when `updated_ms` is later than the
server's. Reply items carry `applied`; an item not applied comes back with the server's `profile` so the app can take
it. Saves and deletes on the web page are stamped too.

## FindMe policy (the server's own direct-mode responder)

`GET /api/findme/policy` → `{offer_policy: "all"|"managed", managed: [UID], denied: [UID], updated_at_ms, gateway_id}`.
`PUT /api/findme/policy` with any of those fields (others keep their value).

The responder never offers to a device whose discover carries a `current_gateway_id` other than the server's (no
reply), declines one switching to another relay (`device_switching_gateway`), answers `accept:false,
reason:"device_rejected", cooldown_ms:30000` to a denied device, and with `managed` stays silent to devices not on the
list. Defaults: `all` (as before), or `NEWHORIZONS_FINDME_OFFER_POLICY` / `NEWHORIZONS_FINDME_MANAGED` /
`NEWHORIZONS_FINDME_DENY` (comma lists) until the policy is first saved.
