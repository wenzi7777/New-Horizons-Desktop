import assert from "node:assert/strict";
import test from "node:test";

import {
  getPrimaryStepDisabledReason,
  getPrimaryStepStates,
  getRecommendedCalibrationStep,
} from "../src/lib/calibrationFlow.ts";

function makeSnapshot(overrides = {}) {
  return {
    deviceConnected: true,
    maintenanceMode: false,
    sessionActive: false,
    profileComplete: false,
    profileEnabled: false,
    tareComplete: false,
    levelsComplete: false,
    totalSensors: 16,
    ...overrides,
  };
}

test("recommends entering maintenance first when the device is online but not in maintenance mode", () => {
  assert.equal(getRecommendedCalibrationStep(makeSnapshot()), "enter_maintenance");
});

test("recommends starting a session after maintenance mode is active", () => {
  assert.equal(
    getRecommendedCalibrationStep(makeSnapshot({ maintenanceMode: true })),
    "start_session",
  );
});

test("recommends capturing tare when a session is active without tare", () => {
  assert.equal(
    getRecommendedCalibrationStep(makeSnapshot({ maintenanceMode: true, sessionActive: true })),
    "capture_tare",
  );
});

test("recommends level capture after tare is complete but levels are still incomplete", () => {
  assert.equal(
    getRecommendedCalibrationStep(
      makeSnapshot({ maintenanceMode: true, sessionActive: true, tareComplete: true }),
    ),
    "capture_level",
  );
});

test("recommends committing the session after tare and levels are complete", () => {
  assert.equal(
    getRecommendedCalibrationStep(
      makeSnapshot({
        maintenanceMode: true,
        sessionActive: true,
        tareComplete: true,
        levelsComplete: true,
      }),
    ),
    "commit_session",
  );
});

test("recommends enabling the profile after a complete profile exists but is disabled", () => {
  assert.equal(
    getRecommendedCalibrationStep(
      makeSnapshot({
        maintenanceMode: true,
        profileComplete: true,
        tareComplete: true,
        levelsComplete: true,
      }),
    ),
    "enable_profile",
  );
});

test("marks all primary steps complete when the profile is already enabled", () => {
  const steps = getPrimaryStepStates(
    makeSnapshot({
      maintenanceMode: true,
      profileComplete: true,
      profileEnabled: true,
      tareComplete: true,
      levelsComplete: true,
    }),
  );

  assert.deepEqual(
    steps.map((step) => step.status),
    ["complete", "complete", "complete", "complete", "complete", "complete"],
  );
});

test("returns a disabled reason for offline primary actions", () => {
  assert.equal(
    getPrimaryStepDisabledReason("enter_maintenance", makeSnapshot({ deviceConnected: false })),
    "device_offline",
  );
});

test("requires an active session before level capture can run", () => {
  assert.equal(
    getPrimaryStepDisabledReason(
      "capture_level",
      makeSnapshot({ maintenanceMode: true, tareComplete: true }),
    ),
    "needs_active_session",
  );
});
