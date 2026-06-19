export type CalibrationPrimaryStepId =
  | "enter_maintenance"
  | "start_session"
  | "capture_tare"
  | "capture_level"
  | "commit_session"
  | "enable_profile";

export type CalibrationPrimaryStepStatus = "complete" | "current" | "upcoming";

export type CalibrationDisabledReason =
  | "device_offline"
  | "needs_maintenance_mode"
  | "needs_active_session"
  | "needs_tare"
  | "needs_levels"
  | "needs_complete_profile"
  | "already_enabled"
  | "no_sensors";

export type CalibrationFlowSnapshot = {
  deviceConnected: boolean;
  maintenanceMode: boolean;
  sessionActive: boolean;
  profileComplete: boolean;
  profileEnabled: boolean;
  tareComplete: boolean;
  levelsComplete: boolean;
  totalSensors: number;
};

export type CalibrationPrimaryStepState = {
  id: CalibrationPrimaryStepId;
  status: CalibrationPrimaryStepStatus;
  disabledReason: CalibrationDisabledReason | null;
};

const PRIMARY_STEP_ORDER: CalibrationPrimaryStepId[] = [
  "enter_maintenance",
  "start_session",
  "capture_tare",
  "capture_level",
  "commit_session",
  "enable_profile",
];

export function getRecommendedCalibrationStep(snapshot: CalibrationFlowSnapshot): CalibrationPrimaryStepId | null {
  if (!snapshot.deviceConnected) return "enter_maintenance";
  if (!snapshot.maintenanceMode) return "enter_maintenance";
  if (snapshot.sessionActive) {
    if (!snapshot.tareComplete) return "capture_tare";
    if (!snapshot.levelsComplete) return "capture_level";
    return "commit_session";
  }
  if (!snapshot.profileComplete) return "start_session";
  if (!snapshot.profileEnabled) return "enable_profile";
  return null;
}

export function getPrimaryStepDisabledReason(
  step: CalibrationPrimaryStepId,
  snapshot: CalibrationFlowSnapshot,
): CalibrationDisabledReason | null {
  if (!snapshot.deviceConnected) return "device_offline";

  switch (step) {
    case "enter_maintenance":
      return null;
    case "start_session":
      return snapshot.maintenanceMode ? null : "needs_maintenance_mode";
    case "capture_tare":
      if (!snapshot.maintenanceMode) return "needs_maintenance_mode";
      if (!snapshot.sessionActive) return "needs_active_session";
      if (snapshot.totalSensors <= 0) return "no_sensors";
      return null;
    case "capture_level":
      if (!snapshot.maintenanceMode) return "needs_maintenance_mode";
      if (!snapshot.sessionActive) return "needs_active_session";
      if (!snapshot.tareComplete) return "needs_tare";
      if (snapshot.totalSensors <= 0) return "no_sensors";
      return null;
    case "commit_session":
      if (!snapshot.maintenanceMode) return "needs_maintenance_mode";
      if (!snapshot.sessionActive) return "needs_active_session";
      if (!snapshot.tareComplete) return "needs_tare";
      if (!snapshot.levelsComplete) return "needs_levels";
      return null;
    case "enable_profile":
      if (!snapshot.profileComplete) return "needs_complete_profile";
      if (snapshot.profileEnabled) return "already_enabled";
      return null;
  }
}

export function getPrimaryStepStates(snapshot: CalibrationFlowSnapshot): CalibrationPrimaryStepState[] {
  const recommended = getRecommendedCalibrationStep(snapshot);
  const currentIndex = recommended ? PRIMARY_STEP_ORDER.indexOf(recommended) : PRIMARY_STEP_ORDER.length;

  return PRIMARY_STEP_ORDER.map((id, index) => ({
    id,
    status: index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming",
    disabledReason: getPrimaryStepDisabledReason(id, snapshot),
  }));
}
