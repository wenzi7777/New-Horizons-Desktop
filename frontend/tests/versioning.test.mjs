import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";

// The same vectors the firmware, Hub and Gateway tests read.
const SHARED_FIXTURE = resolve(process.cwd(), "../../NewHorizonsOS-OTA/spec/fixtures/versions.json");

async function loadVersioning() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return await server.ssrLoadModule("/src/lib/versioning.ts");
  } finally {
    await server.close();
  }
}

const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);

test("version order matches the shared vectors", { skip: !existsSync(SHARED_FIXTURE) && "NewHorizonsOS-OTA not checked out alongside" }, async () => {
  const { compareVersions, compareVersionCores, isPrereleaseVersion } = await loadVersioning();
  const fixture = JSON.parse(readFileSync(SHARED_FIXTURE, "utf-8"));
  for (const c of fixture.compare) {
    assert.equal(sign(compareVersions(c.a, c.b)), c.order, `compareVersions(${c.a}, ${c.b})`);
    assert.equal(sign(compareVersionCores(c.a, c.b)), c.core, `compareVersionCores(${c.a}, ${c.b})`);
  }
  for (const c of fixture.prerelease) {
    assert.equal(isPrereleaseVersion(c.version), c.prerelease, c.version);
  }
});

test("a beta of a release satisfies that release's min_os, but is not newer than it", async () => {
  const { compareVersions, compareVersionCores } = await loadVersioning();
  assert.ok(compareVersions("v1.14.0-beta.1", "v1.14.0") < 0);
  assert.equal(compareVersionCores("v1.14.0-beta.1", "v1.14.0"), 0);
});

test("channels: unknown is stable, manifests by suffix, and leaving beta waits for stable", async () => {
  const { normalizeUpdateChannel, manifestUrlForChannel, waitingForStableToCatchUp } = await loadVersioning();
  assert.equal(normalizeUpdateChannel("beta"), "beta");
  assert.equal(normalizeUpdateChannel("BETA"), "beta");
  assert.equal(normalizeUpdateChannel("nightly"), "stable");
  assert.equal(normalizeUpdateChannel(undefined), "stable");
  assert.equal(manifestUrlForChannel("https://x/arduino-v15f", "stable"), "https://x/arduino-v15f-latest.json");
  assert.equal(manifestUrlForChannel("https://x/arduino-v15f", "beta"), "https://x/arduino-v15f-beta.json");
  assert.equal(waitingForStableToCatchUp("stable", "v1.14.0-beta.2"), true);
  assert.equal(waitingForStableToCatchUp("beta", "v1.14.0-beta.2"), false);
  assert.equal(waitingForStableToCatchUp("stable", "v1.14.0"), false);
});

test("app min_os checks ignore the prerelease suffix", async () => {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    const { satisfiesMinOs } = await server.ssrLoadModule("/src/lib/appLibrary.ts");
    assert.equal(satisfiesMinOs({ min_os: "v1.14.0" }, "v1.14.0-beta.1"), true);
    assert.equal(satisfiesMinOs({ min_os: "v1.14.0" }, "v1.13.9"), false);
  } finally {
    await server.close();
  }
});
