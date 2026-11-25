import { useEffect, useState } from "react";
import { Compass } from "lucide-react";
import { Select } from "../Select";
import { ConfirmModal } from "../ConfirmModal";
import { MAG_CAL_INTERVAL_CHOICES, calibrationDue, magnetometerHint, type MagCalibrationStatus } from "../../lib/magCalibration";
import { MagCalibrationWizard, magModeLabel, type MagRun } from "./MagCalibrationWizard";

// The magnetometer in the device settings.
//
// "runtime" (Streaming tab, beside the IMU): the on/off menu + apply, the
// reminder interval, rates, calibration state. Switching it on goes straight
// into the calibration wizard; cancelling the wizard switches it off again --
// the firmware allows an uncalibrated magnetometer (the wizard needs its
// stream), the UI does not leave one behind.
//
// "maintenance" (Maintenance tab): the calibration and its reminder only.

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function resultOk(reply: Record<string, unknown> | null): boolean {
  return reply !== null && reply.status !== "error" && reply.ok !== false;
}

/** The badge text for a hint, or null when there is nothing to say. */
export function magHintLabel(t: (key: string) => string, hint: ReturnType<typeof magnetometerHint>): string | null {
  if (!hint) return null;
  if (hint.state === "none") return t("magHintNone");
  if (hint.state === "suspect") return t("magHintSuspect");
  if (hint.state === "due") return t("magHintDue");
  if (hint.state === "soon") return t("magHintSoon").replace("{n}", String(Math.max(0, hint.daysLeft ?? 0)));
  return null;
}

export function MagCalibrationBanner({ t, magnetometer, onCalibrate, disabled }: { t: (key: string) => string; magnetometer: Record<string, unknown>; onCalibrate: () => void; disabled: boolean }) {
  const hint = magnetometerHint(magnetometer, Date.now());
  const label = magHintLabel(t, hint);
  if (!label || !hint) return null;
  return (
    <div className={`mag-hint-banner ${hint.state}`} role="status">
      <Compass size={18} strokeWidth={1.75} aria-hidden="true" />
      <span>{label}</span>
      <button className="button primary" type="button" disabled={disabled} onClick={onCalibrate}>{t("magCalibrateNow")}</button>
    </div>
  );
}

