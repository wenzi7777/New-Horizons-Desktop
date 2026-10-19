import { useI18n } from "../i18n";
import type { BoardPinSlot } from "../lib/boardProfile";
import { formatBucketRange, formatMicros, rssiQuality, scanHealthView, scanRateLow, type AdcUnitHealth } from "../lib/scanHealth";
import {
  HealthBars,
  HealthGroup,
  HealthGroups,
  HealthRow,
  HealthStat,
  HealthSummary,
  formatCount,
  formatPercent,
  type HealthTone,
} from "./HealthParts";

// Scan, stream and ADC diagnostics from the firmware's `scan_health`, which
// also rides every `status` -- so this card only renders; Refresh asks for a
// fresh copy.

type Props = {
  scanHealth: Record<string, unknown>;
  wifi: Record<string, unknown>;
  analogPins: number[];
  analogPinSlots: BoardPinSlot[];
  busy: boolean;
  disabled: boolean;
  onRefresh: () => void;
};

export function ScanHealthCard({ scanHealth, wifi, analogPins, analogPinSlots, busy, disabled, onRefresh }: Props) {
  const { t } = useI18n();
  const view = scanHealthView(scanHealth, analogPins);
  const hasData = view.producedFrames !== null || view.actualFps !== null;

  const pinLabel = (gpio: number) => analogPinSlots.find((slot) => slot.gpio === gpio)?.label ?? `GPIO${gpio}`;
  const adcErrorTotal = view.adc ? view.adc.reduce((sum, unit) => sum + unit.readErrors, 0) : null;
  const rateLow = scanRateLow(view);
  const quality = rssiQuality(wifi.rssi);
  const connected = wifi.connected === true;

  const adcRow = (unit: AdcUnitHealth) => {
    const lines = unit.gpios.map(pinLabel).join(", ");
    let tone: HealthTone = "neutral";
    let value: string;
    if (unit.calDigi === 0) {
      tone = "warn";
      value = t("adcNoCalibration");
    } else if (unit.readErrors > 0) {
      tone = "warn";
      value = t("adcReadErrorsValue").replace("{count}", formatCount(unit.readErrors));
    } else {
      value = t("adcReadOk");
    }
    return (
      <HealthRow
        key={unit.unit}
        label={`ADC${unit.unit}`}
        hint={lines ? t("adcLinesInUse").replace("{lines}", lines) : t("adcUnitUnused")}
        tone={tone}
        value={
          <>
            {value}
            <small>{t("adcCalPoint").replace("{digi}", unit.calDigi > 0 ? String(unit.calDigi) : "-")}</small>
          </>
        }
      />
    );
  };

  return (
    <div className="settings-card">
      <div className="settings-detail-header">
        <div>
          <h4>{t("scanHealthTitle")}</h4>
          <p>{t("scanHealthCopy")}</p>
        </div>
        <button className="button" type="button" disabled={busy || disabled} onClick={onRefresh}>
          {busy ? t("running") : t("refresh")}
        </button>
      </div>
      {!hasData ? (
        <p className="service-muted">{t("scanHealthEmpty")}</p>
      ) : (
        <>
          <HealthSummary>
            <HealthStat
              label={t("scanHealthRate")}
              value={view.actualFps !== null ? `${view.actualFps} fps` : "-"}
              sub={view.targetFps !== null ? t("scanHealthTarget").replace("{fps}", String(view.targetFps)) : undefined}
              tone={rateLow ? "warn" : "neutral"}
            />
            <HealthStat
              label={t("overrunFrames")}
              value={formatCount(view.overrunFrames)}
              sub={view.budgetUs !== null ? t("scanHealthBudget").replace("{budget}", formatMicros(view.budgetUs)) : undefined}
              tone={view.overrunFrames ? "warn" : "neutral"}
            />
            <HealthStat
              label={t("udpSendFailures")}
              value={formatCount(view.udpFailures)}
              sub={view.udpSent !== null ? t("scanHealthSent").replace("{count}", formatCount(view.udpSent)) : undefined}
              tone={view.udpFailures ? "warn" : "neutral"}
            />
            <HealthStat
              label={t("adcReadErrors")}
              value={adcErrorTotal !== null ? formatCount(adcErrorTotal) : "-"}
              sub={
                view.adc
                  ? view.adc.map((unit) => `ADC${unit.unit} ${formatCount(unit.readErrors)}`).join(" · ")
                  : t("adcNotReported")
              }
              tone={adcErrorTotal ? "warn" : "neutral"}
            />
          </HealthSummary>
          <HealthGroups>
            <HealthGroup title={t("scanHealthGroupTiming")}>
              <HealthRow label={t("actualScanFps")} value={view.actualFps !== null ? `${view.actualFps} fps` : "-"} tone={rateLow ? "warn" : "neutral"} />
              <HealthRow label={t("targetFps")} value={view.targetFps !== null ? `${view.targetFps} fps` : "-"} />
              <HealthRow label={t("scanHealthBudgetLabel")} value={formatMicros(view.budgetUs)} />
              <HealthRow label={t("scanHealthLastScan")} value={formatMicros(view.lastScanUs)} />
              <HealthRow
                label={t("scanHealthMaxScan")}
                value={formatMicros(view.maxScanUs)}
                tone={view.maxScanUs !== null && view.budgetUs !== null && view.maxScanUs > view.budgetUs ? "warn" : "neutral"}
              />
              <HealthRow label={t("overrunFrames")} value={formatCount(view.overrunFrames)} tone={view.overrunFrames ? "warn" : "neutral"} />
              <HealthRow label={t("scanHealthProduced")} value={formatCount(view.producedFrames)} />
            </HealthGroup>
            {view.lateness ? (
              <HealthGroup title={t("scanHealthGroupLateness")} footnote={t("scanHealthLatenessNote")}>
                <HealthRow
                  label={t("scanLateStarts")}
                  value={`${formatPercent(view.lateness.lateShare)} · ${formatCount(view.lateness.late)} / ${formatCount(view.lateness.samples)}`}
                />
                <HealthRow label={t("scanHealthWorstStart")} value={formatMicros(view.lateness.maxUs)} />
                <HealthRow label={t("scanHealthRecentWorst")} value={formatMicros(view.lateness.recentMaxUs)} />
                <HealthRow label={t("scanLatenessGaps")} value={formatCount(view.lateness.gaps)} />
                {view.lateness.buckets.length > 0 ? (
                  <HealthBars
                    rows={view.lateness.buckets.map((bucket) => ({
                      label: formatBucketRange(bucket),
                      share: bucket.share,
                      value: formatPercent(bucket.share),
                    }))}
                  />
                ) : null}
              </HealthGroup>
            ) : null}
            <HealthGroup title={t("scanHealthGroupAdc")} footnote={view.adc ? t("adcFootnote") : undefined}>
              {view.adc ? view.adc.map(adcRow) : <HealthRow label="ADC" value={t("adcNotReported")} />}
            </HealthGroup>
            <HealthGroup title={t("scanHealthGroupTransport")}>
              <HealthRow label={t("udpSentFrames")} value={formatCount(view.udpSent)} />
              <HealthRow label={t("udpSendFailures")} value={formatCount(view.udpFailures)} tone={view.udpFailures ? "warn" : "neutral"} />
              <HealthRow label={t("scanHealthLastSend")} value={formatMicros(view.lastUdpSendUs)} />
              <HealthRow
                label={t("scanHealthQueue")}
                value={
                  view.queueCapacity
                    ? `${formatCount(view.queueOccupied)} / ${formatCount(view.queueCapacity)}`
                    : t("scanHealthQueueOff")
                }
                hint={view.queueCapacity ? t("scanHealthQueuePeak").replace("{count}", formatCount(view.queueMaxOccupied)) : undefined}
              />
              <HealthRow label={t("streamBufferQueueDropped")} value={formatCount(view.queueDropped)} tone={view.queueDropped ? "warn" : "neutral"} />
            </HealthGroup>
            <HealthGroup title={t("scanHealthGroupNetwork")}>
              <HealthRow label="Wi-Fi" value={connected ? t("wifiConnectedState") : t("wifiDisconnectedState")} tone={connected ? "neutral" : "warn"} />
              <HealthRow label="IP" value={typeof wifi.ip === "string" && wifi.ip ? wifi.ip : "-"} />
              <HealthRow
                label={t("scanHealthSignal")}
                value={typeof wifi.rssi === "number" && quality ? `${wifi.rssi} dBm · ${t(`rssiQuality_${quality}`)}` : "-"}
                tone={quality === "weak" ? "warn" : "neutral"}
              />
            </HealthGroup>
          </HealthGroups>
        </>
      )}
    </div>
  );
}
