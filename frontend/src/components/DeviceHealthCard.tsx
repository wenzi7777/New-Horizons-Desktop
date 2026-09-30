import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../i18n";
import { quietCommand } from "../lib/deviceCommand";

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

function countLabel(value: unknown): string {
  const count = num(value);
  return count === null ? "-" : count.toLocaleString();
}

function bytesLabel(value: unknown): string {
  const bytes = num(value);
  if (bytes === null || bytes === 0) return "-";
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

const VERDICT_PILL: Record<string, string> = { ok: "live", warn: "waiting", fail: "danger" };

export function DeviceHealthCard({ deviceUid, disabled, run }: Props) {
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
            <p className="service-muted">
              {t("healthReasons")}: {reasons.map((reason) => t(`healthReason_${reason}`)).join(" · ")}
            </p>
          ) : null}
          <h5 className="health-group-title">{t("healthGroupTime")}</h5>
          <div className="metric-row">
            <Metric label={t("healthPowerOn")} value={durationLabel(time.power_on_s)} />
            <Metric label={t("healthAwake")} value={durationLabel(time.awake_s)} />
            <Metric label={t("healthSoftOff")} value={durationLabel(time.soft_off_s)} />
            <Metric label={t("healthScan")} value={durationLabel(time.scan_s)} />
            <Metric label={t("healthSession")} value={durationLabel(time.session_s)} />
            <Metric label={t("healthLongestSession")} value={durationLabel(time.longest_session_s)} />
          </div>
          <h5 className="health-group-title">{t("healthGroupBoot")}</h5>
          <div className="metric-row">
            <Metric label={t("healthBootCount")} value={countLabel(boot.boot_count)} />
            <Metric label={t("healthCrashTotal")} value={countLabel(boot.crash_total)} />
            <Metric label={t("healthLastReset")} value={String(boot.last_reset_reason ?? "-")} />
            {resetCounts.map(([reason, count]) => (
              <Metric key={reason} label={`${t("healthResetPrefix")} ${reason}`} value={countLabel(count)} />
            ))}
          </div>
          <h5 className="health-group-title">{t("healthGroupFirmware")}</h5>
          <div className="metric-row">
            <Metric label={t("healthFirmwareFirst")} value={String(firmware.first || "-")} />
            <Metric label={t("healthFirmwareChanges")} value={countLabel(firmware.changes)} />
            <Metric label={t("healthOtaSuccess")} value={countLabel(firmware.ota_success)} />
            <Metric label={t("healthOtaRollback")} value={countLabel(firmware.ota_rollback)} />
            {firmware.rolled_back_from ? (
              <Metric label={t("healthRolledBackFrom")} value={String(firmware.rolled_back_from)} />
            ) : null}
          </div>
          <h5 className="health-group-title">{t("healthGroupEnvironment")}</h5>
          <div className="metric-row">
            <Metric label={t("healthChipTemp")} value={tempLabel(environment.chip_temp_c)} />
            <Metric label={t("healthChipTempMax")} value={tempLabel(environment.chip_temp_max_c)} />
            <Metric label={t("healthChipTempMin")} value={tempLabel(environment.chip_temp_min_c)} />
            <Metric label={t("healthMinFreeHeap")} value={bytesLabel(environment.min_free_heap)} />
            <Metric label={t("healthWifiDisconnects")} value={countLabel(connectivity.wifi_disconnects)} />
            {input ? <Metric label={t("healthButtonPresses")} value={countLabel(input.button_presses)} /> : null}
          </div>
          <p className="service-muted">
            {t("healthTrackedSince")
              .replace("{boot}", countLabel(boot.tracked_since_boot))
              .replace("{firmware}", String(firmware.first || "-"))}
            {firstSeenUnix > 0 ? ` · ${t("healthFirstSeen")}: ${new Date(firstSeenUnix * 1000).toLocaleDateString()}` : ""}
            {` · ${t("healthFlushNote").replace("{minutes}", String(Math.round((num(time.flush_interval_s) ?? 600) / 60)))}`}
            {updatedAt ? ` · ${updatedAt}` : ""}
          </p>
        </>
      )}
    </div>
  );
}
