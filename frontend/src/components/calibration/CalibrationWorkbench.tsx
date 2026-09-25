import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronRight, CircleCheck, TriangleAlert } from "lucide-react";

import { ConfirmModal } from "../ConfirmModal";
import {
  calibrationErrorKey,
  calibrationSnapshotKey,
  canSaveCalibration,
  chooseCalibrationState,
  getCalibrationStep,
  isFullCalibrationStatus,
  parseCalibrationState,
  zeroBlockedReason,
  type CalibrationOverride,
  type CalibrationState,
  type CalibrationStep,
} from "../../lib/calibrationFlow";

export type CalibrationCommandResult = {
  queued?: unknown;
  result?: Record<string, unknown> | null;
};

export type CalibrationRun = (
  label: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
  options?: { waitForLock?: boolean },
) => Promise<CalibrationCommandResult>;

type CalibrationWorkbenchProps = {
  t: (key: string) => string;
  deviceUid: string;
  isDeviceOffline: boolean;
  matrixShape: Record<string, unknown>;
  calibrationStatus: Record<string, unknown>;
  maintenanceMode: boolean;
  run: CalibrationRun;
};

type Outcome = { ok: boolean; code: string; result: Record<string, unknown> | null };

type PendingAction =
  | ""
  | "zero"
  | "clear_zero"
  | "start"
  | "baseline"
  | "capture_all"
  | "capture_one"
  | "save"
  | "cancel"
  | "delete_level"
  | "advanced";

type ConfirmRequest =
  | { kind: "cancel" }
  | { kind: "clear" }
  | { kind: "delete_saved"; level: number };

type PreviewCell = { sensorIndex: number; value: number | null };
type MatrixPreview = { title: string; cells: Map<number, PreviewCell> };

const ZERO_DURATION_MS = 1000;
const BASELINE_DURATION_MS = 3000;
// Captures block the device for their duration before it answers.
const CAPTURE_TIMEOUT_MARGIN_MS = 40000;

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function outcomeFromResult(result: Record<string, unknown> | null | undefined): Outcome {
  if (!result) {
    return { ok: false, code: "no_response", result: null };
  }
  const failed = result.status === "error" || result.ok === false;
  return {
    ok: !failed,
    code: failed ? String(result.error || result.message || "") : "",
    result,
  };
}

// cells of a calibration_dump_tare / calibration_dump_level layer
function previewCells(layer: unknown): Map<number, PreviewCell> {
  const cells = new Map<number, PreviewCell>();
  const list = recordValue(layer).cells;
  if (!Array.isArray(list)) return cells;
  list.forEach((item) => {
    const cell = recordValue(item);
    const sensorIndex = numberValue(cell.sensor_index, -1);
    if (sensorIndex < 0) return;
    const value = cell.value === null || cell.value === undefined || cell.calibrated === false ? null : numberValue(cell.value, 0);
    cells.set(sensorIndex, { sensorIndex, value });
  });
  return cells;
}

// Draft layer while a session is open, otherwise the saved one.
function preferredLayer(source: Record<string, unknown>) {
  const draft = recordValue(source.draft);
  return Object.keys(draft).length > 0 ? draft : recordValue(source.saved);
}

