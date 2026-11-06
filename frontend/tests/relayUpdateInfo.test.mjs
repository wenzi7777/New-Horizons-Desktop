import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function load() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return await server.ssrLoadModule("/src/lib/relayUpdateInfo.ts");
  } finally {
    await server.close();
  }
}

test("a Hub's and a Gateway's update blocks read the same", async () => {
  const { relayUpdateInfo } = await load();
  const hub = relayUpdateInfo(
    { channel: "beta", required_update: true, latest_hub_version: "v0.13.0", changelog_url: "https://x/hub.md", auto_apply: "retry_later" },
    null,
  );
  const gateway = relayUpdateInfo(
    { channel: "beta", required_update: true, latest_version: "v1.0.1", notes_url: "https://x/gw.md", auto_apply: "retry_later" },
    null,
  );
  for (const [info, version, url] of [[hub, "v0.13.0", "https://x/hub.md"], [gateway, "v1.0.1", "https://x/gw.md"]]) {
    assert.equal(info.supportsUpdate, true);
    assert.equal(info.supportsChannel, true);
    assert.equal(info.channel, "beta");
    assert.equal(info.requiredUpdate, true);
    assert.equal(info.requiredVersion, version);
    assert.equal(info.latestVersion, version);
    assert.equal(info.updateAvailable, true);
    assert.equal(info.changelogUrl, url);
    assert.equal(info.autoApply, "retry_later");
  }
});

test("no update block means no remote update; a check result wins", async () => {
  const { relayUpdateInfo } = await load();
  const old = relayUpdateInfo(undefined, null);
  assert.equal(old.supportsUpdate, false);
  assert.equal(old.supportsChannel, false);
  assert.equal(old.updateAvailable, false);

  const checked = relayUpdateInfo({ available: true, version: "v1.0.1" }, { ok: true, update: { available: false, version: "" } });
  assert.equal(checked.updateAvailable, false);
});