export function MagnetometerPanel({
  t,
  variant,
  deviceUid,
  hardwareModel,
  magnetometer,
  disabled,
  busy,
  run,
}: {
  t: (key: string) => string;
  variant: "runtime" | "maintenance";
  deviceUid: string;
  hardwareModel: string | null | undefined;
  magnetometer: Record<string, unknown>;
  /** Device offline / not controllable. */
  disabled: boolean;
  busy: boolean;
  run: MagRun;
}) {
  const supported = typeof magnetometer.enabled === "boolean";
  const model = String(magnetometer.model ?? "");
  const enabled = magnetometer.enabled === true;
  const calibration = record(magnetometer.calibration) as MagCalibrationStatus & Record<string, unknown>;
  const intervalDays = Number(calibration.interval_days ?? 30);
  const [enabledDraft, setEnabledDraft] = useState(enabled ? "on" : "off");
  const [intervalDraft, setIntervalDraft] = useState(String(intervalDays));
  const [wizard, setWizard] = useState<null | { fromEnable: boolean }>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setEnabledDraft(enabled ? "on" : "off"), [enabled]);
  useEffect(() => setIntervalDraft(String(intervalDays)), [intervalDays]);

  if (!model || model === "none") {
    if (variant === "maintenance") return null;
    return (
      <div className="settings-card">
        <h4>{t("magnetometer")}</h4>
        <p className="service-muted">{t("magNotSupported")}</p>
      </div>
    );
  }
  if (!supported) {
    // Firmware before the switch: nothing here can drive it.
    if (variant === "maintenance") return null;
    return (
      <div className="settings-card">
        <h4>{t("magnetometer")} <small className="service-muted">{model}</small></h4>
        <p className="service-muted">{t("magNeedsFirmware")}</p>
      </div>
    );
  }

  const due = calibrationDue(calibration, Date.now());
  const calibrated = calibration.mode === "full" || calibration.mode === "hard_iron";
  const state = String(magnetometer.state ?? (enabled ? "ready" : "disabled"));
  const draftDiffers = enabledDraft !== (enabled ? "on" : "off") || Number(intervalDraft) !== intervalDays;

  async function apply() {
    setError("");
    const payload: Record<string, unknown> = { command: "set_mag" };
    const turningOn = enabledDraft === "on" && !enabled;
    if (enabledDraft !== (enabled ? "on" : "off")) payload.enabled = enabledDraft === "on";
    if (Number(intervalDraft) !== intervalDays) payload.cal_interval_days = Number(intervalDraft);
    const response = await run(t("magApply"), payload, 20000, { waitForLock: true });
    if (!resultOk(response.result)) {
      setError(String(response.result?.message ?? response.result?.error ?? t("terminalNoResponse")));
      return;
    }
    if (turningOn) setWizard({ fromEnable: true });
  }

  async function closeWizard(applied: boolean) {
    const fromEnable = wizard?.fromEnable === true;
    setWizard(null);
    if (fromEnable && !applied) {
      await run(t("magApply"), { command: "set_mag", enabled: false }, 20000, { waitForLock: true });
    }
  }

  async function clearCalibration() {
    setConfirmClear(false);
    await run(t("magCalClear"), { command: "set_mag_calibration", clear: true }, 20000, { waitForLock: true });
  }

  const calibrationLine = calibrated ? (
    <p className="service-muted">
      {magModeLabel(t, calibration.mode)}
      {Number(calibration.calibrated_at_ms) > 0 ? ` · ${new Date(Number(calibration.calibrated_at_ms)).toLocaleDateString()}` : ""}
      {calibration.residual_pct !== undefined ? ` · ${t("magCalResidual")} ${Number(calibration.residual_pct).toFixed(1)}%` : ""}
      {due.daysLeft !== null ? ` · ${due.daysLeft >= 0 ? t("magCalDaysLeft").replace("{n}", String(due.daysLeft)) : t("magHintDue")}` : ` · ${t("magCalIntervalNever")}`}
    </p>
  ) : (
    <p className="service-muted">{t("magCalNever")}</p>
  );

  const calibrateButtons = (
    <>
      <button className="button" type="button" disabled={disabled || busy || !enabled} onClick={() => setWizard({ fromEnable: false })}>
        {t("magCalibrate")}
      </button>
      {calibrated ? (
        <button className="button" type="button" disabled={disabled || busy} onClick={() => setConfirmClear(true)}>
          {t("magCalClear")}
        </button>
      ) : null}
    </>
  );

  return (
    <div className="settings-card mag-card">
      {enabled ? (
        <MagCalibrationBanner t={t} magnetometer={magnetometer} disabled={disabled || busy} onCalibrate={() => setWizard({ fromEnable: false })} />
      ) : null}
      {variant === "runtime" ? (
        <>
          <div className="settings-row">
            <div>
              <h4>{t("magnetometer")} <small className="service-muted">{model}</small></h4>
              <p className="service-muted">
                {t(`magState_${state}`)}
                {enabled && Number(magnetometer.odr_hz) > 0 ? ` · ${t("magOdr")} ${String(magnetometer.odr_hz)} Hz` : ""}
                {enabled && Number(magnetometer.averaging) > 0 ? ` · ${t("magAveraging")} ×${String(magnetometer.averaging)}` : ""}
                {enabled && Number(magnetometer.measured_rate_hz) > 0 ? ` · ${t("magMeasured")} ${Number(magnetometer.measured_rate_hz).toFixed(1)} Hz` : ""}
                {" · "}{t("imuSampleRateFollowsScan")}
              </p>
            </div>
            <div className="settings-row-controls">
              <Select value={enabledDraft} disabled={disabled || busy} onChange={(event) => setEnabledDraft(event.target.value)} aria-label={t("magnetometer")}>
                <option value="on">{t("magOn")}</option>
                <option value="off">{t("magOff")}</option>
              </Select>
              <Select value={intervalDraft} disabled={disabled || busy} onChange={(event) => setIntervalDraft(event.target.value)} aria-label={t("magCalInterval")}>
                {MAG_CAL_INTERVAL_CHOICES.map((days) => (
                  <option key={days} value={String(days)}>{days === 0 ? t("magCalIntervalNever") : t("magCalIntervalDays").replace("{n}", String(days))}</option>
                ))}
                {!MAG_CAL_INTERVAL_CHOICES.includes(intervalDays as (typeof MAG_CAL_INTERVAL_CHOICES)[number]) ? (
                  <option value={String(intervalDays)}>{t("magCalIntervalDays").replace("{n}", String(intervalDays))}</option>
                ) : null}
              </Select>
              <button className="button primary" type="button" disabled={disabled || busy || !draftDiffers} onClick={() => void apply()}>
                {busy ? t("running") : t("magApply")}
              </button>
            </div>
          </div>
          {enabledDraft === "on" && !enabled ? <p className="service-muted">{t("magEnableNeedsCalibration")}</p> : null}
          {magnetometer.blocked_by === "imu" ? <p className="notice warning">{t("magBlockedByImu")}</p> : null}
          {enabled && state === "error" && magnetometer.last_error ? <p className="notice error">{String(magnetometer.last_error)}</p> : null}
          <div className="settings-row">
            <div>
              <strong>{t("magCalStatus")}</strong>
              {calibrationLine}
            </div>
            <div className="settings-row-controls">{calibrateButtons}</div>
          </div>
        </>
      ) : (
        <div className="settings-row">
          <div>
            <h4>{t("magMaintenanceTitle")} <small className="service-muted">{model}</small></h4>
            <p className="service-muted">{enabled ? t("magMaintenanceCopy") : t("magMaintenanceOff")}</p>
            {enabled ? calibrationLine : null}
          </div>
          <div className="settings-row-controls">{calibrateButtons}</div>
        </div>
      )}
      {error ? <p className="notice error">{error}</p> : null}
      {wizard ? (
        <MagCalibrationWizard
          t={t}
          deviceUid={deviceUid}
          hardwareModel={hardwareModel}
          magnetometer={magnetometer}
          fromEnable={wizard.fromEnable}
          run={run}
          onClose={(applied) => void closeWizard(applied)}
        />
      ) : null}
      {confirmClear ? (
        <ConfirmModal
          title={t("magCalClear")}
          message={t("magCalClearConfirm")}
          confirmLabel={t("magCalClear")}
          cancelLabel={t("cancel")}
          destructive
          onConfirm={() => void clearCalibration()}
          onCancel={() => setConfirmClear(false)}
        />
      ) : null}
    </div>
  );
}
