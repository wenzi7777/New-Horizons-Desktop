import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function load() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return await server.ssrLoadModule("/src/lib/relayKind.ts");
  } finally {
    await server.close();
  }
}

test("relays are named by client_type; unknown ones are old Gateways", async () => {
  const { relayDisplayName, relayKind, isLegacyGateway, isAppRelay } = await load();
  assert.equal(relayDisplayName({ client_type: "studio" }), "NH Studio");
  assert.equal(relayDisplayName({ client_type: "pocket" }), "NH Pocket");
  assert.equal(relayDisplayName({ client_type: "hub" }), "NH Hub");
  assert.equal(relayDisplayName({ client_type: "gateway" }), "NH Gateway");
  assert.equal(relayDisplayName({}), "NH Gateway");
  assert.equal(relayDisplayName(null), "NH Gateway");
  assert.equal(relayKind({ client_type: "Studio" }), "studio");
  assert.equal(relayKind({ client_type: "toaster" }), "gateway");
  assert.ok(isLegacyGateway({}));
  assert.ok(!isLegacyGateway({ client_type: "hub" }));
  assert.ok(isAppRelay({ client_type: "pocket" }));
  assert.ok(!isAppRelay({ client_type: "gateway" }));
});

test("the Relays page splits apps, hubs and legacy Gateways", async () => {
  const { splitRelays } = await load();
  const relays = [
    { gateway_id: "g1" },
    { gateway_id: "s1", client_type: "studio" },
    { gateway_id: "h1", client_type: "hub" },
    { gateway_id: "p1", client_type: "pocket" },
    { gateway_id: "g2", client_type: "gateway" },
  ];
  const { apps, hubs, legacyGateways } = splitRelays(relays);
  assert.deepEqual(apps.map((r) => r.gateway_id), ["s1", "p1"]);
  assert.deepEqual(hubs.map((r) => r.gateway_id), ["h1"]);
  assert.deepEqual(legacyGateways.map((r) => r.gateway_id), ["g1", "g2"]);
});
