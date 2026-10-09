import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The SDK page runs a vendored copy of the App Library's toolchain. If the
// copy drifts from the library, the page accepts a package that the library's
// CI (and therefore the published catalog) would build differently -- so the
// two are compared file by file whenever the library is checked out beside
// this repository. Fix a failure with scripts/sync_app_sdk.sh.

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = join(FRONTEND, "src", "sdk");
const LIBRARY_SDK = resolve(FRONTEND, "..", "..", "NHOS-App-Library", "sdk");
const skip = existsSync(join(LIBRARY_SDK, "lib", "index.mjs")) ? false : "NHOS-App-Library is not checked out beside this repo";

test("the vendored SDK matches the App Library", { skip }, () => {
  const libraryFiles = readdirSync(join(LIBRARY_SDK, "lib")).filter((name) => name.endsWith(".mjs")).sort();
  const vendoredFiles = readdirSync(join(VENDORED, "lib")).filter((name) => name.endsWith(".mjs")).sort();
  assert.deepEqual(vendoredFiles, libraryFiles, "file list differs; run scripts/sync_app_sdk.sh");
  for (const name of libraryFiles) {
    assert.equal(
      readFileSync(join(VENDORED, "lib", name), "utf8"),
      readFileSync(join(LIBRARY_SDK, "lib", name), "utf8"),
      `${name} differs; run scripts/sync_app_sdk.sh`,
    );
  }
  assert.equal(
    readFileSync(join(VENDORED, "lib", "index.d.mts"), "utf8"),
    readFileSync(join(LIBRARY_SDK, "index.d.ts"), "utf8"),
    "index.d.ts differs; run scripts/sync_app_sdk.sh",
  );
});

test("the vendored authoring guide and example apps match the App Library", { skip }, () => {
  // App Studio's AI prompt quotes these to a language model as the language's
  // reference, so a stale copy teaches it a language the compiler has moved on from.
  const library = resolve(LIBRARY_SDK, "..");
  const copies = [["docs/authoring.md", join(library, "docs", "authoring.md")]];
  for (const name of readdirSync(join(VENDORED, "examples")).sort()) {
    const readout = name.match(/^(.+)\.readout\.json$/);
    const flow = name.match(/^(.+)\.nhs$/);
    assert.ok(readout || flow, `unexpected example ${name}`);
    copies.push([`examples/${name}`, readout ? join(library, "apps", readout[1], "readout.json") : join(library, "apps", flow[1], "app.nhs")]);
  }
  assert.ok(copies.length > 1, "no examples; run scripts/sync_app_sdk.sh");
  for (const [vendored, original] of copies) {
    assert.ok(existsSync(original), `${vendored} has no original in the library; run scripts/sync_app_sdk.sh`);
    assert.equal(readFileSync(join(VENDORED, vendored), "utf8"), readFileSync(original, "utf8"), `${vendored} differs; run scripts/sync_app_sdk.sh`);
  }
});

test("the vendored SDK compiles every library app to its published bytes", { skip }, async () => {
  // Not just the same files: the same output, run from where the page loads it.
  const sdk = await import(join(VENDORED, "lib", "index.mjs"));
  const apps = join(LIBRARY_SDK, "..", "apps");
  for (const id of readdirSync(apps)) {
    const source = join(apps, id, "app.nhs");
    if (!existsSync(source)) continue;
    const analysis = sdk.analyzeFlow(readFileSync(source, "utf8"));
    assert.ok(analysis.ok, `${id}: ${JSON.stringify(analysis.diagnostics)}`);
    assert.equal(new TextDecoder().decode(analysis.bytes), readFileSync(join(apps, id, "app.nha"), "utf8"), id);
  }
});
