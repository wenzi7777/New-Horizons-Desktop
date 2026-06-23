// Pure derivation of a device's connection state. Kept free of React / browser
// imports so it can be unit-tested directly under `node --test`.

export const RECONNECTING_GRACE_MS = 15000;

export type DeviceConnectionState = "online" | "reconnecting" | "offline" | "booting";

function parseMs(value: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// `liveSeenAt` MUST be the time the device was *genuinely* online
// (`last_live_seen_at`), never `last_seen_at`: a gateway keeps re-mentioning a
// disconnected device in every ~5s snapshot, which refreshes `last_seen_at`
// forever and would pin the UI to "reconnecting", never reaching "offline".
export function deriveConnectionState(input: {
  isBooting: boolean;
  gatewayConnected: boolean;
  liveSeenAt: string;
  now?: number;
}): { connectionState: DeviceConnectionState; isReconnecting: boolean; offline: boolean } {
  const now = input.now ?? Date.now();
  const liveMs = parseMs(input.liveSeenAt);
  const isReconnecting = Boolean(
    !input.isBooting
      && !input.gatewayConnected
      && liveMs > 0
      && now - liveMs <= RECONNECTING_GRACE_MS,
  );
  const offline = Boolean(!input.isBooting && !input.gatewayConnected && !isReconnecting);
  const connectionState: DeviceConnectionState = input.isBooting
    ? "booting"
    : isReconnecting
      ? "reconnecting"
      : offline
        ? "offline"
        : "online";
  return { connectionState, isReconnecting, offline };
}
