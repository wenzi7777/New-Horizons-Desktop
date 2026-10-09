import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function loadBoardProfile() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return await server.ssrLoadModule("/src/lib/boardProfile.ts");
  } finally {
    await server.close();
  }
}

test("v1.5.F visual IO uses full pin headings and a top-down digital connector order", async () => {
  const { boardProfileForHardwareModel } = await loadBoardProfile();
  const profile = boardProfileForHardwareModel("VD-CTL/R v1.5.F 2026.7");

  assert.equal(profile.analogPinHeading, "Analog Pins");
  assert.equal(profile.digitalPinHeading, "Digital Pins");
  assert.equal(profile.digitalPinSlots[0].label, "5V");
  assert.deepEqual(profile.digitalPinSlots.slice(0, 4).map((pin) => pin.label), ["5V", "3V3", "GND", "GND"]);
  assert.equal(profile.digitalPinSlots.at(-1)?.label, "D0");
});

test("only v1.5.F exposes Action Button settings", async () => {
  const { boardProfileForHardwareModel } = await loadBoardProfile();

  assert.equal(boardProfileForHardwareModel("VD-CTL/R v1.5.F 2026.7").supportsActionButtonSettings, true);
  assert.equal(boardProfileForHardwareModel("VD-CTL/R v1.0.F 2026.4").supportsActionButtonSettings, false);
  assert.equal(boardProfileForHardwareModel("VD-CTL/R v2.3.D GCU LTS").supportsActionButtonSettings, false);
});

test("v2.2.C GCU LTS resolves to its own profile instead of falling back to v1.0.F", async () => {
  const { boardProfileForHardwareModel, wikiSlugFromHardwareModel, defaultManifestUrlForHardwareModel } =
    await loadBoardProfile();
  const profile = boardProfileForHardwareModel("VD-CTL/R v2.2.C GCU LTS");

  assert.equal(profile.hardwareModel, "TIA-CTL v2.2.C GCU LTS");
  // The bug this guards: falling through to V1_PROFILE advertised a charger,
  // an OLED, an external LED strip and a local power button, none of which
  // NHOS_BOARD_GCU_V22C_LTS compiles in.
  assert.equal(profile.supportsChargeControl, false);
  assert.equal(profile.supportsOled, false);
  assert.equal(profile.supportsExternalLed, false);
  assert.equal(profile.supportsLocalButtonWake, false);
  assert.equal(profile.supportsBatteryPercentageIndicator, false);
  assert.equal(profile.powerUx, "remote_only");

  // 11 ADC rows x 13 select columns, matching the firmware BoardPins.cpp block.
  assert.deepEqual(profile.defaultAnalogPins, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(profile.defaultSelectPins, [17, 18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45]);

  // No artwork exists for this revision; the IO modal names the board
  // instead, but its own pins can still be picked.
  assert.equal(profile.overviewAsset, null);
  assert.equal(profile.supportsIoVisualizerArtwork, false);
  assert.equal(profile.supportsIoVisualizer, true);
  assert.deepEqual(
    profile.analogPinSlots.filter((pin) => pin.role === "analog").map((pin) => pin.gpio),
    profile.defaultAnalogPins,
  );
  assert.deepEqual(
    profile.digitalPinSlots.filter((pin) => pin.role === "select").map((pin) => pin.gpio).sort((a, b) => a - b),
    profile.defaultSelectPins,
  );

  assert.equal(wikiSlugFromHardwareModel("VD-CTL/R v2.2.C GCU LTS"), "vd-ctl-r-v2-2-c-gcu-lts");
  assert.match(defaultManifestUrlForHardwareModel("VD-CTL/R v2.2.C GCU LTS"), /arduino-gcu-v22c-lts-latest\.json$/);
});

test("artwork is claimed exactly when it exists, and every board has a pin picker", async () => {
  const { boardProfileForHardwareModel } = await loadBoardProfile();
  for (const model of [
    "TIA-CTL v1.0.F 2026.4",
    "TIA-CTL v1.5.F 2026.7",
    "TIA-CTL v2.1 GCU LTS",
    "TIA-CTL v2.2.C GCU LTS",
    "TIA-CTL v2.3.D GCU LTS",
  ]) {
    const profile = boardProfileForHardwareModel(model);
    assert.equal(profile.hardwareModel, model, `${model} must resolve to itself`);
    assert.equal(profile.supportsIoVisualizerArtwork, Boolean(profile.overviewAsset), `${model} artwork flag`);
    // The picker works from pin slots alone; a missing photo must not hide it.
    assert.equal(profile.supportsIoVisualizer, true, `${model} pin picker`);
    assert.ok(profile.analogPinSlots.some((pin) => pin.role === "analog"), `${model} analog slots`);
    assert.ok(profile.digitalPinSlots.some((pin) => pin.role === "select"), `${model} select slots`);
  }
});

test("names older firmware reports (VD-CTL/R, TIA-CTL/R) resolve to the same profile", async () => {
  const { boardProfileForHardwareModel, wikiSlugFromHardwareModel, displayHardwareModel } = await loadBoardProfile();
  for (const model of ["v1.0.F 2026.4", "v1.5.F 2026.7", "v2.1 GCU LTS", "v2.2.C GCU LTS", "v2.3.D GCU LTS"]) {
    for (const prefix of ["VD-CTL/R", "TIA-CTL/R"]) {
      const legacy = boardProfileForHardwareModel(`${prefix} ${model}`);
      assert.equal(legacy.hardwareModel, `TIA-CTL ${model}`);
      assert.equal(wikiSlugFromHardwareModel(`${prefix} ${model}`), wikiSlugFromHardwareModel(`TIA-CTL ${model}`));
      assert.equal(displayHardwareModel(`${prefix} ${model}`), `TIA-CTL ${model}`);
    }
  }
  // A board no profile knows yet keeps the wiki directory naming.
  assert.equal(wikiSlugFromHardwareModel("TIA-CTL v9.9"), "vd-ctl-r-v9-9");
});
