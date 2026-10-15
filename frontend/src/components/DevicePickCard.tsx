import type { ReactNode } from "react";

import { DeviceBatteryChip } from "./DeviceBatteryChip";
import type { DeviceEntry } from "../lib/api";
import { deviceBatteryReadout } from "../lib/batteryProfile";
import { boardProfileForHardwareModel, displayHardwareModel } from "../lib/boardProfile";
import { isHubRelayed, normalizeDevice, type NormalizedDevice } from "../lib/device";
import { connectionStateLabel, deviceClassName, statusDot } from "../lib/deviceStatus";

// One device in a picker: the Visualization "add device view" dialog and the
// App Store install dialog show the same card, so a device looks the same
// wherever it is chosen.

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function DevicePickCard({
  entry,
  device = normalizeDevice(entry),
  footer,
  disabled = false,
  selected = false,
  onClick,
  t,
}: {
  entry: DeviceEntry;
  device?: NormalizedDevice;
  // The last cell: what picking it does, or why it cannot be picked.
  footer: ReactNode;
  disabled?: boolean;
  selected?: boolean;
  onClick: () => void;
  t: (key: string) => string;
}) {
  const status = recordValue(entry.last_status);
  const batteryReadout = deviceBatteryReadout({
    supported: boardProfileForHardwareModel(device.hardwareModel).supportsBatteryPercentageIndicator,
    battery: recordValue(status.battery),
    power: recordValue(status.power),
    batteryLed: recordValue(recordValue(status.indicators).battery_led),
  });
  return (
    <button
      className={`device-card device-pick-card ${deviceClassName(device)}${selected ? " is-selected" : ""}`}
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
    >
      <div className="device-card-header">
        <h3>
          <span className={statusDot(device)} aria-hidden="true" />
          {device.displayName}
        </h3>
        <span className={`device-badge ${deviceClassName(device)}`}>{connectionStateLabel(device, t)}</span>
        {isHubRelayed(entry) ? <span className="device-badge hub-relay">{t("deviceViaHub")}</span> : null}
      </div>
      <div className="device-uid">{entry.device_uid}</div>
      <div className="device-meta-grid">
        <span>{t("hardwareModel")}: {displayHardwareModel(device.hardwareModel)}</span>
        <span>{t("firmwareVersion")}: {device.firmwareVersion}</span>
        <span>{t("protocol")}: {device.protocol}</span>
        <span>{t("matrixShape")}: {device.matrixShape}</span>
        <span className="device-battery-reading">
          <DeviceBatteryChip readout={batteryReadout} t={t} />
        </span>
        <span>{t("transport")}: {device.transportMode}</span>
        <span>{t("lastSeen")}: {device.lastSeen}</span>
        <span className="device-pick-footer">{footer}</span>
      </div>
    </button>
  );
}
