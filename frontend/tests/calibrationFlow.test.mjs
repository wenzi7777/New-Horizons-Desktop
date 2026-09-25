import assert from "node:assert/strict";
import test from "node:test";

import {
  calibrationErrorKey,
  calibrationSnapshotKey,
  canSaveCalibration,
  chooseCalibrationState,
  getCalibrationStep,
  isFullCalibrationStatus,
  parseCalibrationState,
  zeroBlockedReason,
} from "../src/lib/calibrationFlow.ts";

function status(overrides = {}) {
  return {
    enabled: false,
    mode_active: true,
    session_active: false,
    complete: false,
    tare_complete: false,
    levels_complete: false,
    legacy_missing_tare: false,
    tare_enabled: false,
    output_mode: "raw",
    tare: { captured_points: 0, total_points: 16, missing_points: 16, complete: false, source: "saved" },
    draft_tare: { captured_points: 0, total_points: 16, missing_points: 16, complete: false, source: "draft" },
    levels: [],
    draft_levels: [],
    metadata: {},
    ...overrides,
  };
}

const completeTare = { captured_points: 16, total_points: 16, missing_points: 0, complete: true, source: "draft" };

test("a command reply wins over the snapshot it was taken against", () => {
  // The bug: the page adopted the begin reply, then an effect put the older
  // snapshot (session_active: false) back until the page was reloaded.
  const snapshot = { ...status() };
  const override = {
    state: parseCalibrationState(status({ session_active: true })),
    snapshotKey: calibrationSnapshotKey(snapshot),
  };
  assert.equal(chooseCalibrationState({ ...snapshot }, override).session_active, true);
});

test("a newer snapshot replaces the reply", () => {
  const snapshot = status();
  const override = {
    state: parseCalibrationState(status({ session_active: true })),
    snapshotKey: calibrationSnapshotKey(snapshot),
  };
  const newer = status({ session_active: false, enabled: true, complete: true });
  const chosen = chooseCalibrationState(newer, override);
  assert.equal(chosen.session_active, false);
  assert.equal(chosen.enabled, true);
});

test("the snapshot is used when there is no reply", () => {
  assert.equal(chooseCalibrationState(status({ session_active: true }), null).session_active, true);
  assert.equal(chooseCalibrationState({}, null).session_active, false);
});

test("reads a status nested under calibration or at the top level", () => {
  assert.equal(parseCalibrationState({ calibration: status({ enabled: true }) }).enabled, true);
  assert.equal(parseCalibrationState(status({ enabled: true })).enabled, true);
});

test("only a full calibration status counts as one", () => {
  assert.equal(isFullCalibrationStatus(status()), true);
  // capture/dump replies
  assert.equal(isFullCalibrationStatus({ total_points: 16, saved: null, draft: null, session_active: true }), false);
  assert.equal(isFullCalibrationStatus(null), false);
});

test("output mode is derived for firmware that does not report it", () => {
  const legacy = status();
  delete legacy.output_mode;
  delete legacy.tare_enabled;
  assert.equal(parseCalibrationState(legacy).output_mode, "raw");
  assert.equal(parseCalibrationState(legacy).output_mode_reported, false);
  assert.equal(parseCalibrationState({ ...legacy, enabled: true, complete: true }).output_mode, "calibrated");
  assert.equal(parseCalibrationState(status({ output_mode: "tared" })).output_mode, "tared");
  assert.equal(parseCalibrationState(status({ output_mode: "tared" })).output_mode_reported, true);
});

test("the flow is not started, then baseline, then pressures", () => {
  assert.equal(getCalibrationStep({ sessionActive: false, draftTareComplete: false, baselineConfirmed: false }), "not_started");
  assert.equal(getCalibrationStep({ sessionActive: true, draftTareComplete: false, baselineConfirmed: false }), "baseline");
  // A draft copied from an existing profile already has a baseline, but it is
  // only used once the operator captures a new one or chooses to keep it.
  assert.equal(getCalibrationStep({ sessionActive: true, draftTareComplete: true, baselineConfirmed: false }), "baseline");
  assert.equal(getCalibrationStep({ sessionActive: true, draftTareComplete: true, baselineConfirmed: true }), "levels");
});

test("save needs a baseline and every pressure captured on every sensor", () => {
  const level = (complete) => ({ level: 10, captured_points: complete ? 16 : 3, total_points: 16, missing_points: complete ? 0 : 13, complete, source: "draft" });
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: true, draft_tare: completeTare }))), false);
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: true, draft_tare: completeTare, draft_levels: [level(false)] }))), false);
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: true, draft_tare: completeTare, draft_levels: [level(true)] }))), true);
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: false, draft_tare: completeTare, draft_levels: [level(true)] }))), false);
});

test("zero is blocked offline and during a calibration only", () => {
  assert.equal(zeroBlockedReason(false, parseCalibrationState(status())), "device_offline");
  assert.equal(zeroBlockedReason(true, parseCalibrationState(status({ session_active: true }))), "session_active");
  // No maintenance mode needed.
  assert.equal(zeroBlockedReason(true, parseCalibrationState(status({ mode_active: false }))), null);
});

test("error codes map to readable messages", () => {
  assert.equal(calibrationErrorKey("calibration_tare_required"), "calErrorTareRequired");
  assert.equal(calibrationErrorKey("no_response"), "calErrorNoResponse");
  assert.equal(calibrationErrorKey(""), "calErrorNoResponse");
  assert.equal(calibrationErrorKey("something_else"), "calErrorGeneric");
});
