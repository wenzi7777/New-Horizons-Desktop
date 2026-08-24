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
