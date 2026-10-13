import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useI18n } from "../i18n";
import { quietCommand } from "../lib/deviceCommand";

// The device clock service (firmware v1.12.0+): status from `clock_status`,
// re-sync with `clock_sync`, settings with `set_clock_config`, and a manual
// `set_time` fallback. Holds its own snapshot like DeviceHealthCard -- the
// page's last_result is overwritten by the next status poll.

type ClockRun = (
  label: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
  options?: { waitForLock?: boolean; background?: boolean },
) => Promise<{ queued?: unknown; result?: Record<string, unknown> | null }>;

type Props = {
  deviceUid: string;
  disabled: boolean;
  run: ClockRun;
};

type Snapshot = {
  clock: Record<string, unknown>;
  config: Record<string, unknown>;
  // Date.now() when the reply arrived, for the vs-this-computer estimate.
  receivedAtMs: number;
};

const SYNC_POLL_MS = 1000;
const SYNC_POLL_TRIES = 10;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ageLabel(ms: number | null): string {
  if (ms === null) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

function signedMs(ms: number | null): string {
  if (ms === null) return "-";
  return `${ms > 0 ? "+" : ""}${ms.toLocaleString()} ms`;
}

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0");
}

function formatClock(date: Date) {
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${Math.floor(date.getMilliseconds() / 100)}`,
  };
}

// The device's clock, ticking in the browser between readings: the last
// reported epoch_ms plus however long ago that reply arrived. It inherits
// the reply's delivery delay, so it is for the eye, not for measurement.
function DigitalClock({
  t,
  epochMs,
  receivedAtMs,
}: {
  t: (key: string) => string;
  epochMs: number | null;
  receivedAtMs: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  const device = epochMs !== null ? formatClock(new Date(epochMs + (now - receivedAtMs))) : null;
  const computer = formatClock(new Date(now));
  return (
    <div className="clock-digital" aria-live="off">
      <div className="clock-digital-main">
        <span className="clock-digital-label">{t("clockDeviceTime")}</span>
        <strong className="clock-digital-time">{device ? device.time : "--:--:--.-"}</strong>
        <span className="clock-digital-date">{device ? device.date : t("clockSource_none")}</span>
      </div>
      <div className="clock-digital-reference">
        <span className="clock-digital-label">{t("clockComputerTime")}</span>
        <span className="clock-digital-ref-time">{computer.time}</span>
        <span className="clock-digital-date">{computer.date}</span>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function snapshotFrom(result: Record<string, unknown> | null | undefined): Snapshot | null {
  if (!result || result.ok === false) return null;
  // normalizeCommandResult() hoists the firmware envelope's `data`.
  const data = "clock" in result ? result : record(result.data);
  const clock = record(data.clock);
  if (!("synced" in clock)) return null;
  return { clock, config: record(data.clock_config), receivedAtMs: Date.now() };
}

function errorCode(result: Record<string, unknown> | null | undefined): string {
  return String(result?.error ?? result?.message ?? "");
}

export function DeviceClockCard({ deviceUid, disabled, run }: Props) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeClass, setNoticeClass] = useState<"" | "success" | "error">("");
  const [ntpServer, setNtpServer] = useState("");
  const [ntpInterval, setNtpInterval] = useState("");
  const [syncInterval, setSyncInterval] = useState("");
  const [formDirty, setFormDirty] = useState(false);

  const fetchStatus = useCallback(
    async (background: boolean): Promise<Snapshot | null> => {
      if (!deviceUid || disabled) return null;
      const payload = quietCommand({ command: "clock_status" });
      const response = await run(t("clockStatusTitle"), payload, 10000, background ? { background: true } : {});
      const result = response.result;
      if (result && result.ok === false && errorCode(result) === "unknown_command") {
        setUnsupported(true);
        return null;
      }
      const next = snapshotFrom(result);
      if (next) {
        setUnsupported(false);
        setSnapshot(next);
      }
      return next;
    },
    [deviceUid, disabled, run, t],
  );

  useEffect(() => {
    setSnapshot(null);
    setUnsupported(false);
    setNotice("");
    setFormDirty(false);
  }, [deviceUid]);

  useEffect(() => {
    if (!deviceUid || disabled) return undefined;
    // Only the first fetch per device is automatic, retried while the page's
    // own status refresh holds the command lock.
    let cancelled = false;
    let timer = 0;
    const attempt = async (left: number) => {
      if (cancelled) return;
      const answered = await fetchStatus(true).catch(() => null);
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

  const config = snapshot?.config ?? {};
  useEffect(() => {
    if (formDirty || !snapshot) return;
    setNtpServer(String(config.ntp_server ?? ""));
    setNtpInterval(config.ntp_interval_s !== undefined ? String(config.ntp_interval_s) : "");
    setSyncInterval(config.sync_interval_s !== undefined ? String(config.sync_interval_s) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, formDirty]);

  function showNotice(text: string, kind: "" | "success" | "error") {
    setNotice(text);
    setNoticeClass(kind);
  }

  async function handleSyncNow() {
    setBusy("clock_sync");
    showNotice("", "");
    try {
      const before = num(snapshot?.clock.adjust_count) ?? -1;
      const response = await run(t("clockSyncNow"), { command: "clock_sync" }, 15000);
      const result = response.result;
      if (!result) return;
      if (result.ok === false) {
        const code = errorCode(result);
        if (code === "unknown_command") setUnsupported(true);
        showNotice(code === "clock_source_unavailable" ? t("clockSyncNoSource") : code, "error");
        return;
      }
      // clock_sync only starts the exchange; the result lands a moment later.
      for (let attempt = 0; attempt < SYNC_POLL_TRIES; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, SYNC_POLL_MS));
        const next = await fetchStatus(true).catch(() => null);
        const after = num(next?.clock.adjust_count);
        if (next && after !== null && after > before) {
          const adjust = num(next.clock.last_adjust_ms) ?? 0;
          showNotice(t("clockSyncDone").replace("{ms}", adjust.toLocaleString()), "success");
          return;
        }
      }
      showNotice(t("clockSyncPending"), "");
    } finally {
      setBusy("");
    }
  }

  async function handleUseComputerTime() {
    setBusy("set_time");
    showNotice("", "");
    try {
      // force: an explicit "use this time", which may replace a stale source.
      const response = await run(
        t("clockUseComputerTime"),
        { command: "set_time", epoch_ms: String(Date.now()), force: true },
        15000,
      );
      if (response.result && response.result.ok === false) {
        showNotice(errorCode(response.result), "error");
        return;
      }
      await fetchStatus(true).catch(() => null);
    } finally {
      setBusy("");
    }
  }

  async function handleSaveSettings(event: FormEvent) {
    event.preventDefault();
    setBusy("set_clock_config");
    showNotice("", "");
    try {
      const payload: Record<string, unknown> = { command: "set_clock_config" };
      if (ntpServer.trim()) payload.ntp_server = ntpServer.trim();
      if (ntpInterval.trim()) payload.ntp_interval_s = Number(ntpInterval);
      if (syncInterval.trim()) payload.sync_interval_s = Number(syncInterval);
      const response = await run(t("clockSettingsTitle"), payload, 15000);
      const result = response.result;
      if (result && result.ok === false) {
        showNotice(errorCode(result), "error");
        return;
      }
      const next = snapshotFrom(result);
      setFormDirty(false);
      if (next) setSnapshot(next);
    } finally {
      setBusy("");
    }
  }

  const clock = snapshot?.clock ?? {};
  const synced = clock.synced === true;
  const source = String(clock.source ?? "none");
  const mode = String(clock.mode ?? "");
  // The time server this device exchanges with: its Hub (ESP-NOW) or its
  // Gateway (WiFi, with NTP as the fallback).
  const espNow = mode === "espnow";
  const server = record(espNow ? clock.hub : clock.gateway);
  const serverUnsupported = server.supported === false;
  const hubUnsupported = espNow && serverUnsupported;
  const serverRttUs = num(server.last_rtt_us);
  const epochMs = num(clock.epoch_ms);
  const offsetMs = snapshot && epochMs !== null ? Math.round(epochMs - snapshot.receivedAtMs) : null;
  const uncertainty = num(clock.uncertainty_ms);
  const controlsDisabled = disabled || !deviceUid || busy !== "" || unsupported;

  return (
    <>
      <div className="settings-card">
        <div className="settings-detail-header">
          <div>
            <h4>{t("clockStatusTitle")}</h4>
            <p>{t("clockStatusCopy")}</p>
          </div>
          <div className="actions compact">
            {snapshot ? (
              <span className={`status-pill ${synced ? "live" : "waiting"}`}>
                {synced ? t("clockSynced") : t("clockSource_none")}
              </span>
            ) : null}
            <button className="button" type="button" disabled={controlsDisabled} onClick={() => void fetchStatus(false)}>
              {t("refresh")}
            </button>
            <button className="button primary" type="button" disabled={controlsDisabled} onClick={() => void handleSyncNow()}>
              {busy === "clock_sync" ? t("clockSyncing") : t("clockSyncNow")}
            </button>
          </div>
        </div>
        {notice ? <p className={`notice ${noticeClass}`.trim()}>{notice}</p> : null}
        {unsupported ? (
          <p className="service-muted">{t("clockUnsupported")}</p>
        ) : !snapshot ? (
          <p className="service-muted">{t("clockEmpty")}</p>
        ) : (
          <>
            <DigitalClock t={t} epochMs={synced ? epochMs : null} receivedAtMs={snapshot.receivedAtMs} />
            <div className="metric-row">
              <Metric label={t("clockSource")} value={t(`clockSource_${source}`)} />
              <Metric label={t("clockSyncAge")} value={synced ? ageLabel(num(clock.age_ms)) : "-"} />
              <Metric label={t("clockUncertainty")} value={synced && uncertainty !== null ? `±${uncertainty.toLocaleString()} ms` : "-"} />
              <Metric label={t("clockLastAdjust")} value={synced ? signedMs(num(clock.last_adjust_ms)) : "-"} />
              <Metric label={t("clockOffsetFromComputer")} value={synced ? `≈ ${signedMs(offsetMs)}` : "-"} />
              <Metric label={t("clockMode")} value={mode === "espnow" ? "ESP-NOW" : mode === "wifi" ? "WiFi" : "-"} />
              {mode ? (
                <>
                  <Metric
                    label={t(espNow ? "clockHubSupport" : "clockGatewaySupport")}
                    value={serverUnsupported ? t(espNow ? "clockHubUnsupported" : "clockGatewayUnsupported") : t("clockHubSupported")}
                  />
                  <Metric label={t("clockHubRtt")} value={serverRttUs !== null ? `${(serverRttUs / 1000).toFixed(1)} ms` : "-"} />
                </>
              ) : null}
            </div>
            {synced ? <p className="service-muted">{t("clockOffsetNote")}</p> : null}
            {hubUnsupported ? <p className="notice error">{t("clockHubUnsupportedCopy")}</p> : null}
            {!espNow && serverUnsupported ? <p className="service-muted">{t("clockGatewayUnsupportedCopy")}</p> : null}
          </>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-detail-header">
          <div>
            <h4>{t("clockUseComputerTime")}</h4>
            <p>{t("clockUseComputerTimeCopy")}</p>
          </div>
          <button
            className={`button${!synced || hubUnsupported ? " primary" : ""}`}
            type="button"
            disabled={disabled || !deviceUid || busy !== ""}
            onClick={() => void handleUseComputerTime()}
          >
            {busy === "set_time" ? t("running") : t("clockUseComputerTime")}
          </button>
        </div>
      </div>

      {snapshot && !unsupported ? (
        <form className="settings-card" onSubmit={(event) => void handleSaveSettings(event)}>
          <div className="settings-detail-header">
            <div>
              <h4>{t("clockSettingsTitle")}</h4>
              <p>{t("clockSettingsTitleCopy")}</p>
            </div>
            <button className="button primary" type="submit" disabled={controlsDisabled || !formDirty}>
              {busy === "set_clock_config" ? t("running") : t("clockSaveSettings")}
            </button>
          </div>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="clock-sync-interval">{t("clockSyncInterval")}</label>
              <input
                id="clock-sync-interval"
                type="number"
                min={5}
                max={3600}
                value={syncInterval}
                onChange={(event) => {
                  setSyncInterval(event.target.value);
                  setFormDirty(true);
                }}
              />
            </div>
            {espNow ? null : (
              <>
                <div className="field">
                  <label htmlFor="clock-ntp-server">{t("clockNtpServer")}</label>
                  <input
                    id="clock-ntp-server"
                    value={ntpServer}
                    maxLength={63}
                    onChange={(event) => {
                      setNtpServer(event.target.value);
                      setFormDirty(true);
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="clock-ntp-interval">{t("clockNtpInterval")}</label>
                  <input
                    id="clock-ntp-interval"
                    type="number"
                    min={60}
                    max={86400}
                    value={ntpInterval}
                    onChange={(event) => {
                      setNtpInterval(event.target.value);
                      setFormDirty(true);
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </form>
      ) : null}
    </>
  );
}
