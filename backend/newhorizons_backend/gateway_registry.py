"""The relays: Gateways and Hubs that connect over the upstream WebSocket
(gateway_ws.py). Their registration and summaries, which devices each one
carries and how a device's presence follows them, the claim handshake,
Hub environments and LAN migration, and the gateway_command channel that
manages a Hub itself.

A mixin of NewHorizonsService (service.py): it shares the service's lock and
state and has no __init__ of its own.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable
import time
import uuid

from .result_chunks import normalize_device_result
from .service_constants import GATEWAY_CONTROL_UNAVAILABLE


class GatewayRegistryMixin:
    def list_hub_environments(self) -> list[dict[str, Any]]:
        # Enriches each environment with its members' self-reported
        # channels and whether any two *online* members currently share
        # one -- see hub_channel_watch.py's header comment for why this is
        # detection-only (no channel assignment is attempted).
        with self._lock:
            environments = self._hub_channel_watcher.list_environments()
            result: list[dict[str, Any]] = []
            for env in environments:
                hub_ids = env.get("hub_ids") or []
                hubs: list[dict[str, Any]] = []
                channel_members: dict[int, list[str]] = {}
                for gateway_id in hub_ids:
                    channel = self._hub_channel_watcher.channel_for(gateway_id)
                    online = str(self._gateways.get(gateway_id, {}).get("status") or "") == "online"
                    hubs.append({"gateway_id": gateway_id, "channel": channel, "online": online})
                    if online and channel:
                        channel_members.setdefault(channel, []).append(gateway_id)
                conflicting_channels = sorted(ch for ch, members in channel_members.items() if len(members) > 1)
                result.append({
                    **env,
                    "hubs": hubs,
                    "conflict": bool(conflicting_channels),
                    "conflicting_channels": conflicting_channels,
                })
            return result

    def create_hub_environment(self, name: str) -> dict[str, Any]:
        return self._hub_channel_watcher.create_environment(name)

    def delete_hub_environment(self, environment_id: str) -> bool:
        deleted = self._hub_channel_watcher.delete_environment(environment_id)
        if deleted:
            self._resync_hub_environment_fields_locked()
        return deleted

    def set_hub_environment(self, gateway_id: str, environment_id: str | None) -> None:
        self._hub_channel_watcher.set_hub_environment(gateway_id, environment_id)
        self._resync_hub_environment_fields_locked()

    def _resync_hub_environment_fields_locked(self) -> None:
        # Keeps gateway_snapshot()'s "channel_environment_id" field in sync
        # for any Hub that's currently connected -- admin-facing UI reads
        # gateway state from there, not from a separate environments call.
        updated: list[dict[str, Any]] = []
        with self._lock:
            for gateway_id, entry in self._gateways.items():
                environment_id = self._hub_channel_watcher.hub_environment(gateway_id) or ""
                if entry.get("channel_environment_id") != environment_id:
                    entry["channel_environment_id"] = environment_id
                    updated.append(dict(entry))
        for item in updated:
            self._emit_event({"type": "gateway_update", "item": item})

    def report_hub_channel(self, gateway_id: str, channel: int) -> None:
        self._hub_channel_watcher.report_channel(gateway_id, channel)

    def list_hub_lan_devices(self, gateway_id: str) -> list[dict[str, Any]]:
        # Real-hardware finding (see the plan's Step 5b section): a Hub
        # trying to discover nearby devices via its own local UDP
        # findme_probe broadcast got nothing back on a network with client
        # isolation between WiFi STA clients -- but every device already
        # reports its presence to this Backend via its own (device-
        # initiated, unaffected by that isolation) attach flow. So instead
        # of the Hub scanning the LAN itself, it asks the Backend for the
        # same device list `/api/devices` already exposes, filtered to
        # devices not already on this Hub's own gateway_id.
        gateway_id = str(gateway_id or "").strip()
        with self._lock:
            items = [self._decorate_device_entry(self._devices[key]) for key in sorted(self._devices.keys())]
        result: list[dict[str, Any]] = []
        for item in items:
            device_uid = str(item.get("device_uid") or "").strip()
            if not device_uid:
                continue
            # "Already on this Hub" only counts while the device is
            # actually routed through it (transport_path=="gateway_wss").
            # gateway_id alone isn't enough to exclude on: it's left over
            # from the last gateway_wss attach and doesn't get cleared
            # when a device later switches to a direct transport (arduino_udp/
            # udp) -- found on real hardware testing "取消" then rescanning,
            # which would otherwise wrongly hide the very device the scan
            # is supposed to surface.
            if (
                gateway_id
                and str(item.get("gateway_id") or "") == gateway_id
                and str(item.get("transport_path") or "") == "gateway_wss"
            ):
                continue
            result.append({
                "device_uid": device_uid,
                "device_name": str(item.get("display_name") or item.get("device_name") or ""),
                "transport_path": str(item.get("transport_path") or ""),
                "gateway_id": str(item.get("gateway_id") or ""),
                "mode": str(item.get("mode") or ""),
            })
        return result

    def migrate_device_to_hub(self, device_uid: str, hub_mac: str) -> dict[str, Any]:
        # Counterpart to list_hub_lan_devices(): relays the migration
        # commands through this Backend's already-working command-dispatch
        # path (publish_command(), the same one the REST device-command
        # API uses) instead of having the Hub send them directly to the
        # device over WiFi/UDP -- that direction is the one found blocked
        # on real hardware.
        device_uid = self._resolve_known_device_uid(device_uid)
        hub_mac = str(hub_mac or "").strip()
        if not hub_mac:
            raise ValueError("hub_mac_required")
        self.publish_command(device_uid, {
            "command": "set_transport",
            "request_id": uuid.uuid4().hex,
            "mode": "espnow",
            "hub_mac": hub_mac,
        })
        # Give the device a moment to apply + persist the transport change
        # before telling it to reboot into it -- mirrors the same
        # set_transport-then-delay-then-reboot sequencing the Hub's own
        # (now-removed) direct UDP migration code used.
        time.sleep(0.2)
        self.publish_command(device_uid, {
            "command": "reboot",
            "request_id": uuid.uuid4().hex,
        })
        return {"status": "queued", "device_uid": device_uid}

    def publish_gateway_command(self, gateway_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        # Counterpart to publish_command() above, but targets a Hub/Gateway
        # process itself rather than a downstream device_uid -- much
        # simpler since there's exactly one transport (the Hub/Gateway's
        # own WS session, already tracked in _gateway_session_senders for
        # gateway_claim_update/etc.) and no per-mode command gating.
        gateway_id = str(gateway_id or "").strip()
        if not gateway_id:
            raise ValueError("gateway_id_required")
        command = str(payload.get("command") or "")
        if command not in self.HUB_COMMANDS:
            raise ValueError("unknown_command")
        request_id = str(payload.get("request_id") or uuid.uuid4().hex)
        payload = dict(payload)
        payload["request_id"] = request_id
        with self._lock:
            sender = self._gateway_session_senders.get(gateway_id)
            if sender is None:
                raise RuntimeError(GATEWAY_CONTROL_UNAVAILABLE)
            message = {
                "type": "gateway_command",
                "request_id": request_id,
                "payload": payload,
            }
            try:
                sender(message)
            except Exception:
                self._gateway_session_senders.pop(gateway_id, None)
                raise RuntimeError(GATEWAY_CONTROL_UNAVAILABLE)
        return {
            "status": "queued",
            "transport": "gateway_wss",
            "gateway_id": gateway_id,
            "payload": payload,
            "request_id": request_id,
        }

    def record_gateway_command_result(self, gateway_id: str, payload: dict[str, Any]) -> None:
        # Inbound gateway_command_result -- much simpler than
        # _record_result() below since there's no device entry to merge
        # into, just a broadcast so the Desktop UI waiting on this
        # request_id can resolve it. ws.py's generic event listener
        # forwards any _emit_event() call to every connected browser
        # verbatim, so no new subscription plumbing is needed here.
        if not isinstance(payload, dict):
            return
        request_id = str(payload.get("request_id") or "")
        self._emit_event(
            {
                "type": "gateway_command_result",
                "gateway_id": str(gateway_id or ""),
                "request_id": request_id,
                "result": payload.get("result") if isinstance(payload.get("result"), dict) else {},
            }
        )

    def register_gateway(self, gateway_id: str, sender: Callable[[dict[str, Any]], None], payload: dict[str, Any] | None = None) -> str:
        gateway_id = str(gateway_id or "").strip() or "gateway-{}".format(id(sender))
        payload = dict(payload or {})
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._gateway_session_senders[gateway_id] = sender
            existing = dict(self._gateways.get(gateway_id, {}))
            # Sticky -- only the initial `hello` carries this (see
            # HubUplinkClient.cpp's hello construction); a real Gateway's
            # hello never sends it, so absence defaults to "gateway" for
            # backward compatibility. Previously there was no wire-level
            # self-identification at all, so every entry (Hub included)
            # silently defaulted to the Gateway name below.
            client_type = payload.get("client_type") or existing.get("client_type") or "gateway"
            default_name = "NHOS Hub" if client_type == "hub" else "NHOS Gateway"
            existing.update({
                "gateway_id": gateway_id,
                "gateway_name": payload.get("gateway_name") or payload.get("name") or existing.get("gateway_name") or default_name,
                "client_type": client_type,
                "mac": payload.get("mac", existing.get("mac", "")),
                "ip": payload.get("ip", existing.get("ip", "")),
                "version": payload.get("version") or existing.get("version", ""),
                "enabled": bool(payload.get("enabled", existing.get("enabled", True))),
                "status": "online",
                "last_seen": now,
                "connected_at": payload.get("connected_at") or existing.get("connected_at") or now,
                "upstream_path": "gateway_wss",
                "target_mode": payload.get("target_mode", existing.get("target_mode", "")),
                "server_url": payload.get("server_url", existing.get("server_url", "")),
                "local_ports": payload.get("local_ports", existing.get("local_ports", {})),
                "upstream": payload.get("upstream", existing.get("upstream", {})),
                "serving_devices": sorted([uid for uid, gid in self._gateway_device_ids.items() if gid == gateway_id]),
                "serving_device_count": len([uid for uid, gid in self._gateway_device_ids.items() if gid == gateway_id]),
                "denied_devices": payload.get("denied_devices", existing.get("denied_devices", [])),
                "denied_count": len(payload.get("denied_devices", existing.get("denied_devices", [])) or []),
                "udp_forwarded": int(payload.get("udp_forwarded", existing.get("udp_forwarded", 0)) or 0),
                "udp_dropped": int(payload.get("udp_dropped", existing.get("udp_dropped", 0)) or 0),
                "last_error": payload.get("last_error", existing.get("last_error", "")),
                "claims": [dict(item) for item in self._gateway_claims.values() if item.get("gateway_id") == gateway_id],
                "channel_environment_id": self._hub_channel_watcher.hub_environment(gateway_id) or "",
                "channel": self._hub_channel_watcher.channel_for(gateway_id),
                "paired_devices": payload.get("paired_devices", existing.get("paired_devices", [])),
                # Hub only: its wall clock, which it serves to paired devices.
                "clock": payload.get("clock", existing.get("clock")),
                # Hub only: its firmware update state (OtaManager status).
                "update": payload.get("update", existing.get("update")),
            })
            self._gateways[gateway_id] = existing
            event_item = dict(existing)
        self._emit_event({"type": "gateway_update", "item": event_item})
        return gateway_id

    def record_gateway_summary(self, gateway_id: str, payload: dict[str, Any]) -> None:
        payload = dict(payload or {})
        now = datetime.now(timezone.utc).isoformat()
        state = payload.get("state") if isinstance(payload.get("state"), dict) else {}
        devices = state.get("devices") if isinstance(state.get("devices"), list) else []
        denied = state.get("denied_devices") if isinstance(state.get("denied_devices"), list) else []
        claims = state.get("claims") if isinstance(state.get("claims"), list) else []
        local_ports = {
            "udp": payload.get("listen_udp_port"),
            "findme": payload.get("listen_discovery_port"),
        }
        forwarded = 0
        dropped = 0
        for device in devices:
            if not isinstance(device, dict):
                continue
            forwarded += int(device.get("udp_forwarded", 0) or 0)
            dropped += int(device.get("udp_dropped", 0) or 0)
        claim_events: list[dict[str, Any]] = []
        device_events: list[dict[str, Any]] = []
        with self._lock:
            sender = self._gateway_session_senders.get(gateway_id)
            for device in devices:
                if not isinstance(device, dict):
                    continue
                device_uid = self._resolve_known_device_uid(device.get("device_uid") or device.get("uid") or "")
                if not device_uid:
                    continue
                connected = bool(device.get("connected")) or str(device.get("findme_state") or "").lower() == "attached"
                if connected and sender is not None:
                    self._gateway_senders[device_uid] = sender
                    self._gateway_device_ids[device_uid] = gateway_id
                elif not connected and self._gateway_device_ids.get(device_uid) == gateway_id:
                    self._gateway_senders.pop(device_uid, None)
                    self._gateway_device_ids.pop(device_uid, None)
                event_item = self._record_gateway_device_presence_locked(device_uid, gateway_id, device, connected, now, allow_disconnect_grace=True)
                if event_item is not None:
                    device_events.append(event_item)
            for item in claims:
                if not isinstance(item, dict):
                    continue
                claim_id = str(item.get("claim_id") or "").strip()
                if not claim_id:
                    continue
                claim = dict(item)
                claim["gateway_id"] = gateway_id
                previous = self._gateway_claims.get(claim_id, {})
                self._gateway_claims[claim_id] = claim
                if previous.get("state") != claim.get("state") or previous.get("last_error") != claim.get("last_error"):
                    claim_events.append({"type": "gateway_claim_update", **claim})
        # New Horizons Hub only (a Gateway never sends this) -- piggybacked
        # on this same heartbeat rather than a separate request/response,
        # see hub_channel_watch.py's header comment.
        self._hub_channel_watcher.report_channel(gateway_id, payload.get("channel") or 0)
        self.register_gateway(
            gateway_id,
            self._gateway_session_senders.get(gateway_id, lambda _payload: None),
            {
                "gateway_name": payload.get("gateway_name"),
                "version": payload.get("version", ""),
                "mac": payload.get("mac", ""),
                "ip": payload.get("ip", ""),
                "enabled": bool(payload.get("enabled", True)),
                "target_mode": payload.get("target_mode"),
                "server_url": payload.get("server_url"),
                "local_ports": local_ports,
                "upstream": payload.get("upstream", {}),
                "denied_devices": denied,
                "udp_forwarded": forwarded,
                "udp_dropped": dropped,
                "last_error": payload.get("last_error", ""),
                "paired_devices": payload.get("paired_devices", []),
                "clock": payload.get("clock"),
                "update": payload.get("update"),
            },
        )
        for event_item in device_events:
            self._emit_event({"type": "device_update", "item": event_item})
        for event in claim_events:
            self._emit_event(event)

    def register_gateway_device(self, device_uid: str, sender: Callable[[dict[str, Any]], None], gateway_id: str = "") -> str:
        device_uid = self._resolve_known_device_uid(device_uid)
        if not device_uid:
            return ""
        with self._lock:
            self._gateway_senders[device_uid] = sender
            if gateway_id:
                self._gateway_device_ids[device_uid] = gateway_id
                device_event = self._record_gateway_device_presence_locked(
                    device_uid,
                    gateway_id,
                    {"device_uid": device_uid, "connected": True},
                    True,
                    datetime.now(timezone.utc).isoformat(),
                )
                if gateway_id in self._gateways:
                    gateway = dict(self._gateways[gateway_id])
                    gateway["serving_devices"] = sorted([uid for uid, gid in self._gateway_device_ids.items() if gid == gateway_id])
                    gateway["serving_device_count"] = len(gateway["serving_devices"])
                    self._gateways[gateway_id] = gateway
                    gateway_event = dict(gateway)
                else:
                    gateway_event = None
            else:
                gateway_event = None
                device_event = None
        if device_event is not None:
            self._emit_event({"type": "device_update", "item": device_event})
        if gateway_event is not None:
            self._emit_event({"type": "gateway_update", "item": gateway_event})
        return device_uid

    def register_gateway_reply(self, device_uid: str, sender: Callable[[dict[str, Any]], None], gateway_id: str) -> bool:
        """A command result relayed by `gateway_id`.

        The device answers whichever relay sent it a command, so a result
        proves the device is reachable through that relay, not that the relay
        serves it. When another relay currently serves the device, its
        heartbeats decide; registering the replier here made two Gateways on
        one LAN take turns owning the device (each status poll went through
        the last one to answer). Returns whether `gateway_id` is (now) the
        device's relay.
        """
        uid = self._resolve_known_device_uid(device_uid)
        if not uid:
            return False
        with self._lock:
            owner = self._gateway_device_ids.get(uid, "")
            if owner and gateway_id and owner != gateway_id and uid in self._gateway_senders:
                return False
        self.register_gateway_device(uid, sender, gateway_id=gateway_id)
        return True

    def _record_gateway_device_presence_locked(
        self,
        device_uid: str,
        gateway_id: str,
        device: dict[str, Any],
        connected: bool,
        seen_at: str,
        allow_disconnect_grace: bool = False,
    ) -> dict[str, Any] | None:
        existing = dict(self._devices.get(device_uid, {}))
        actually_connected = connected
        if not connected and allow_disconnect_grace and self._should_preserve_recent_findme_attachment(existing, seen_at):
            connected = True
            device = dict(device)
            existing_findme = existing.get("findme") if isinstance(existing.get("findme"), dict) else {}
            device["connected"] = True
            device["findme_state"] = "attached"
            device.setdefault("addr", existing_findme.get("host", ""))
            device.setdefault("gateway_name", existing_findme.get("gateway_name", ""))
            device.setdefault("udp_port", existing_findme.get("udp_port", ""))
        device_name = str(device.get("device_name") or device.get("name") or existing.get("device_name") or device_uid)
        device_name = self._canonical_device_name(device_name, device_uid)
        gateway_state = {
            "gateway_id": gateway_id,
            "connected": bool(connected),
            "findme_state": str(device.get("findme_state") or ""),
            "updated_at": seen_at,
        }
        findme_state = {
            "state": str(device.get("findme_state") or ("attached" if connected else "disconnected")),
            "gateway_id": gateway_id,
            "gateway_name": device.get("gateway_name", ""),
            "host": device.get("last_findme_addr") or device.get("addr") or "",
            "udp_port": device.get("udp_port", ""),
            "claim_id": device.get("claim_id", ""),
            "last_success_ms": device.get("last_findme_at", ""),
            "last_heartbeat_at": device.get("last_heartbeat_at", ""),
            "last_error": device.get("findme_reason", ""),
        }
        boot_transition = None if connected else self._active_boot_transition_locked(device_uid)
        incoming = {
            "device_uid": device_uid,
            "device_name": device_name,
            "nickname": self._nicknames.get(device_uid, ""),
            "display_name": self._nicknames.get(device_uid, "") or device_name,
            "gateway_id": gateway_id,
            # Which kind of client is currently relaying this device --
            # "hub" (New Horizons Hub, ESP-NOW) or "gateway" (New Horizons
            # Gateway software). Resolved from the serving gateway_id's own
            # entry rather than anything the device itself reports, since a
            # device has no notion of what's relaying it.
            "client_type": self._gateways.get(gateway_id, {}).get("client_type", ""),
            "gateway_connected": bool(connected),
            "last_gateway_seen_at": seen_at,
            "gateway_state": gateway_state,
            # A Hub is not a FindMe gateway: its snapshot would say "attached"
            # while the device's own status says "idle", and the two writers
            # took turns (the FindMe card flickered every few seconds). The
            # Hub's view of the device lives in gateway_state instead.
            "findme": None
            if self._gateways.get(gateway_id, {}).get("client_type") == "hub"
            else {k: v for k, v in findme_state.items() if v not in (None, "")},
            "protocol": device.get("protocol"),
            "firmware_version": device.get("firmware_version"),
            "hardware_model": device.get("hardware_model"),
            "transport_path": device.get("transport_path"),
            "last_heartbeat_at": device.get("last_heartbeat_at"),
            "recording_enabled": device_uid in self._recording_enabled,
            "recording_error": self._recording_errors.get(device_uid, ""),
        }
        runtime = device.get("runtime") if isinstance(device.get("runtime"), dict) else {}
        mode = device.get("mode") or runtime.get("mode")
        # A Gateway/Hub heartbeat only relays its own cached view of this
        # device's mode, on its own independent cadence -- it is never
        # fresher than the device's own direct status/result reports. If we
        # already have a recent-enough direct-sourced mode, keep it instead
        # of taking whatever this relayed snapshot says (regardless of
        # which of normal/maintenance/safe_maintenance/safemaintenance
        # either side is asserting) -- otherwise the two independently-
        # cadenced writers keep re-asserting their own value for the same
        # device and the merged mode (and the Desktop UI) flickers
        # continuously between them. See _has_fresh_direct_mode_locked().
        if mode and self._has_fresh_direct_mode_locked(existing, seen_at):
            mode = existing.get("mode")
        if boot_transition is not None:
            incoming["mode"] = "booting"
            incoming["booting"] = True
            incoming["boot_target_mode"] = boot_transition.get("target_mode", "")
            incoming["boot_command"] = boot_transition.get("command", "")
            incoming["boot_expires_at_monotonic"] = boot_transition.get("expires_at", 0)
            mode = "booting"
        if mode:
            incoming["mode"] = mode
        incoming["last_seen_at"] = seen_at
        # `last_live_seen_at` tracks when the device was *genuinely* online.
        # The findme disconnect grace may keep `gateway_connected` (and thus
        # connected) reported as True to ride out a transient snapshot, but
        # that grace must NOT advance the live-seen clock — otherwise the
        # gateway's repeated disconnected snapshots would keep last_live_seen_at
        # fresh forever, the grace would never expire, and a powered-off /
        # soft-off device would stay "online" with an ever-advancing "last seen".
        # So live-seen only advances on an actually-connected snapshot.
        if actually_connected:
            incoming["last_live_seen_at"] = seen_at
            incoming["last_kind"] = "gateway"
        elif existing and (
            not existing.get("gateway_id")
            or not gateway_id
            or existing.get("gateway_id") == gateway_id
        ):
            # A disconnected/stale report only updates the display if it
            # comes from the current owner (existing.gateway_id ==
            # gateway_id), if there's no recorded owner yet to protect
            # (existing.gateway_id empty -- e.g. a device only seen so far
            # via a direct result/findme path that never set gateway_id),
            # or if it's an explicit "no owner" clear (gateway_id=="", used
            # by delete_gateway()/unregister_gateway_sender() when the
            # owning gateway/hub itself just went away). What this blocks
            # is specifically a *different*, still-registered gateway/hub
            # overwriting a live owner's entry with its own stale view --
            # that used to also be let through whenever the display wasn't
            # already "disconnected", which let a stale, long-departed
            # gateway/hub keep re-flipping the display back to itself on
            # every heartbeat.
            incoming["last_kind"] = existing.get("last_kind") or "gateway"
        else:
            return None
        merged = self._merge_device_entry(existing, incoming)
        self._devices[device_uid] = merged
        return self._decorate_device_entry(merged)

    @classmethod
    def _should_preserve_recent_findme_attachment(cls, existing: dict[str, Any], seen_at: str) -> bool:
        findme = existing.get("findme") if isinstance(existing.get("findme"), dict) else {}
        if str(findme.get("state") or "").strip().lower() != "attached":
            return False
        # Measure how long ago the device was *genuinely online*, not how long
        # ago the gateway last mentioned it. `last_seen_at` is refreshed every
        # gateway snapshot even while the gateway reports the device as
        # disconnected (the gateway keeps mentioning the device for its own
        # 90s stale window), so using it would make this grace window never
        # expire — a powered-off / soft-off device would stay "online" forever.
        # `last_live_seen_at` is only refreshed while the device is connected,
        # so the grace correctly rides out a single transient disconnect
        # snapshot and then lets the device go offline.
        last_live = str(existing.get("last_live_seen_at") or existing.get("last_seen_at") or "")
        if not last_live:
            return False
        seen_dt = cls._parse_iso_datetime(seen_at)
        last_live_dt = cls._parse_iso_datetime(last_live)
        if seen_dt is None or last_live_dt is None:
            return False
        age = (seen_dt - last_live_dt).total_seconds()
        return 0 <= age <= cls.FINDME_DISCONNECT_GRACE_SEC

    @staticmethod
    def _parse_iso_datetime(value: str) -> datetime | None:
        text = str(value or "").strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed

    def unregister_gateway_sender(self, sender: Callable[[dict[str, Any]], None]) -> None:
        gateway_updates: list[dict[str, Any]] = []
        device_updates: list[dict[str, Any]] = []
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            stale = [
                (device_uid, self._gateway_device_ids.get(device_uid, ""))
                for device_uid, existing in self._gateway_senders.items()
                if existing is sender or existing == sender
            ]
            for device_uid, gateway_id in stale:
                self._gateway_senders.pop(device_uid, None)
                self._gateway_device_ids.pop(device_uid, None)
                event_item = self._record_gateway_device_presence_locked(
                    device_uid,
                    gateway_id,
                    {"device_uid": device_uid, "connected": False},
                    False,
                    now,
                )
                if event_item is not None:
                    device_updates.append(event_item)
            stale_gateways = [gateway_id for gateway_id, existing in self._gateway_session_senders.items() if existing is sender or existing == sender]
            for gateway_id in stale_gateways:
                self._gateway_session_senders.pop(gateway_id, None)
                # Clear its reported channel immediately -- an offline Hub
                # can't be holding a live collision against anyone.
                self._hub_channel_watcher.clear_channel(gateway_id)
                gateway = dict(self._gateways.get(gateway_id, {"gateway_id": gateway_id}))
                gateway["status"] = "offline"
                gateway["last_seen"] = now
                gateway["serving_devices"] = sorted([uid for uid, gid in self._gateway_device_ids.items() if gid == gateway_id])
                gateway["serving_device_count"] = len(gateway["serving_devices"])
                self._gateways[gateway_id] = gateway
                gateway_updates.append(dict(gateway))
        for device in device_updates:
            self._emit_event({"type": "device_update", "item": device})
        for gateway in gateway_updates:
            self._emit_event({"type": "gateway_update", "item": gateway})

    def delete_gateway(self, gateway_id: str) -> bool:
        gateway_id = str(gateway_id or "").strip()
        if not gateway_id:
            return False
        device_updates: list[dict[str, Any]] = []
        with self._lock:
            if gateway_id not in self._gateways:
                return False
            now = datetime.now(timezone.utc).isoformat()
            self._gateways.pop(gateway_id, None)
            self._gateway_session_senders.pop(gateway_id, None)
            claim_ids = [claim_id for claim_id, claim in self._gateway_claims.items() if claim.get("gateway_id") == gateway_id]
            for claim_id in claim_ids:
                self._gateway_claims.pop(claim_id, None)
            device_uids = [device_uid for device_uid, mapped_gateway_id in self._gateway_device_ids.items() if mapped_gateway_id == gateway_id]
            for device_uid in device_uids:
                self._gateway_senders.pop(device_uid, None)
                self._gateway_device_ids.pop(device_uid, None)
                event_item = self._record_gateway_device_presence_locked(
                    device_uid,
                    "",
                    {"device_uid": device_uid, "connected": False, "findme_state": "disconnected"},
                    False,
                    now,
                )
                if event_item is not None:
                    device_updates.append(event_item)
            snapshot = [dict(self._gateways[key]) for key in sorted(self._gateways.keys())]
        for device in device_updates:
            self._emit_event({"type": "device_update", "item": device})
        self._emit_event({"type": "gateway_snapshot", "items": snapshot})
        return True

    def handle_gateway_claim_request(self, gateway_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        gateway_id = str(gateway_id or "").strip()
        payload = dict(payload or {})
        device_uid = self._resolve_known_device_uid(payload.get("device_uid") or "")
        claim_id = str(payload.get("claim_id") or "").strip()
        ttl_ms = int(payload.get("ttl_ms") or 30000)
        if not gateway_id:
            raise ValueError("gateway_id_required")
        if not device_uid:
            raise ValueError("device_uid_required")
        if not claim_id:
            raise ValueError("claim_id_required")
        now = datetime.now(timezone.utc).isoformat()
        claim = {
            "gateway_id": gateway_id,
            "device_uid": device_uid,
            "claim_id": claim_id,
            "ttl_ms": ttl_ms,
            "state": "requested",
            "requested_at": now,
            "updated_at": now,
            "last_error": "",
        }
        with self._lock:
            self._gateway_claims[claim_id] = claim
            target_sender = self._gateway_session_senders.get(gateway_id)
            device_sender = self._gateway_senders.get(device_uid)
        if device_sender is None:
            claim["state"] = "waiting_for_device"
            claim["last_error"] = "device_not_connected"
            self._update_gateway_claim(claim, target_sender)
            return dict(claim)
        command_payload = {
            "command": "findme_switch_gateway",
            "request_id": "findme-claim-{}".format(claim_id),
            "preferred_gateway_id": gateway_id,
            "claim_id": claim_id,
            "ttl_ms": ttl_ms,
        }
        try:
            self.publish_command(device_uid, command_payload)
            claim["state"] = "switch_command_queued"
        except RuntimeError as exc:
            claim["state"] = "failed"
            claim["last_error"] = str(exc)
        self._update_gateway_claim(claim, target_sender)
        return dict(claim)

    def _update_gateway_claim(self, claim: dict[str, Any], sender: Callable[[dict[str, Any]], None] | None = None) -> None:
        claim = dict(claim)
        claim["updated_at"] = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._gateway_claims[str(claim.get("claim_id") or "")] = claim
        event = {"type": "gateway_claim_update", **claim}
        if sender is not None:
            try:
                sender(event)
            except Exception:
                pass
        self._emit_event(event)

    def record_gateway_status(self, device_uid: str, payload: dict[str, Any]) -> None:
        self._record_status(device_uid, payload)

    def record_gateway_result(self, device_uid: str, payload: dict[str, Any]) -> None:
        self._record_result(device_uid, payload)

    def record_gateway_result_chunk(self, device_uid: str, payload: dict[str, Any]) -> None:
        """One page of a reply a Hub relays in pieces.

        The Hub forwards each page of the device's paged reply as it arrives
        (`page` is the device's own result_chunk envelope). Once every page
        is in, the joined reply is recorded like any single-frame result.
        """
        page = payload.get("page") if isinstance(payload.get("page"), dict) else {}
        assembled = self._result_chunks.add({
            "device_uid": device_uid,
            "request_id": payload.get("request_id"),
            "chunk": page.get("chunk"),
            "chunks": page.get("chunks"),
            "data": page.get("data"),
        })
        if assembled is None:
            return
        result = normalize_device_result(assembled["payload"], fallback_command=str(payload.get("command") or ""))
        result["device_uid"] = device_uid
        result["request_id"] = assembled["request_id"]
        for key in ("gateway_id", "transport_path"):
            if payload.get(key):
                result[key] = payload[key]
        self._record_result(device_uid, result)

    def record_gateway_packet(self, payload: bytes) -> None:
        self._handle_udp_datagram(payload, ("gateway", 0))
