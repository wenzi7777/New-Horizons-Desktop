import assert from "node:assert/strict";
import test from "node:test";

import { deriveConnectionState, RECONNECTING_GRACE_MS } from "../src/lib/connectionState.ts";

const NOW = Date.parse("2026-06-23T12:00:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

test("online when the gateway reports connected", () => {
  const { connectionState } = deriveConnectionState({
    isBooting: false,
    gatewayConnected: true,
    liveSeenAt: iso(0),
    now: NOW,
  });
  assert.equal(connectionState, "online");
});

test("reconnecting when disconnected but genuinely online within the grace window", () => {
  const { connectionState, isReconnecting } = deriveConnectionState({
    isBooting: false,
    gatewayConnected: false,
    liveSeenAt: iso(5000), // 5s ago, < 15s grace
    now: NOW,
  });
  assert.equal(connectionState, "reconnecting");
  assert.equal(isReconnecting, true);
});

// The core regression: a powered-off device whose gateway keeps re-mentioning it.
// `last_live_seen_at` is frozen 20s ago (backend stops advancing it once the
// device truly drops) even though `last_seen_at` would be "now". Connection
// state must reach "offline", not stay stuck on "reconnecting".
test("offline once the genuine-online clock is older than the grace window", () => {
  const { connectionState, isReconnecting, offline } = deriveConnectionState({
    isBooting: false,
    gatewayConnected: false,
    liveSeenAt: iso(20000), // 20s ago, > 15s grace
    now: NOW,
  });
  assert.equal(connectionState, "offline");
  assert.equal(isReconnecting, false);
  assert.equal(offline, true);
});

test("booting takes precedence over connection state", () => {
  const { connectionState } = deriveConnectionState({
    isBooting: true,
    gatewayConnected: false,
    liveSeenAt: iso(20000),
    now: NOW,
  });
  assert.equal(connectionState, "booting");
});

test("missing live-seen timestamp resolves to offline, never reconnecting", () => {
  const { connectionState } = deriveConnectionState({
    isBooting: false,
    gatewayConnected: false,
    liveSeenAt: "",
    now: NOW,
  });
  assert.equal(connectionState, "offline");
});

test("grace boundary is inclusive", () => {
  const { isReconnecting } = deriveConnectionState({
    isBooting: false,
    gatewayConnected: false,
    liveSeenAt: iso(RECONNECTING_GRACE_MS),
    now: NOW,
  });
  assert.equal(isReconnecting, true);
});