export function CalibrationWorkbench({
  t,
  deviceUid,
  isDeviceOffline,
  matrixShape,
  calibrationStatus,
  maintenanceMode,
  run,
}: CalibrationWorkbenchProps) {
  const rows = numberValue(matrixShape.rows, 0);
  const cols = numberValue(matrixShape.cols, 0);
  const totalSensors = rows * cols;
  const deviceConnected = Boolean(deviceUid) && !isDeviceOffline;

  const [override, setOverride] = useState<CalibrationOverride | null>(null);
  const calibration = chooseCalibrationState(calibrationStatus, override);
  const snapshotKeyRef = useRef("");
  snapshotKeyRef.current = calibrationSnapshotKey(calibrationStatus);

  const [pending, setPending] = useState<PendingAction>("");
  const [zeroError, setZeroError] = useState("");
  const [flowError, setFlowError] = useState("");
  const [advancedError, setAdvancedError] = useState("");
  const [lastZeroAt, setLastZeroAt] = useState("");
  const [zeroNeedsFirmware, setZeroNeedsFirmware] = useState(false);
  const [baselineConfirmed, setBaselineConfirmed] = useState(false);
  const [pressureKpa, setPressureKpa] = useState(10);
  const [durationSeconds, setDurationSeconds] = useState(3);
  const [singleSensorOpen, setSingleSensorOpen] = useState(false);
  const [selectedSensor, setSelectedSensor] = useState(0);
  const [levelCells, setLevelCells] = useState<Map<number, PreviewCell>>(new Map());
  const [preview, setPreview] = useState<MatrixPreview | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // Set when this flow put the device into maintenance, so saving or
  // cancelling hands it back to normal scanning.
  const enteredMaintenanceRef = useRef(false);
  const syncedDeviceRef = useRef("");

  const step: CalibrationStep = getCalibrationStep({
    sessionActive: calibration.session_active,
    draftTareComplete: calibration.draft_tare?.complete === true,
    baselineConfirmed,
  });
  const saveReady = canSaveCalibration(calibration);
  const zeroReason = zeroBlockedReason(deviceConnected, calibration);
  const busy = pending !== "";
  const maxLevel = numberValue(calibration.metadata.max_level, 0);

  useEffect(() => {
    if (!calibration.session_active) {
      setBaselineConfirmed(false);
      setLevelCells(new Map());
    }
  }, [calibration.session_active]);

  useEffect(() => {
    if (selectedSensor >= totalSensors) setSelectedSensor(0);
  }, [selectedSensor, totalSensors]);

  useEffect(() => {
    // One status read per device when the section opens, so the page does not
    // start from whatever the last full status poll happened to say.
    if (!deviceConnected) {
      syncedDeviceRef.current = "";
      return;
    }
    if (syncedDeviceRef.current === deviceUid) return;
    syncedDeviceRef.current = deviceUid;
    void command(t("refreshStatus"), { command: "calibration_status" }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceUid, deviceConnected]);

  function errorText(code: string) {
    const key = calibrationErrorKey(code);
    return key === "calErrorGeneric" ? t(key).replace("{error}", code) : t(key);
  }

  async function command(label: string, payload: Record<string, unknown>, timeoutMs = 20000): Promise<Outcome> {
    let outcome: Outcome;
    try {
      const response = await run(label, payload, timeoutMs, { waitForLock: true });
      outcome = outcomeFromResult(response.result);
    } catch (error) {
      outcome = { ok: false, code: error instanceof Error ? error.message : "", result: null };
    }
    if (outcome.ok && isFullCalibrationStatus(outcome.result)) {
      setOverride({ state: parseCalibrationState(outcome.result), snapshotKey: snapshotKeyRef.current });
    }
    return outcome;
  }

  // Captures answer with a dump rather than the status, so read it after.
  async function refreshCalibration() {
    await command(t("refreshStatus"), { command: "calibration_status" });
  }

  async function withPending(action: PendingAction, body: () => Promise<void>) {
    if (busy) return;
    setPending(action);
    try {
      await body();
    } finally {
      setPending("");
    }
  }

  async function ensureMaintenance(setError: (value: string) => void): Promise<boolean> {
    if (maintenanceMode) return true;
    const entered = await command(t("enterMaintenance"), { command: "enter_maintenance", reason: "calibration" });
    if (!entered.ok) {
      setError(errorText(entered.code));
      return false;
    }
    return true;
  }

  async function releaseMaintenance() {
    if (!enteredMaintenanceRef.current) return;
    enteredMaintenanceRef.current = false;
    await command(t("exitMaintenance"), { command: "exit_maintenance" });
  }

  // ---- Zero ---------------------------------------------------------------

  function zero() {
    return withPending("zero", async () => {
      setZeroError("");
      setZeroNeedsFirmware(false);
      const payload = { command: "calibration_tare_capture", duration_ms: ZERO_DURATION_MS };
      let outcome = await command(t("calZeroAction"), payload);
      if (!outcome.ok && outcome.code === "maintenance_required") {
        // Firmware before v1.5.1 only zeroes in maintenance mode.
        const wasMaintenance = maintenanceMode;
        if (!wasMaintenance && !(await ensureMaintenance(setZeroError))) return;
        outcome = await command(t("calZeroAction"), payload);
        if (!wasMaintenance) await command(t("exitMaintenance"), { command: "exit_maintenance" });
      }
      if (!outcome.ok) {
        setZeroError(errorText(outcome.code));
        return;
      }
      setLastZeroAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      if (!parseCalibrationState(outcome.result).output_mode_reported) {
        setZeroNeedsFirmware(true);
      }
    });
  }

  function clearZero() {
    return withPending("clear_zero", async () => {
      setZeroError("");
      const outcome = await command(t("calZeroClear"), { command: "calibration_tare_clear" });
      if (!outcome.ok) {
        setZeroError(errorText(outcome.code));
        return;
      }
      setLastZeroAt("");
    });
  }

  // ---- Pressure calibration ----------------------------------------------

  function startCalibration() {
    return withPending("start", async () => {
      setFlowError("");
      if (!maintenanceMode) {
        if (!(await ensureMaintenance(setFlowError))) return;
        enteredMaintenanceRef.current = true;
      }
      const outcome = await command(t("calStart"), { command: "calibration_session_begin" });
      if (!outcome.ok) {
        setFlowError(errorText(outcome.code));
        await releaseMaintenance();
        return;
      }
      setBaselineConfirmed(false);
    });
  }

  function captureBaseline() {
    return withPending("baseline", async () => {
      setFlowError("");
      const outcome = await command(
        t("calBaselineCapture"),
        { command: "calibration_capture_tare", duration_ms: BASELINE_DURATION_MS },
        BASELINE_DURATION_MS + CAPTURE_TIMEOUT_MARGIN_MS,
      );
      if (!outcome.ok) {
        setFlowError(errorText(outcome.code));
        return;
      }
      setBaselineConfirmed(true);
      await refreshCalibration();
    });
  }

  function captureAll() {
    const durationMs = Math.max(500, Math.round(durationSeconds * 1000));
    return withPending("capture_all", async () => {
      setFlowError("");
      const outcome = await command(
        t("calCaptureAll"),
        { command: "calibration_capture_all", level: pressureKpa, duration_ms: durationMs },
        durationMs + CAPTURE_TIMEOUT_MARGIN_MS,
      );
      if (!outcome.ok) {
        setFlowError(errorText(outcome.code));
        return;
      }
      setLevelCells(previewCells(preferredLayer(recordValue(outcome.result))));
      await refreshCalibration();
    });
  }

  function captureSelectedSensor() {
    const durationMs = Math.max(500, Math.round(durationSeconds * 1000));
    const captured = selectedSensor;
    return withPending("capture_one", async () => {
      setFlowError("");
      const outcome = await command(
        t("calSingleSensor"),
        { command: "calibration_capture_cell", sensor_index: captured, level: pressureKpa, duration_ms: durationMs },
        durationMs + CAPTURE_TIMEOUT_MARGIN_MS,
      );
      if (!outcome.ok) {
        setFlowError(errorText(outcome.code));
        return;
      }
      const cells = previewCells(preferredLayer(recordValue(outcome.result)));
      setLevelCells(cells);
      for (let offset = 1; offset < totalSensors; offset += 1) {
        const next = (captured + offset) % totalSensors;
        if (cells.get(next)?.value == null) {
          setSelectedSensor(next);
          break;
        }
      }
      await refreshCalibration();
    });
  }

  function deleteDraftLevel(level: number) {
    return withPending("delete_level", async () => {
      setFlowError("");
      const outcome = await command(t("deleteCalibrationLevel"), { command: "calibration_delete_level", level });
      if (!outcome.ok) setFlowError(errorText(outcome.code));
    });
  }

  function saveCalibration() {
    return withPending("save", async () => {
      setFlowError("");
      const outcome = await command(t("calSave"), { command: "calibration_session_commit", auto_enable: true });
      if (!outcome.ok) {
        setFlowError(errorText(outcome.code));
        return;
      }
      await releaseMaintenance();
    });
  }

  function cancelCalibration() {
    return withPending("cancel", async () => {
      setFlowError("");
      const outcome = await command(t("calCancel"), { command: "calibration_session_abort" });
      if (!outcome.ok) {
        setFlowError(errorText(outcome.code));
        return;
      }
      await releaseMaintenance();
    });
  }

  // ---- Advanced -----------------------------------------------------------

  function advanced(label: string, payload: Record<string, unknown>, needsMaintenance = false) {
    return withPending("advanced", async () => {
      setAdvancedError("");
      const wasMaintenance = maintenanceMode;
      if (needsMaintenance && !(await ensureMaintenance(setAdvancedError))) return;
      const outcome = await command(label, payload);
      if (needsMaintenance && !wasMaintenance && !calibration.session_active) {
        await command(t("exitMaintenance"), { command: "exit_maintenance" });
      }
      if (!outcome.ok) setAdvancedError(errorText(outcome.code));
    });
  }

  function loadPreview(title: string, payload: Record<string, unknown>) {
    return withPending("advanced", async () => {
      setAdvancedError("");
      const outcome = await command(title, payload);
      if (!outcome.ok) {
        setAdvancedError(errorText(outcome.code));
        return;
      }
      setPreview({ title, cells: previewCells(preferredLayer(recordValue(outcome.result))) });
    });
  }

  function confirmAction(request: ConfirmRequest) {
    setConfirm(null);
    if (request.kind === "cancel") {
      void cancelCalibration();
    } else if (request.kind === "clear") {
      setPreview(null);
      void advanced(t("clearCalibrationProfile"), { command: "calibration_clear_profile" }, true);
    } else {
      void advanced(t("deleteCalibrationLevel"), { command: "calibration_delete_level", level: request.level }, true);
    }
  }

  // ---- Rendering ----------------------------------------------------------

  const outputLabel = useMemo(() => outputModeLabel(t, calibration), [t, calibration]);

  return (
    <div className="settings-stack calibration-workbench">
      <div className="settings-detail-header">
        <div>
          <h3>{t("calTitle")}</h3>
          <p>{t("calCopy")}</p>
        </div>
        <span className={`cal-output-chip ${calibration.output_mode}`} aria-live="polite">
          <span className="cal-output-dot" aria-hidden="true" />
          {outputLabel}
        </span>
      </div>

      {!deviceConnected ? <p className="notice warning">{t("calOffline")}</p> : null}

      {calibration.legacy_missing_tare ? (
        <div className="calibration-warning-banner">
          <span className="banner-icon"><TriangleAlert size={18} strokeWidth={1.8} /></span>
          <div className="banner-text">{t("calLegacyTare")}</div>
        </div>
      ) : null}

      <section className="settings-card cal-card cal-zero-card">
        <div className="cal-card-body">
          <div className="cal-card-text">
            <h4>{t("calZeroTitle")}</h4>
            <p>{calibration.output_mode === "calibrated" ? t("calZeroCopyCalibrated") : t("calZeroCopy")}</p>
          </div>
          <div className="cal-zero-actions">
            <button
              className="button primary cal-zero-button"
              type="button"
              disabled={busy || zeroReason !== null}
              onClick={() => void zero()}
            >
              {pending === "zero" ? t("calZeroRunning") : t("calZeroAction")}
            </button>
            {calibration.tare_enabled && calibration.output_mode === "tared" ? (
              <button className="button ghost" type="button" disabled={busy || zeroReason !== null} onClick={() => void clearZero()}>
                {t("calZeroClear")}
              </button>
            ) : null}
          </div>
        </div>
        {pending === "zero" ? (
          <div className="cal-progress" style={{ "--cal-duration": `${ZERO_DURATION_MS}ms` } as CSSProperties}>
            <div className="cal-progress-fill" />
          </div>
        ) : null}
        {zeroReason === "session_active" ? <p className="cal-hint">{t("calZeroSessionBlocked")}</p> : null}
        {lastZeroAt && pending !== "zero" && !zeroError ? (
          <p className="cal-done">
            <CircleCheck size={16} strokeWidth={2} aria-hidden="true" />
            {t("calZeroDone").replace("{time}", lastZeroAt)}
          </p>
        ) : null}
        {zeroNeedsFirmware ? <p className="notice warning">{t("calZeroNeedsFirmware")}</p> : null}
        {zeroError ? <p className="notice error">{zeroError}</p> : null}
      </section>

      <section className="settings-card cal-card">
        <div className="cal-card-text">
          <h4>{t("calPressureTitle")}</h4>
          <p>{t("calPressureCopy")}</p>
        </div>

        <CalibrationSteps t={t} step={step} saveReady={saveReady} />

        {step === "not_started" ? (
          <div className="cal-step-panel" key="not_started">
            <p className="cal-profile-summary">
              {calibration.levels.length > 0
                ? t("calCurrentProfile")
                  .replace("{count}", String(calibration.levels.length))
                  .replace("{max}", formatNumber(maxLevel))
                : t("calNoProfile")}
              {calibration.levels.length > 0 ? (
                <span className={`status-pill ${calibration.enabled ? "live" : "waiting"}`}>
                  {calibration.enabled ? t("enabledState") : t("disabledState")}
                </span>
              ) : null}
            </p>
            <div className="actions compact">
              <button className="button primary" type="button" disabled={busy || !deviceConnected} onClick={() => void startCalibration()}>
                {pending === "start" ? t("running") : t("calStart")}
              </button>
            </div>
            {!maintenanceMode ? <p className="cal-hint">{t("calStartHint")}</p> : null}
          </div>
        ) : null}

        {step === "baseline" ? (
          <div className="cal-step-panel" key="baseline">
            <p>{t("calBaselineCopy").replace("{seconds}", String(BASELINE_DURATION_MS / 1000))}</p>
            <div className="actions compact">
              <button className="button primary" type="button" disabled={busy || !deviceConnected} onClick={() => void captureBaseline()}>
                {pending === "baseline" ? t("calCapturing") : t("calBaselineCapture")}
              </button>
              {calibration.draft_tare?.complete ? (
                <button className="button ghost" type="button" disabled={busy} onClick={() => setBaselineConfirmed(true)}>
                  {t("calBaselineReuse")}
                </button>
              ) : null}
            </div>
            {pending === "baseline" ? <CaptureProgress durationMs={BASELINE_DURATION_MS} /> : null}
          </div>
        ) : null}

        {step === "levels" ? (
          <div className="cal-step-panel" key="levels">
            <p>{t("calLevelsCopy")}</p>
            <div className="cal-capture-row">
              <label className="field cal-field">
                <span>{t("calPressureKpa")}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={pressureKpa}
                  onChange={(event) => setPressureKpa(Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
              <label className="field cal-field cal-field-narrow">
                <span>{t("calDurationSeconds")}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0.5}
                  step={0.5}
                  value={durationSeconds}
                  onChange={(event) => setDurationSeconds(Math.max(0.5, Number(event.target.value) || 3))}
                />
              </label>
              <button className="button primary" type="button" disabled={busy || !deviceConnected || pressureKpa <= 0} onClick={() => void captureAll()}>
                {pending === "capture_all" ? t("calCapturing") : t("calCaptureAll")}
              </button>
            </div>
            {pending === "capture_all" || pending === "capture_one" ? <CaptureProgress durationMs={durationSeconds * 1000} /> : null}

            <div className="app-group cal-level-group">
              <div className="app-group-header">
                <h4>{t("calCapturedPressures")}</h4>
                <span>{t("calSensorCount").replace("{count}", String(totalSensors))}</span>
              </div>
              {calibration.draft_levels.length > 0 ? (
                <ul className="app-group-list">
                  {calibration.draft_levels.map((item) => {
                    const pct = item.total_points > 0 ? Math.round((item.captured_points / item.total_points) * 100) : 0;
                    return (
                      <li key={item.level} className="cal-level-row">
                        <strong>{formatNumber(item.level)} kPa</strong>
                        <div className="app-budget-track" aria-hidden="true">
                          <div className={`app-budget-fill${item.complete ? "" : " partial"}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="cal-level-count">
                          {item.complete ? <Check size={14} strokeWidth={2.4} aria-label={t("profileComplete")} /> : `${item.captured_points}/${item.total_points}`}
                        </span>
                        <button className="button ghost compact app-destructive" type="button" disabled={busy} onClick={() => void deleteDraftLevel(item.level)}>
                          {t("delete")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="cal-empty">{t("calNoLevelsYet")}</p>
              )}
            </div>

            <details className="cal-disclosure" open={singleSensorOpen} onToggle={(event) => setSingleSensorOpen(event.currentTarget.open)}>
              <summary>
                <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
                {t("calSingleSensor")}
              </summary>
              <div className="cal-disclosure-body">
                <p className="cal-hint">{t("calSingleSensorCopy")}</p>
                <SensorMatrix
                  rows={rows}
                  cols={cols}
                  cells={levelCells}
                  selected={selectedSensor}
                  onSelect={setSelectedSensor}
                />
                <div className="actions compact">
                  <button className="button" type="button" disabled={busy || !deviceConnected || pressureKpa <= 0} onClick={() => void captureSelectedSensor()}>
                    {pending === "capture_one" ? t("calCapturing") : t("calCaptureOne").replace("{sensor}", `P${selectedSensor}`)}
                  </button>
                </div>
              </div>
            </details>
          </div>
        ) : null}

        {step !== "not_started" ? (
          <div className="cal-footer">
            <button className="button ghost app-destructive" type="button" disabled={busy} onClick={() => setConfirm({ kind: "cancel" })}>
              {pending === "cancel" ? t("running") : t("calCancel")}
            </button>
            <div className="cal-footer-save">
              {!saveReady && step === "levels" ? <span className="cal-hint">{t("calSaveHint")}</span> : null}
              <button className="button primary" type="button" disabled={busy || !saveReady} onClick={() => void saveCalibration()}>
                {pending === "save" ? t("running") : t("calSave")}
              </button>
            </div>
          </div>
        ) : null}
        {flowError ? <p className="notice error">{flowError}</p> : null}
      </section>

      <details className="settings-card cal-card cal-advanced">
        <summary>
          <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
          <span>
            <strong>{t("calAdvanced")}</strong>
            <small>{t("calAdvancedCopy")}</small>
          </span>
        </summary>
        <div className="cal-advanced-body">
          <ul className="app-group-list">
            <li className="cal-setting-row">
              <div>
                <strong>{t("calUseCalibration")}</strong>
                <p>{t("calUseCalibrationHint")}</p>
              </div>
              <button
                className="button compact"
                type="button"
                disabled={busy || !deviceConnected || (!calibration.enabled && !calibration.complete)}
                onClick={() => void advanced(
                  calibration.enabled ? t("disableCalibrationProfile") : t("enableCalibrationProfile"),
                  { command: calibration.enabled ? "calibration_disable" : "calibration_enable" },
                )}
              >
                {calibration.enabled ? t("calTurnOff") : t("calTurnOn")}
              </button>
            </li>
            <li className="cal-setting-row">
              <div>
                <strong>{t("maintenanceModeLabel")}</strong>
                <p>{maintenanceMode ? t("calMaintenanceOn") : t("calMaintenanceOff")}</p>
              </div>
              <button
                className="button compact"
                type="button"
                disabled={busy || !deviceConnected || calibration.session_active}
                onClick={() => void advanced(
                  maintenanceMode ? t("exitMaintenance") : t("enterMaintenance"),
                  maintenanceMode ? { command: "exit_maintenance" } : { command: "enter_maintenance", reason: "calibration" },
                )}
              >
                {maintenanceMode ? t("exitMaintenance") : t("enterMaintenance")}
              </button>
            </li>
            <li className="cal-setting-row">
              <div>
                <strong>{t("refreshStatus")}</strong>
                <p>{t("refreshCalibrationStatusHint")}</p>
              </div>
              <button className="button compact" type="button" disabled={busy || !deviceConnected} onClick={() => void advanced(t("refreshStatus"), { command: "calibration_status" })}>
                {t("refreshStatus")}
              </button>
            </li>
          </ul>

          <div className="app-group">
            <div className="app-group-header">
              <h4>{t("calSavedPressures")}</h4>
              <button
                className="button ghost compact"
                type="button"
                disabled={busy || !deviceConnected || !calibration.tare_complete}
                onClick={() => void loadPreview(t("calBaselineData"), { command: "calibration_dump_tare" })}
              >
                {t("calBaselineData")}
              </button>
            </div>
            {calibration.levels.length > 0 ? (
              <ul className="app-group-list">
                {calibration.levels.map((item) => (
                  <li key={item.level} className="cal-level-row">
                    <strong>{formatNumber(item.level)} kPa</strong>
                    <span className="cal-level-count">{item.captured_points}/{item.total_points}</span>
                    <button
                      className="button ghost compact"
                      type="button"
                      disabled={busy || !deviceConnected}
                      onClick={() => void loadPreview(`${formatNumber(item.level)} kPa`, { command: "calibration_dump_level", level: item.level })}
                    >
                      {t("preview")}
                    </button>
                    <button
                      className="button ghost compact app-destructive"
                      type="button"
                      disabled={busy || !deviceConnected || calibration.session_active}
                      onClick={() => setConfirm({ kind: "delete_saved", level: item.level })}
                    >
                      {t("delete")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cal-empty">{t("noCalibrationLevels")}</p>
            )}
          </div>

          {preview ? (
            <div className="cal-preview">
              <div className="app-group-header">
                <h4>{preview.title}</h4>
                <button className="button ghost compact" type="button" onClick={() => setPreview(null)}>{t("calClosePreview")}</button>
              </div>
              <p className="cal-hint">{t("calPreviewUnits")}</p>
              <SensorMatrix rows={rows} cols={cols} cells={preview.cells} showValues />
            </div>
          ) : null}

          <div className="cal-danger-row">
            <div>
              <strong>{t("clearCalibrationProfile")}</strong>
              <p>{t("clearCalibrationProfileHint")}</p>
            </div>
            <button
              className="button danger compact"
              type="button"
              disabled={busy || !deviceConnected || calibration.session_active}
              onClick={() => setConfirm({ kind: "clear" })}
            >
              {t("clearCalibrationProfile")}
            </button>
          </div>
          {advancedError ? <p className="notice error">{advancedError}</p> : null}
        </div>
      </details>

      {confirm ? (
        <ConfirmModal
          title={confirmTitle(t, confirm)}
          message={confirmMessage(t, confirm)}
          confirmLabel={confirm.kind === "cancel" ? t("calCancel") : confirm.kind === "clear" ? t("clearCalibrationProfile") : t("delete")}
          cancelLabel={confirm.kind === "cancel" ? t("calKeepCalibrating") : t("cancel")}
          destructive
          onConfirm={() => confirmAction(confirm)}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}

function outputModeLabel(t: (key: string) => string, calibration: CalibrationState) {
  switch (calibration.output_mode) {
    case "calibrated":
      return t("calOutputCalibrated").replace("{count}", String(calibration.levels.length));
    case "tared":
      return t("calOutputTared");
    default:
      return t("calOutputRaw");
  }
}

function confirmTitle(t: (key: string) => string, request: ConfirmRequest) {
  if (request.kind === "cancel") return t("calCancelConfirmTitle");
  if (request.kind === "clear") return t("calClearConfirmTitle");
  return t("calDeleteLevelConfirmTitle").replace("{level}", formatNumber(request.level));
}

function confirmMessage(t: (key: string) => string, request: ConfirmRequest) {
  if (request.kind === "cancel") return t("calCancelConfirmMessage");
  if (request.kind === "clear") return t("calClearConfirmMessage");
  return t("calDeleteLevelConfirmMessage");
}

function CalibrationSteps({ t, step, saveReady }: { t: (key: string) => string; step: CalibrationStep; saveReady: boolean }) {
  // Save is the third step: current once every captured pressure is complete.
  const current = step === "not_started" ? -1 : step === "baseline" ? 0 : saveReady ? 2 : 1;
  const labels = [t("calStepBaseline"), t("calStepLevels"), t("calStepSave")];
  return (
    <ol className={`cal-steps${step === "not_started" ? " idle" : ""}`} aria-label={t("calPressureTitle")}>
      {labels.map((label, index) => {
        const state = current < 0 ? "upcoming" : index < current ? "done" : index === current ? "current" : "upcoming";
        return (
          <li key={label} className={`cal-step ${state}`} aria-current={state === "current" ? "step" : undefined}>
            <span className="cal-step-mark" aria-hidden="true">
              {state === "done" ? <Check size={12} strokeWidth={3} /> : index + 1}
            </span>
            <span className="cal-step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function CaptureProgress({ durationMs }: { durationMs: number }) {
  return (
    <div className="cal-progress" style={{ "--cal-duration": `${Math.max(1, durationMs)}ms` } as CSSProperties}>
      <div className="cal-progress-fill" />
    </div>
  );
}

// Laid out as the physical matrix: firmware indexes sensors column-major
// (sensor = col * rows + row).
function SensorMatrix({
  rows,
  cols,
  cells,
  selected,
  onSelect,
  showValues = false,
}: {
  rows: number;
  cols: number;
  cells: Map<number, PreviewCell>;
  selected?: number;
  onSelect?: (sensorIndex: number) => void;
  showValues?: boolean;
}) {
  if (rows <= 0 || cols <= 0) return null;
  const items = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const sensorIndex = col * rows + row;
      const cell = cells.get(sensorIndex);
      const captured = cell?.value != null;
      const className = `cal-matrix-cell${captured ? " captured" : ""}${selected === sensorIndex ? " selected" : ""}`;
      const content = (
        <>
          <strong>P{sensorIndex}</strong>
          {showValues ? <small>{captured ? formatNumber(cell!.value as number) : "–"}</small> : null}
        </>
      );
      items.push(onSelect ? (
        <button key={sensorIndex} type="button" className={className} aria-pressed={selected === sensorIndex} onClick={() => onSelect(sensorIndex)}>
          {content}
        </button>
      ) : (
        <div key={sensorIndex} className={className}>{content}</div>
      ));
    }
  }
  return (
    <div className={`cal-matrix${showValues ? " values" : ""}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items}
    </div>
  );
}
