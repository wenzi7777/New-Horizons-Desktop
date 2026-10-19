import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../i18n";
import { quietCommand } from "../lib/deviceCommand";
import { isFaultReset } from "../lib/scanHealth";
import { HealthCallout, HealthGroup, HealthGroups, HealthRow, HealthStat, HealthSummary, formatCount } from "./HealthParts";

// Device health from the firmware's `health` command (v1.9.0+).
// Kept out of `status` on the device side, so this card fetches and holds its
// own copy -- the page's last_result is overwritten by the next status poll.

type HealthRun = (
  label: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<{ queued?: unknown; result?: Record<string, unknown> | null }>;

type Props = {
  deviceUid: string;
  disabled: boolean;
  run: HealthRun;
  // Relayed by a Hub (ESP-NOW): its link-quality counters are always shown.
  espNow?: boolean;
};

type Snapshot = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function durationLabel(value: unknown): string {
  const seconds = num(value);
  if (seconds === null) return "-";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes} m`;
  return `${hours.toLocaleString()} h ${minutes} m`;
}

function tempLabel(value: unknown): string {
  const celsius = num(value);
  return celsius === null ? "-" : `${celsius.toFixed(1)} °C`;
}

function bytesLabel(value: unknown): string {
  const bytes = num(value);
  if (bytes === null || bytes === 0) return "-";
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const VERDICT_PILL: Record<string, string> = { ok: "live", warn: "waiting", fail: "danger" };

export function DeviceHealthCard({ deviceUid, disabled, run, espNow = false }: Props) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");

  // Resolves true once the device answered (with stats or a refusal); false
  // when nothing came back -- including run() skipping the call because the
  // page's own status refresh held the command lock.
  const load = useCallback(
    async (quiet: boolean): Promise<boolean> => {
      if (!deviceUid || disabled) return false;
      setLoading(true);
      try {
        const payload = { command: "health" };
        const response = await run(t("deviceHealth"), quiet ? quietCommand(payload) : payload, 18000);
        const result = response.result;
        if (!result) return false;
        if (result.ok === false) {
          if (String(result.error ?? result.message ?? "") === "unknown_command") setUnsupported(true);
          return true;
        }
        // normalizeCommandResult() hoists the firmware envelope's `data`.
        const data = record(result.time).power_on_s !== undefined ? result : record(result.data);
        if (record(data.time).power_on_s === undefined) return true;
        setUnsupported(false);
        setSnapshot(data);
        setUpdatedAt(new Date().toLocaleTimeString());
        return true;
      } catch {
        // Surfaced by run()'s operation log already.
        return true;
      } finally {
        setLoading(false);
      }
    },
    [deviceUid, disabled, run, t],
  );

  useEffect(() => {
    setSnapshot(null);
    setUnsupported(false);
    setUpdatedAt("");
  }, [deviceUid]);

  useEffect(() => {
    if (!deviceUid || disabled) return undefined;
    // Only the first fetch per device is automatic; later ones are a click.
    let cancelled = false;
    let timer = 0;
    const attempt = async (left: number) => {
      if (cancelled) return;
      const answered = await load(true);
      if (!answered && left > 0 && !cancelled) {
        timer = window.setTimeout(() => void attempt(left - 1), 2000);
      }
    };
    void attempt(3);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceUid, disabled]);

  const health = record(snapshot?.health);
  const verdict = String(health.verdict ?? "");
  const reasons = Array.isArray(health.reasons) ? health.reasons.map(String) : [];
  const time = record(snapshot?.time);
  const boot = record(snapshot?.boot);
  const resetCounts = Object.entries(record(boot.reset_counts)).sort((a, b) => Number(b[1]) - Number(a[1]));
  const firmware = record(snapshot?.firmware);
  const environment = record(snapshot?.environment);
  const connectivity = record(snapshot?.connectivity);
  const input = snapshot && "input" in snapshot ? record(snapshot.input) : null;
  const firstSeenUnix = num(time.first_seen_unix) ?? 0;
  const crashTotal = num(boot.crash_total) ?? 0;
  // Firmware reports esp_reset_reason_t names ("poweron", "panic", ...).
  const resetLabel = (reason: string) => {
    const key = `healthResetReason_${reason}`;
    const label = t(key);
    return label === key ? reason : label;
  };

  return (
    <div className="settings-card">
      <div className="settings-detail-header">
        <div>
          <h4>{t("deviceHealth")}</h4>
          <p>{t("deviceHealthCopy")}</p>
        </div>
        <div className="actions compact">
          {verdict ? (
            <span className={`status-pill ${VERDICT_PILL[verdict] ?? "offline"}`}>{t(`healthVerdict_${verdict}`)}</span>
          ) : null}
          <button className="button" type="button" disabled={disabled || loading || !deviceUid} onClick={() => void load(false)}>
            {loading ? t("running") : t("refresh")}
          </button>
        </div>
      </div>
      {unsupported ? (
        <p className="service-muted">{t("deviceHealthUnsupported")}</p>
      ) : !snapshot ? (
        <p className="service-muted">{loading ? t("running") : t("deviceHealthEmpty")}</p>
      ) : (
        <>
          {reasons.length > 0 ? (
            <HealthCallout
              tone={verdict === "fail" ? "bad" : "warn"}
              title={t("healthReasons")}
              items={reasons.map((reason) => t(`healthReason_${reason}`))}
            />
          ) : null}
          <HealthSummary>
            <HealthStat
              label={t("healthPowerOn")}
              value={durationLabel(time.power_on_s)}
              sub={`${t("healthScan")} ${durationLabel(time.scan_s)}`}
            />
            <HealthStat
              label={t("healthBootCount")}
              value={formatCount(boot.boot_count)}
              sub={boot.last_reset_reason ? `${t("healthLastReset")}: ${resetLabel(String(boot.last_reset_reason))}` : undefined}
            />
            <HealthStat
              label={t("healthCrashTotal")}
              value={formatCount(boot.crash_total)}
              sub={`${t("healthOtaRollback")} ${formatCount(firmware.ota_rollback)}`}
              tone={crashTotal > 0 ? "bad" : "neutral"}
            />
            <HealthStat
              label={t("healthChipTemp")}
              value={tempLabel(environment.chip_temp_c)}
              sub={`${t("healthTempRange")} ${tempLabel(environment.chip_temp_min_c)} – ${tempLabel(environment.chip_temp_max_c)}`}
              tone={reasons.includes("high_temperature") ? "warn" : "neutral"}
            />
          </HealthSummary>
          <HealthGroups>
            <HealthGroup title={t("healthGroupTime")}>
              <HealthRow label={t("healthPowerOn")} value={durationLabel(time.power_on_s)} />
              <HealthRow label={t("healthAwake")} value={durationLabel(time.awake_s)} />
              <HealthRow label={t("healthSoftOff")} value={durationLabel(time.soft_off_s)} />
              <HealthRow label={t("healthScan")} value={durationLabel(time.scan_s)} />
              <HealthRow label={t("healthSession")} value={durationLabel(time.session_s)} />
              <HealthRow label={t("healthLongestSession")} value={durationLabel(time.longest_session_s)} />
            </HealthGroup>
            <HealthGroup title={t("healthGroupBoot")}>
              <HealthRow label={t("healthBootCount")} value={formatCount(boot.boot_count)} />
              <HealthRow label={t("healthCrashTotal")} value={formatCount(boot.crash_total)} tone={crashTotal > 0 ? "bad" : "neutral"} />
              <HealthRow
                label={t("healthLastReset")}
                value={boot.last_reset_reason ? resetLabel(String(boot.last_reset_reason)) : "-"}
                tone={isFaultReset(String(boot.last_reset_reason ?? "")) ? "bad" : "neutral"}
              />
              {resetCounts.map(([reason, count]) => (
                <HealthRow
                  key={reason}
                  label={resetLabel(reason)}
                  hint={t("healthResetCountHint")}
                  value={formatCount(count)}
                  tone={isFaultReset(reason) && Number(count) > 0 ? "bad" : "neutral"}
                />
              ))}
            </HealthGroup>
            <HealthGroup title={t("healthGroupFirmware")}>
              <HealthRow label={t("healthFirmwareFirst")} value={String(firmware.first || "-")} />
              <HealthRow label={t("healthFirmwareChanges")} value={formatCount(firmware.changes)} />
              <HealthRow label={t("healthOtaSuccess")} value={formatCount(firmware.ota_success)} />
              <HealthRow label={t("healthOtaRollback")} value={formatCount(firmware.ota_rollback)} tone={Number(firmware.ota_rollback) > 0 ? "warn" : "neutral"} />
              {firmware.rolled_back_from ? (
                <HealthRow label={t("healthRolledBackFrom")} value={String(firmware.rolled_back_from)} tone="warn" />
              ) : null}
            </HealthGroup>
            <HealthGroup title={t("healthGroupEnvironment")}>
              <HealthRow label={t("healthChipTemp")} value={tempLabel(environment.chip_temp_c)} />
              <HealthRow label={t("healthChipTempMax")} value={tempLabel(environment.chip_temp_max_c)} />
              <HealthRow label={t("healthChipTempMin")} value={tempLabel(environment.chip_temp_min_c)} />
              <HealthRow
                label={t("healthMinFreeHeap")}
                value={bytesLabel(environment.min_free_heap)}
                tone={reasons.includes("low_heap") ? "warn" : "neutral"}
              />
              <HealthRow label={t("healthWifiDisconnects")} value={formatCount(connectivity.wifi_disconnects)} />
              {/* Firmware v1.13.0+. Shown for Hub-relayed devices, or anywhere
                  the counters have ever moved. */}
              {"espnow_hub_losses" in connectivity &&
              (espNow ||
                Number(connectivity.espnow_hub_losses) > 0 ||
                Number(connectivity.espnow_reply_failures) > 0 ||
                Number(connectivity.espnow_send_failures) > 0) ? (
                <>
                  <HealthRow label={t("healthEspNowHubLosses")} value={formatCount(connectivity.espnow_hub_losses)} />
                  <HealthRow label={t("healthEspNowReplyFailures")} value={formatCount(connectivity.espnow_reply_failures)} />
                  <HealthRow label={t("healthEspNowSendFailures")} value={formatCount(connectivity.espnow_send_failures)} />
                </>
              ) : null}
              {input ? <HealthRow label={t("healthButtonPresses")} value={formatCount(input.button_presses)} /> : null}
            </HealthGroup>
          </HealthGroups>
          <p className="health-footnote">
            {t("healthTrackedSince")
              .replace("{boot}", formatCount(boot.tracked_since_boot))
              .replace("{firmware}", String(firmware.first || "-"))}
            {firstSeenUnix > 0 ? ` · ${t("healthFirstSeen")}: ${new Date(firstSeenUnix * 1000).toLocaleDateString()}` : ""}
            {` · ${t("healthFlushNote").replace("{minutes}", String(Math.round((num(time.flush_interval_s) ?? 600) / 60)))}`}
            {updatedAt ? ` · ${t("healthUpdatedAt").replace("{time}", updatedAt)}` : ""}
          </p>
        </>
      )}
    </div>
  );
}
