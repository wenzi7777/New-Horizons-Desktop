import assert from "node:assert/strict";
import test from "node:test";

import { buildBatteryProfileCommand, batteryProfileSetupRequired } from "../src/lib/batteryProfile.ts";

test("builds a set_battery_profile command with a positive custom capacity and 10mA current increment", () => {
  assert.deepEqual(buildBatteryProfileCommand("custom", "650", "230"), {
    command: "set_battery_profile",
    capacity_mah: 650,
    max_charge_current_ma: 230,
  });
});

test("rejects unavailable profile settings rather than sending an invalid command", () => {
  assert.throws(() => buildBatteryProfileCommand("custom", "0", "235"), /invalid_battery_profile/);
});

test("requires setup only when firmware explicitly requires or cannot resolve a profile", () => {
  assert.equal(batteryProfileSetupRequired({ battery_profile_required: true, profile_resolved: true }), true);
  assert.equal(batteryProfileSetupRequired({ battery_profile_required: false, profile_resolved: false }), true);
  assert.equal(batteryProfileSetupRequired({ battery_profile_required: false, profile_resolved: true, profile_source: "pogo" }), false);
});
