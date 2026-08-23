export type BatteryProfileStatus = {
  soc_centi_percent?: unknown;
  soc_percent?: unknown;
  vbat_mv?: unknown;
  rate?: unknown;
  battery_present?: unknown;
  present?: unknown;
  profile_required?: unknown;
  battery_profile_required?: unknown;
  profile_resolved?: unknown;
  profile_source?: unknown;
  capacity_mah?: unknown;
  max_charge_current_ma?: unknown;
  temperature_monitoring?: unknown;
  thermal_monitoring_bypass?: unknown;
};

export type BatteryStatusViewModel = {
  socPercent: number | null;
  vbatMv: number | null;
  ratePercentPerHour: number | null;
  batteryPresent: boolean | null;
  profileSource: string | null;
  profileResolved: boolean | null;
  profileRequired: boolean | null;
  capacityMah: number | null;
  maxChargeCurrentMa: number | null;
  thermalMonitoringBypassed: boolean | null;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function normalizeBatteryStatus(status: BatteryProfileStatus): BatteryStatusViewModel {
  const socCentiPercent = finiteNumber(status.soc_centi_percent);
  const thermalMonitoring = optionalString(status.temperature_monitoring);
  const rate = finiteNumber(status.rate);
  return {
    socPercent: socCentiPercent === null ? finiteNumber(status.soc_percent) : socCentiPercent / 100,
    vbatMv: finiteNumber(status.vbat_mv),
    ratePercentPerHour: rate === null ? null : rate / 100,
    batteryPresent: optionalBoolean(status.battery_present) ?? optionalBoolean(status.present),
    profileSource: optionalString(status.profile_source),
    profileResolved: optionalBoolean(status.profile_resolved),
    profileRequired: optionalBoolean(status.profile_required) ?? optionalBoolean(status.battery_profile_required),
    capacityMah: finiteNumber(status.capacity_mah),
    maxChargeCurrentMa: finiteNumber(status.max_charge_current_ma),
    thermalMonitoringBypassed: thermalMonitoring === "bypassed" ? true : optionalBoolean(status.thermal_monitoring_bypass),
  };
}

export function batteryProfileSetupRequired(status: BatteryProfileStatus): boolean {
  const battery = normalizeBatteryStatus(status);
  return battery.profileRequired === true || battery.profileResolved === false;
}

export function batteryProfileValidationError(
  capacityChoice: "200" | "400" | "custom",
  customCapacity: string,
  maxChargeCurrent: string,
): "invalid_battery_profile" | null {
  const capacityMah = capacityChoice === "custom" ? Number(customCapacity) : Number(capacityChoice);
  const maxChargeCurrentMa = Number(maxChargeCurrent);
  return !Number.isInteger(capacityMah) || capacityMah <= 0 || !Number.isInteger(maxChargeCurrentMa) || maxChargeCurrentMa < 100 || maxChargeCurrentMa > 350 || maxChargeCurrentMa % 10 !== 0
    ? "invalid_battery_profile"
    : null;
}

export function buildBatteryProfileCommand(
  capacityChoice: "200" | "400" | "custom",
  customCapacity: string,
  maxChargeCurrent: string,
) {
  const validationError = batteryProfileValidationError(capacityChoice, customCapacity, maxChargeCurrent);
  if (validationError) {
    throw new Error(validationError);
  }
  const capacity_mah = capacityChoice === "custom" ? Number(customCapacity) : Number(capacityChoice);
  const max_charge_current_ma = Number(maxChargeCurrent);
  return { command: "set_battery_profile" as const, capacity_mah, max_charge_current_ma };
}
