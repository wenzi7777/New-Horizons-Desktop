import assert from "node:assert/strict";
import test from "node:test";
import * as batteryProfileModule from "../src/lib/batteryProfile.ts";

import {
  batteryProfileSetupRequired,
  batteryProfileValidationError,
  buildBatteryProfileCommand,
  buildBatteryProfileDetectionCommand,
  buildBatteryGaugeResyncCommand,
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

test("builds a distinct MAX17048 fuel-gauge resync command", () => {
  assert.deepEqual(buildBatteryGaugeResyncCommand(), {
    command: "resync_battery_gauge",
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
    syncState: null,
    lastSyncReason: null,
    syncCount: null,
  });
});

test("hides stale gauge measurements while resyncing or after a resync error", () => {
  for (const gauge_sync_state of ["syncing", "error"]) {
    const battery = normalizeBatteryStatus({
      sample_valid: false,
      battery_present: null,
      vbat_mv: 4175,
      soc_centi_percent: 7350,
      rate: -208,
      gauge_sync_state,
      last_sync_reason: "manual",
      gauge_sync_count: 4,
    });

    assert.equal(battery.socPercent, null);
    assert.equal(battery.vbatMv, null);
    assert.equal(battery.ratePercentPerHour, null);
    assert.equal(battery.batteryPresent, null);
    assert.equal(battery.syncState, gauge_sync_state);
    assert.equal(battery.lastSyncReason, "manual");
    assert.equal(battery.syncCount, 4);
  }
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

test("clamps the visual battery fill to the measured percentage without inventing a value", () => {
  assert.equal(typeof batteryProfileModule.batteryFillPercent, "function");
  assert.equal(batteryProfileModule.batteryFillPercent(null), null);
  assert.equal(batteryProfileModule.batteryFillPercent(0), 0);
  assert.equal(batteryProfileModule.batteryFillPercent(48.6), 48.6);
  assert.equal(batteryProfileModule.batteryFillPercent(100), 100);
  assert.equal(batteryProfileModule.batteryFillPercent(-12), 0);
  assert.equal(batteryProfileModule.batteryFillPercent(126), 100);
});

test("creates a dynamic battery indicator only for a board that declares support", () => {
  assert.equal(typeof batteryProfileModule.batteryIndicatorState, "function");
  assert.equal(batteryProfileModule.batteryIndicatorState(false, 64.2, true), null);
  assert.deepEqual(batteryProfileModule.batteryIndicatorState(true, 64.2, true), {
    fillPercent: 64.2,
    label: "64%",
    charging: true,
  });
  assert.deepEqual(batteryProfileModule.batteryIndicatorState(true, null, false), {
    fillPercent: null,
    label: null,
    charging: false,
  });
});

test("reports an inline validation error before an invalid manual profile can be dispatched", () => {
  assert.equal(batteryProfileValidationError("custom", "", "230"), "invalid_battery_profile");
  assert.equal(batteryProfileValidationError("400", "", "230"), null);
});

test("estimates remaining and charging time from MAX17048 SoC and rate without inventing an estimate", () => {
  assert.equal(typeof batteryProfileModule.estimateBatteryTime, "function");
  assert.deepEqual(
    batteryProfileModule.estimateBatteryTime({ socPercent: 73.5, ratePercentPerHour: -2.1, batteryPresent: true }, "not_charging"),
    { kind: "remaining", minutes: 2100 },
  );
  assert.deepEqual(
    batteryProfileModule.estimateBatteryTime({ socPercent: 70, ratePercentPerHour: 2.5, batteryPresent: true }, "charging"),
    { kind: "until_full", minutes: 720 },
  );
  assert.deepEqual(
    batteryProfileModule.estimateBatteryTime({ socPercent: 100, ratePercentPerHour: 0, batteryPresent: true }, "charge_done"),
    { kind: "full" },
  );
  assert.deepEqual(
    batteryProfileModule.estimateBatteryTime({ socPercent: 70, ratePercentPerHour: 0, batteryPresent: true }, "not_charging"),
    { kind: "unavailable" },
  );
  assert.deepEqual(
    batteryProfileModule.estimateBatteryTime({ socPercent: 70, ratePercentPerHour: -2, batteryPresent: false }, "not_charging"),
    { kind: "unavailable" },
  );
});

test("builds only safe persisted low-battery threshold commands", () => {
  assert.equal(typeof batteryProfileModule.buildBatteryLedThresholdCommand, "function");
  assert.deepEqual(batteryProfileModule.buildBatteryLedThresholdCommand(10), {
    command: "set_indicators",
    battery_led: { low_battery_threshold_percent: 10 },
  });
  assert.deepEqual(batteryProfileModule.buildBatteryLedThresholdCommand(0), {
    command: "set_indicators",
    battery_led: { low_battery_threshold_percent: 0 },
  });
  assert.throws(() => batteryProfileModule.buildBatteryLedThresholdCommand(26), /invalid_low_battery_threshold/);
  assert.throws(() => batteryProfileModule.buildBatteryLedThresholdCommand(1.5), /invalid_low_battery_threshold/);
});
