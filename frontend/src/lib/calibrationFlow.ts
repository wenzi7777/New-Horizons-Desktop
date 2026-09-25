// Calibration state and the pressure-calibration flow, kept free of React so
// the rules can be tested directly.
//
// The device reports calibration in two places: the `calibration` block of
// its status (what the device snapshot carries), and the full calibration
// status most calibration_* commands answer with. A command reply is newer
// than the snapshot until the snapshot moves on, so the page shows the reply
// first -- that is what makes "Start calibration" take effect without a
// reload.

export type CalibrationOutputMode = "raw" | "tared" | "calibrated";

export type CalibrationCaptureSummary = {
  captured_points: number;
  total_points: number;
  missing_points: number;
  complete: boolean;
  source: string;
};

export type CalibrationSummary = CalibrationCaptureSummary & {
  level: number;
};

export type CalibrationState = {
  enabled: boolean;
  mode_active: boolean;
  session_active: boolean;
  complete: boolean;
  tare_complete: boolean;
  levels_complete: boolean;
  legacy_missing_tare: boolean;
  // Firmware before v1.5.1 reports neither; `output_mode` is then derived.
  tare_enabled: boolean | null;
  output_mode: CalibrationOutputMode;
  output_mode_reported: boolean;
  tare: CalibrationCaptureSummary | null;
  draft_tare: CalibrationCaptureSummary | null;
  levels: CalibrationSummary[];
  draft_levels: CalibrationSummary[];
  metadata: Record<string, unknown>;
};

export type CalibrationStep = "not_started" | "baseline" | "levels";

export type CalibrationFlowSnapshot = {
  sessionActive: boolean;
  draftTareComplete: boolean;
  // The operator captured (or chose to keep) the baseline in this session.
  baselineConfirmed: boolean;
};

export type CalibrationOverride = {
  state: CalibrationState;
  // The snapshot's calibration block when the reply arrived.
  snapshotKey: string;
};

const CALIBRATION_STATUS_KEYS = [
  "enabled",
  "mode_active",
  "session_active",
  "complete",
  "tare_complete",
  "levels_complete",
  "legacy_missing_tare",
  "tare_enabled",
  "output_mode",
  "tare",
  "draft_tare",
  "levels",
  "draft_levels",
  "metadata",
];

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function calibrationSource(value: unknown) {
  const direct = recordValue(value);
  const nested = recordValue(direct.calibration);
  if (Object.keys(nested).length > 0) {
    return nested;
  }
  return CALIBRATION_STATUS_KEYS.some((key) => key in direct) ? direct : {};
}

// A calibration_* reply that carries the whole calibration status (begin,
// abort, commit, enable, the one-tap zero...). Capture and dump replies carry
// other shapes and are not a status.
export function isFullCalibrationStatus(value: unknown) {
  const source = calibrationSource(value);
  return ["enabled", "session_active", "tare_complete", "levels"].every((key) => key in source);
}

function parseCaptureSummary(value: unknown, fallbackSource: string): CalibrationCaptureSummary | null {
  const source = recordValue(value);
  if (Object.keys(source).length === 0) return null;
  return {
    captured_points: numberValue(source.captured_points, 0),
    total_points: numberValue(source.total_points, 0),
    missing_points: numberValue(source.missing_points, 0),
    complete: source.complete === true,
    source: typeof source.source === "string" ? source.source : fallbackSource,
  };
}

function parseSummaryList(value: unknown, fallbackSource: string): CalibrationSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => recordValue(item))
    .filter((item) => Object.keys(item).length > 0)
    .map((item) => ({
      level: numberValue(item.level, 0),
      captured_points: numberValue(item.captured_points, 0),
      total_points: numberValue(item.total_points, 0),
      missing_points: numberValue(item.missing_points, 0),
      complete: item.complete === true,
      source: typeof item.source === "string" ? item.source : fallbackSource,
    }))
    .sort((a, b) => a.level - b.level);
}

export function parseCalibrationState(value: unknown): CalibrationState {
  const source = calibrationSource(value);
  const enabled = source.enabled === true;
  const complete = source.complete === true;
  const reportedMode = source.output_mode;
  const outputModeReported = reportedMode === "raw" || reportedMode === "tared" || reportedMode === "calibrated";
  return {
    enabled,
    mode_active: source.mode_active === true,
    session_active: source.session_active === true,
    complete,
    tare_complete: source.tare_complete === true,
    levels_complete: source.levels_complete === true,
    legacy_missing_tare: source.legacy_missing_tare === true,
    tare_enabled: typeof source.tare_enabled === "boolean" ? source.tare_enabled : null,
    output_mode: outputModeReported ? reportedMode as CalibrationOutputMode : enabled && complete ? "calibrated" : "raw",
    output_mode_reported: outputModeReported,
    tare: parseCaptureSummary(source.tare, "saved"),
    draft_tare: parseCaptureSummary(source.draft_tare, "draft"),
    levels: parseSummaryList(source.levels, "saved"),
    draft_levels: parseSummaryList(source.draft_levels, "draft"),
    metadata: recordValue(source.metadata),
  };
}

// A stable key for the snapshot's calibration block, so a newer snapshot can
// be told apart from the one an override was taken against.
export function calibrationSnapshotKey(value: unknown) {
  try {
    return JSON.stringify(calibrationSource(value));
  } catch {
    return "";
  }
}

// The state to show: a command reply until the snapshot changes after it.
export function chooseCalibrationState(snapshot: unknown, override: CalibrationOverride | null): CalibrationState {
  if (override && override.snapshotKey === calibrationSnapshotKey(snapshot)) {
    return override.state;
  }
  return parseCalibrationState(snapshot);
}

export function getCalibrationStep(snapshot: CalibrationFlowSnapshot): CalibrationStep {
  if (!snapshot.sessionActive) return "not_started";
  if (!snapshot.draftTareComplete || !snapshot.baselineConfirmed) return "baseline";
  return "levels";
}

// Save needs a baseline and at least one pressure, with every draft pressure
// captured on every sensor -- the firmware refuses auto_enable otherwise.
export function canSaveCalibration(state: CalibrationState) {
  const draftTareComplete = state.draft_tare?.complete === true;
  return state.session_active
    && draftTareComplete
    && state.draft_levels.length > 0
    && state.draft_levels.every((item) => item.complete);
}

export type ZeroBlockedReason = "device_offline" | "session_active";

export function zeroBlockedReason(deviceConnected: boolean, state: CalibrationState): ZeroBlockedReason | null {
  if (!deviceConnected) return "device_offline";
  if (state.session_active) return "session_active";
  return null;
}

// i18n key for a firmware/transport error code from a calibration command.
export function calibrationErrorKey(code: string) {
  switch (code) {
    case "calibration_tare_required":
      return "calErrorTareRequired";
    case "calibration_session_active":
      return "calErrorSessionActive";
    case "calibration_incomplete":
      return "calErrorIncomplete";
    case "maintenance_required":
      return "calErrorMaintenanceRequired";
    case "":
    case "no_response":
      return "calErrorNoResponse";
    default:
      return "calErrorGeneric";
  }
}
