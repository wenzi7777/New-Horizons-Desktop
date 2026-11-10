// What kind of relay a Relays-page entry (or a device's client_type) is, and
// the one name it is shown under. Pure, so node tests load it directly.
//
// "studio" / "pocket": the NH Studio desktop app and the NH Pocket Android
// app; "hub": the ESP-NOW Hub; "gateway": the Python NH Gateway, which NH
// Studio replaces (shown as legacy). An entry with no or an unknown
// client_type is an old Gateway's, as the Backend treats it.
export type RelayKind = "studio" | "pocket" | "hub" | "gateway";

type RelayLike = { client_type?: string } | null | undefined;

const NAMES: Record<RelayKind, string> = {
  studio: "NH Studio",
  pocket: "NH Pocket",
  hub: "NH Hub",
  gateway: "NH Gateway",
};

export const NH_STUDIO_DOWNLOAD_URL = "https://wenzi7777.github.io/New-Horizons-Gateway/";

export function relayKind(relay: RelayLike): RelayKind {
  const value = String(relay?.client_type ?? "").trim().toLowerCase();
  return value === "studio" || value === "pocket" || value === "hub" ? value : "gateway";
}

// A relay's self-reported gateway_name is ignored on purpose: it is persisted
// per install in the Gateway's .run/config.json, so installs from different
// releases kept different defaults and the Relays page mixed them. The
// gateway_id beside it is what tells relays apart.
export function relayDisplayName(relay: RelayLike): string {
  return NAMES[relayKind(relay)];
}

export function isAppRelay(relay: RelayLike): boolean {
  const kind = relayKind(relay);
  return kind === "studio" || kind === "pocket";
}

export function isLegacyGateway(relay: RelayLike): boolean {
  return relayKind(relay) === "gateway";
}

// The Relays page's three sections, each keeping the incoming order.
export function splitRelays<T extends { client_type?: string }>(relays: T[]): { apps: T[]; hubs: T[]; legacyGateways: T[] } {
  return {
    apps: relays.filter((relay) => isAppRelay(relay)),
    hubs: relays.filter((relay) => relayKind(relay) === "hub"),
    legacyGateways: relays.filter((relay) => isLegacyGateway(relay)),
  };
}
