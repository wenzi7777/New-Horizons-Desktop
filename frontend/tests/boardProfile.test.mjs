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

  assert.equal(profile.hardwareModel, "VD-CTL/R v2.2.C GCU LTS");
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

  // No artwork exists for this revision; the IO modal names the board instead.
  assert.equal(profile.overviewAsset, null);
  assert.equal(profile.supportsIoVisualizer, false);

  assert.equal(wikiSlugFromHardwareModel("VD-CTL/R v2.2.C GCU LTS"), "vd-ctl-r-v2-2-c-gcu-lts");
  assert.match(defaultManifestUrlForHardwareModel("VD-CTL/R v2.2.C GCU LTS"), /arduino-gcu-v22c-lts-latest\.json$/);
});

test("every known board profile declares artwork support only when it has artwork", async () => {
  const { boardProfileForHardwareModel } = await loadBoardProfile();
  for (const model of [
    "VD-CTL/R v1.0.F 2026.4",
    "VD-CTL/R v1.5.F 2026.7",
    "VD-CTL/R v2.1 GCU LTS",
    "VD-CTL/R v2.2.C GCU LTS",
    "VD-CTL/R v2.3.D GCU LTS",
  ]) {
    const profile = boardProfileForHardwareModel(model);
    assert.equal(profile.hardwareModel, model, `${model} must resolve to itself`);
    if (profile.supportsIoVisualizer) {
      assert.ok(profile.overviewAsset, `${model} claims a pin visualizer but has no overview asset`);
    }
  }
});
