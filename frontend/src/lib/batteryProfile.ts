export type BatteryProfileStatus = {
  battery_profile_required?: unknown;
  profile_resolved?: unknown;
  profile_source?: unknown;
};

export function batteryProfileSetupRequired(status: BatteryProfileStatus): boolean {
  return status.battery_profile_required === true || status.profile_resolved === false;
}

export function buildBatteryProfileCommand(
  capacityChoice: "200" | "400" | "custom",
  customCapacity: string,
  maxChargeCurrent: string,
) {
  const capacity_mah = capacityChoice === "custom" ? Number(customCapacity) : Number(capacityChoice);
  const max_charge_current_ma = Number(maxChargeCurrent);
  if (!Number.isInteger(capacity_mah) || capacity_mah <= 0 || !Number.isInteger(max_charge_current_ma) || max_charge_current_ma < 100 || max_charge_current_ma > 350 || max_charge_current_ma % 10 !== 0) {
    throw new Error("invalid_battery_profile");
  }
  return { command: "set_battery_profile" as const, capacity_mah, max_charge_current_ma };
}
