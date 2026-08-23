import assert from "node:assert/strict";
import test from "node:test";

import {
  batteryProfileSetupRequired,
  batteryProfileValidationError,
  buildBatteryProfileCommand,
  buildBatteryProfileDetectionCommand,
  normalizeBatteryStatus,
} from "../src/lib/batteryProfile.ts";

test("builds a set_battery_profile command with a positive custom capacity and 10mA current increment", () => {
  assert.deepEqual(buildBatteryProfileCommand("custom", "650", "230"), {
    command: "set_battery_profile",
    capacity_mah: 650,
    max_charge_current_ma: 230,
  });
});

test("builds an explicit battery-ID detection command without changing manual settings", () => {
  assert.deepEqual(buildBatteryProfileDetectionCommand(), {
    command: "detect_battery_profile",
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

test("normalizes the canonical Task 1 firmware battery status into display values", () => {
  const battery = normalizeBatteryStatus({
    gauge: "max17048",
    battery_present: true,
    vbat_mv: 4175,
    soc_centi_percent: 7350,
    rate: -208,
    profile_source: "manual",
    profile_resolved: false,
    profile_required: true,
    capacity_mah: 400,
    max_charge_current_ma: 200,
    temperature_monitoring: "bypassed",
  });

  assert.deepEqual(battery, {
    socPercent: 73.5,
    vbatMv: 4175,
    ratePercentPerHour: -2.08,
    batteryPresent: true,
    profileSource: "manual",
    profileResolved: false,
    profileRequired: true,
    capacityMah: 400,
    maxChargeCurrentMa: 200,
    thermalMonitoringBypassed: true,
  });
});

test("accepts prior battery field aliases without inventing unavailable gauge data", () => {
  const battery = normalizeBatteryStatus({
    soc_percent: 61.25,
    present: false,
    battery_profile_required: true,
    thermal_monitoring_bypass: false,
  });

  assert.equal(battery.socPercent, 61.25);
  assert.equal(battery.batteryPresent, false);
  assert.equal(battery.profileRequired, true);
  assert.equal(battery.thermalMonitoringBypassed, false);
  assert.equal(battery.ratePercentPerHour, null);
});

test("reports an inline validation error before an invalid manual profile can be dispatched", () => {
  assert.equal(batteryProfileValidationError("custom", "", "230"), "invalid_battery_profile");
  assert.equal(batteryProfileValidationError("400", "", "230"), null);
});
