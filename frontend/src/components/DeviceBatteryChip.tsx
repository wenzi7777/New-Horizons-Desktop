import { durationLabel, type DeviceBatteryReadout } from "../lib/batteryProfile";
import { BatteryStatusIndicator } from "./BatteryStatusIndicator";

type DeviceBatteryChipProps = {
  readout: DeviceBatteryReadout;
  t: (key: string) => string;
};

function estimateLabel(readout: DeviceBatteryReadout, t: (key: string) => string) {
  switch (readout.estimate.kind) {
    case "remaining":
      return `${t("batteryEstimatedRemaining")} · ${durationLabel(readout.estimate.minutes)}`;
    case "until_full":
      return `${t("batteryEstimatedUntilFull")} · ${durationLabel(readout.estimate.minutes)}`;
    case "full":
      return t("batteryFull");
    default:
      return t("batteryEstimateUnavailable");
  }
}

export function DeviceBatteryChip({ readout, t }: DeviceBatteryChipProps) {
  // Boards without a MAX17048 fuel gauge keep the slot so cards stay aligned
  // across hardware, but say plainly that it is the board and not a failed read.
  if (!readout.supported) {
    return (
      <span
        className="visualization-battery-chip unsupported"
        role="img"
        aria-label={`${t("battery")}: ${t("unsupportedOnThisBoard")}`}
        title={t("unsupportedOnThisBoard")}
      >
        <span aria-hidden="true">
          <BatteryStatusIndicator fillPercent={null} charging={false} ariaLabel="" />
        </span>
        <span aria-hidden="true">{t("batteryUnsupportedShort")}</span>
      </span>
    );
  }

  const detail = readout.syncing ? t("batteryGaugeSyncing") : estimateLabel(readout, t);
  const percentLabel = readout.syncing
    ? "—"
    : readout.socPercent === null
      ? t("batteryUnknown")
      : `${Math.round(readout.socPercent)}%`;
  const warning = readout.lowBattery ? `${t("batteryLowWarning")}, ` : "";

  return (
    <span
      className={`visualization-battery-chip${readout.lowBattery ? " low" : ""}`}
      role="img"
      aria-label={`${warning}${t("battery")}: ${percentLabel}, ${detail}`}
      title={detail}
    >
      <span aria-hidden="true">
        <BatteryStatusIndicator fillPercent={readout.socPercent} charging={readout.charging} ariaLabel="" />
      </span>
      <span aria-hidden="true">{percentLabel}</span>
    </span>
  );
}
