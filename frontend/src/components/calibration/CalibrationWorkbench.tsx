import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronRight, CircleCheck, Download, Plus } from "lucide-react";

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
  type CalibrationFitSettings,
  type CalibrationFitSummary,
  type CalibrationOverride,
  type CalibrationState,
  type CalibrationStep,
  type CalibrationSummary,
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

// A reply's payload: under `data` when relayed by a Gateway or Hub, at the
// top level on the direct TCP path.
function replyData(result: Record<string, unknown> | null | undefined) {
  const source = recordValue(result);
  const data = recordValue(source.data);
  return Object.keys(data).length > 0 ? data : source;
}

// The firmware names a level by round(kPa * 1000); so does this page.
function levelKey(level: number) {
  return Math.round(level * 1000);
}

function capturedCount(cells: Map<number, PreviewCell>) {
  let count = 0;
  cells.forEach((cell) => {
    if (cell.value != null) count += 1;
  });
  return count;
}

type LevelRow = {
  key: number;
  level: number;
  // null for a level added here that has no capture yet: the device only
  // learns a level from its first capture.
  summary: CalibrationSummary | null;
};

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
  const [durationSeconds, setDurationSeconds] = useState(3);
  const [newLevelInput, setNewLevelInput] = useState("");
  const [addLevelError, setAddLevelError] = useState("");
  // Levels added with "Add level" that have not been captured yet.
  const [addedLevels, setAddedLevels] = useState<number[]>([]);
  const [selectedLevelKey, setSelectedLevelKey] = useState<number | null>(null);
  const [selectedSensor, setSelectedSensor] = useState(0);
  // Each level's cells as the device last reported them, by levelKey().
  const [levelCells, setLevelCells] = useState<Map<number, Map<number, PreviewCell>>>(new Map());
  const [loadingLevelKey, setLoadingLevelKey] = useState<number | null>(null);
  // "key:captured" pairs whose dump failed, so a failing read is not retried
  // in a loop; a new capture count tries again.
  const failedLoadsRef = useRef(new Set<string>());
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
      setAddedLevels([]);
      setSelectedLevelKey(null);
      failedLoadsRef.current.clear();
    }
  }, [calibration.session_active]);

  // The draft's levels plus the ones added here and not captured yet.
  const levelRows = useMemo<LevelRow[]>(() => {
    const rows = new Map<number, LevelRow>();
    calibration.draft_levels.forEach((item) => rows.set(levelKey(item.level), { key: levelKey(item.level), level: item.level, summary: item }));
    addedLevels.forEach((level) => {
      if (!rows.has(levelKey(level))) rows.set(levelKey(level), { key: levelKey(level), level, summary: null });
    });
    return [...rows.values()].sort((a, b) => a.level - b.level);
  }, [calibration.draft_levels, addedLevels]);
  const selectedRow = levelRows.find((row) => row.key === selectedLevelKey) ?? null;
  const deviceCapturedAtSelected = selectedRow?.summary?.captured_points ?? 0;
  const cachedSelectedCells = selectedRow ? levelCells.get(selectedRow.key) : undefined;
  // Known when the device has nothing at this level, or when the cells read
  // back agree with the device's own count; otherwise the matrix waits for a
  // fresh read rather than showing another level's (or stale) state.
  const selectedCellsKnown = selectedRow !== null
    && (deviceCapturedAtSelected === 0 || (cachedSelectedCells !== undefined && capturedCount(cachedSelectedCells) === deviceCapturedAtSelected));
  const selectedCells = selectedCellsKnown && deviceCapturedAtSelected > 0 ? cachedSelectedCells ?? new Map() : new Map<number, PreviewCell>();

  // Keep a level selected: the first one when none is (or it was deleted).
  useEffect(() => {
    if (selectedRow || levelRows.length === 0) {
      if (levelRows.length === 0 && selectedLevelKey !== null) setSelectedLevelKey(null);
      return;
    }
    setSelectedLevelKey(levelRows[0].key);
  }, [levelRows, selectedRow, selectedLevelKey]);

  // Read the selected level's cells from the device whenever what is shown
  // would not match what the device holds.
  useEffect(() => {
    if (!selectedRow || selectedCellsKnown || busy || loadingLevelKey !== null || !deviceConnected) return;
    const attempt = `${selectedRow.key}:${deviceCapturedAtSelected}`;
    if (failedLoadsRef.current.has(attempt)) return;
    void loadLevelCells(selectedRow, attempt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow?.key, deviceCapturedAtSelected, selectedCellsKnown, busy, loadingLevelKey, deviceConnected]);

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

  // A capture whose reply was lost may still have been stored on the
  // device, so re-read its state rather than keep showing the old one. Not
  // when nothing answered at all: that refresh would only time out too.
  async function refreshAfterFailedCapture(outcome: Outcome) {
    if (outcome.code !== "no_response") await refreshCalibration();
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
        await refreshAfterFailedCapture(outcome);
        return;
      }
      setBaselineConfirmed(true);
      await refreshCalibration();
    });
  }

  function rememberLevelCells(key: number, cells: Map<number, PreviewCell>) {
    setLevelCells((current) => new Map(current).set(key, cells));
  }

  function firstUncaptured(cells: Map<number, PreviewCell>, from = 0) {
    for (let offset = 0; offset < totalSensors; offset += 1) {
      const index = (from + offset) % totalSensors;
      if (cells.get(index)?.value == null) return index;
    }
    return from;
  }

  async function loadLevelCells(row: LevelRow, attempt: string) {
    setLoadingLevelKey(row.key);
    try {
      const outcome = await command(t("calLoadingLevel"), { command: "calibration_dump_level", level: row.level });
      if (!outcome.ok) {
        failedLoadsRef.current.add(attempt);
        return;
      }
      const cells = previewCells(preferredLayer(replyData(outcome.result)));
      rememberLevelCells(row.key, cells);
      setSelectedSensor((current) => (cells.get(current)?.value == null ? current : firstUncaptured(cells, current)));
    } finally {
      setLoadingLevelKey(null);
    }
  }

  function selectLevel(row: LevelRow) {
    setSelectedLevelKey(row.key);
    const cells = levelCells.get(row.key);
    setSelectedSensor(cells ? firstUncaptured(cells) : 0);
  }

  function addLevel() {
    setAddLevelError("");
    const level = Number(newLevelInput);
    if (!newLevelInput.trim() || !Number.isFinite(level) || level <= 0) {
      setAddLevelError(t("calLevelInvalid"));
      return;
    }
    const key = levelKey(level);
    const existing = levelRows.find((row) => row.key === key);
    if (existing) {
      setAddLevelError(t("calLevelExists").replace("{level}", formatNumber(existing.level)));
      selectLevel(existing);
      return;
    }
    setAddedLevels((current) => [...current, level]);
    setSelectedLevelKey(key);
    setSelectedSensor(0);
    setNewLevelInput("");
  }

  function captureAll() {
    if (!selectedRow) return undefined;
    const row = selectedRow;
    const durationMs = Math.max(500, Math.round(durationSeconds * 1000));
    return withPending("capture_all", async () => {
      setFlowError("");
      const outcome = await command(
        t("calCaptureAll"),
        { command: "calibration_capture_all", level: row.level, duration_ms: durationMs },
        durationMs + CAPTURE_TIMEOUT_MARGIN_MS,
      );
      if (!outcome.ok) {
        setFlowError(errorText(outcome.code));
        await refreshAfterFailedCapture(outcome);
        return;
      }
      rememberLevelCells(row.key, previewCells(preferredLayer(replyData(outcome.result))));
      await refreshCalibration();
    });
  }

  function captureSelectedSensor() {
    if (!selectedRow) return undefined;
    const row = selectedRow;
    const durationMs = Math.max(500, Math.round(durationSeconds * 1000));
    const captured = selectedSensor;
    return withPending("capture_one", async () => {
      setFlowError("");
      const outcome = await command(
        t("calSingleSensor"),
        { command: "calibration_capture_cell", sensor_index: captured, level: row.level, duration_ms: durationMs },
        durationMs + CAPTURE_TIMEOUT_MARGIN_MS,
      );
      if (!outcome.ok) {
        setFlowError(errorText(outcome.code));
        await refreshAfterFailedCapture(outcome);
        return;
      }
      const cells = previewCells(preferredLayer(replyData(outcome.result)));
      rememberLevelCells(row.key, cells);
      setSelectedSensor(firstUncaptured(cells, captured + 1));
      await refreshCalibration();
    });
  }

  function deleteDraftLevel(row: LevelRow) {
    const forget = () => {
      setAddedLevels((current) => current.filter((level) => levelKey(level) !== row.key));
      setLevelCells((current) => {
        const next = new Map(current);
        next.delete(row.key);
        return next;
      });
      if (selectedLevelKey === row.key) setSelectedLevelKey(null);
    };
    if (!row.summary) {
      forget();
      return undefined;
    }
    return withPending("delete_level", async () => {
      setFlowError("");
      const outcome = await command(t("deleteCalibrationLevel"), { command: "calibration_delete_level", level: row.level });
      if (!outcome.ok) {
        setFlowError(errorText(outcome.code));
        return;
      }
      forget();
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
      setPreview({ title, cells: previewCells(preferredLayer(replyData(outcome.result))) });
    });
  }

  // Everything the device's fit was made from, plus the fit itself, as one
  // JSON file: the record to keep with an experiment or a paper.
  function exportCalibrationData() {
    return withPending("advanced", async () => {
      setAdvancedError("");
      const dumps: Record<string, unknown> = {};
      const steps: [string, Record<string, unknown>][] = [
        ["status", { command: "calibration_status" }],
        ["tare", { command: "calibration_dump_tare" }],
        ["fit", { command: "calibration_dump_fit" }],
        ...calibration.levels.map((item): [string, Record<string, unknown>] => (
          [`level_${item.level}`, { command: "calibration_dump_level", level: item.level }]
        )),
      ];
      for (const [key, payload] of steps) {
        const outcome = await command(t("calExportData"), payload);
        if (!outcome.ok) {
          setAdvancedError(errorText(outcome.code));
          return;
        }
        dumps[key] = replyData(outcome.result);
      }
      const file = {
        exported_at: new Date().toISOString(),
        device_uid: deviceUid,
        matrix_shape: { rows, cols },
        model: "p = a + b*sqrt(x) + c*x, x = readout(raw - tare)",
        ...dumps,
      };
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `calibration-${deviceUid}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      link.click();
      URL.revokeObjectURL(url);
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

            <div className="app-group cal-level-group">
              <div className="app-group-header">
                <h4>{t("calLevelsTitle")}</h4>
                <span>{t("calSensorCount").replace("{count}", String(totalSensors))}</span>
              </div>
              {levelRows.length > 0 ? (
                <ul className="app-group-list">
                  {levelRows.map((row) => {
                    const captured = row.summary?.captured_points ?? 0;
                    const total = row.summary?.total_points || totalSensors;
                    const pct = total > 0 ? Math.round((captured / total) * 100) : 0;
                    const active = row.key === selectedRow?.key;
                    return (
                      <li key={row.key} className={`cal-level-row selectable${active ? " active" : ""}`}>
                        <button
                          className="cal-level-select"
                          type="button"
                          aria-pressed={active}
                          disabled={busy}
                          onClick={() => selectLevel(row)}
                        >
                          <strong>{row.summary ? levelLabel(t, row.level, row.summary.reference) : `${formatNumber(row.level)} kPa`}</strong>
                        </button>
                        <div className="app-budget-track" aria-hidden="true">
                          <div className={`app-budget-fill${row.summary?.complete ? "" : " partial"}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="cal-level-count">
                          {captured === 0
                            ? t("calLevelNotCaptured")
                            : row.summary?.complete
                              ? <Check size={14} strokeWidth={2.4} aria-label={t("profileComplete")} />
                              : `${captured}/${total}`}
                        </span>
                        <button className="button ghost compact app-destructive" type="button" disabled={busy} onClick={() => void deleteDraftLevel(row)}>
                          {t("delete")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="cal-empty">{t("calNoLevelsYet")}</p>
              )}
              <div className="cal-capture-row cal-add-level">
                <label className="field cal-field">
                  <span>{t("calNewLevelKpa")}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={newLevelInput}
                    placeholder="10"
                    onChange={(event) => {
                      setNewLevelInput(event.target.value);
                      setAddLevelError("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") addLevel();
                    }}
                  />
                </label>
                <button className="button" type="button" disabled={busy} onClick={addLevel}>
                  <Plus size={14} strokeWidth={2.2} aria-hidden="true" />
                  {t("calAddLevel")}
                </button>
              </div>
              {addLevelError ? <p className="cal-hint cal-add-level-error">{addLevelError}</p> : null}
              <FitProgress t={t} fit={calibration.draft_fit} settings={calibration.fit_settings} />
            </div>

            {selectedRow ? (
              <div className="app-group cal-level-detail" key={selectedRow.key}>
                <div className="app-group-header">
                  <h4>{t("calLevelDetailTitle").replace("{level}", formatNumber(selectedRow.level))}</h4>
                  <span>
                    {selectedCellsKnown
                      ? t("calLevelCapturedCount")
                        .replace("{captured}", String(deviceCapturedAtSelected))
                        .replace("{total}", String(totalSensors))
                      : t("calLoadingLevel")}
                  </span>
                </div>
                <p className="cal-hint">{t("calSingleSensorCopy")}</p>
                <div className={`cal-matrix-wrap${selectedCellsKnown ? "" : " loading"}`} aria-busy={!selectedCellsKnown}>
                  <SensorMatrix
                    rows={rows}
                    cols={cols}
                    cells={selectedCells}
                    selected={selectedSensor}
                    onSelect={setSelectedSensor}
                  />
                  {!selectedCellsKnown ? <div className="cal-matrix-loading">{t("calLoadingLevel")}</div> : null}
                </div>
                <div className="cal-matrix-legend" aria-hidden="true">
                  <span><i className="cal-legend-swatch captured" />{t("calLegendCaptured")}</span>
                  <span><i className="cal-legend-swatch" />{t("calLegendMissing")}</span>
                </div>
                <div className="cal-capture-row">
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
                  <button
                    className="button primary"
                    type="button"
                    disabled={busy || !deviceConnected || !selectedCellsKnown}
                    onClick={() => void captureSelectedSensor()}
                  >
                    {pending === "capture_one" ? t("calCapturing") : t("calCaptureOne").replace("{sensor}", `P${selectedSensor}`)}
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy || !deviceConnected || !selectedCellsKnown}
                    onClick={() => void captureAll()}
                  >
                    {pending === "capture_all" ? t("calCapturing") : t("calCaptureAll")}
                  </button>
                </div>
                {pending === "capture_all" || pending === "capture_one" ? <CaptureProgress durationMs={durationSeconds * 1000} /> : null}
              </div>
            ) : null}
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
                    <strong>{levelLabel(t, item.level, item.reference)}</strong>
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

          <FitProgress t={t} fit={calibration.fit} settings={calibration.fit_settings} saved />

          <FitSettingsEditor
            t={t}
            settings={calibration.fit_settings}
            disabled={busy || !deviceConnected || calibration.session_active}
            onApply={(values) => void advanced(t("calFitSettingsTitle"), { command: "calibration_set_fit", ...values }, true)}
          />

          <div className="cal-setting-row">
            <div>
              <strong>{t("calExportData")}</strong>
              <p>{t("calExportDataHint")}</p>
            </div>
            <button
              className="button compact"
              type="button"
              disabled={busy || !deviceConnected || !calibration.tare_complete}
              onClick={() => void exportCalibrationData()}
            >
              <Download size={14} strokeWidth={2} aria-hidden="true" />
              {t("calExportAction")}
            </button>
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

function levelLabel(t: (key: string) => string, level: number, reference: number) {
  const base = `${formatNumber(level)} kPa`;
  // A pressure chamber records what it actually reached; show it when it
  // differs from the level's name, since that is what the fit uses.
  return Math.abs(reference - level) >= 0.0005
    ? `${base} (${t("calReferenceMeasured").replace("{value}", formatNumber(reference))})`
    : base;
}

function FitProgress({
  t,
  fit,
  settings,
  saved = false,
}: {
  t: (key: string) => string;
  fit: CalibrationFitSummary | null;
  settings: CalibrationFitSettings | null;
  saved?: boolean;
}) {
  if (!fit || fit.cells_total === 0) return null;
  const needPoints = fit.failures.too_few_points + fit.failures.no_tare;
  const failedList = fit.failed.map((item) => `P${item.sensor_index}`).join(", ");
  const more = fit.cells_total - fit.cells_fitted - fit.failed.length;
  return (
    <div className="cal-fit-progress" aria-live="polite">
      <p className={fit.complete ? "cal-done" : "cal-hint"}>
        {fit.complete ? <CircleCheck size={16} strokeWidth={2} aria-hidden="true" /> : null}
        {t(saved ? "calFitSaved" : "calFitProgress")
          .replace("{fitted}", String(fit.cells_fitted))
          .replace("{total}", String(fit.cells_total))}
      </p>
      {!fit.complete && needPoints > 0 ? (
        <p className="cal-hint">
          {t("calFitNeedPoints")
            .replace("{count}", String(needPoints))
            .replace("{points}", String(settings?.min_points ?? 3))
            .replace("{level}", formatNumber(settings?.min_level ?? 3))}
        </p>
      ) : null}
      {fit.failures.singular > 0 ? (
        <p className="cal-hint">{t("calFitSingular").replace("{count}", String(fit.failures.singular))}</p>
      ) : null}
      {failedList ? (
        <p className="cal-hint">
          {t("calFitFailedList").replace("{sensors}", more > 0 ? `${failedList} +${more}` : failedList)}
        </p>
      ) : null}
    </div>
  );
}

// The paper's readout curves (AC14, Rfb 8.2 kOhm): ADC1 and ADC2 measured
// separately, analysis/r01b_adc{1,2}_fit.json.
const PAPER_READOUT = { adc1_c1: 2.6656779, adc1_c2: -9.4473953e-05, adc2_c1: 2.6606, adc2_c2: -8.871e-05 };
const IDENTITY_READOUT = { adc1_c1: 1, adc1_c2: 0, adc2_c1: 1, adc2_c2: 0 };

type FitSettingsValues = {
  min_level: number;
  adc1_c1: number;
  adc1_c2: number;
  adc2_c1: number;
  adc2_c2: number;
};

function FitSettingsEditor({
  t,
  settings,
  disabled,
  onApply,
}: {
  t: (key: string) => string;
  settings: CalibrationFitSettings | null;
  disabled: boolean;
  onApply: (values: FitSettingsValues) => void;
}) {
  const fromDevice = (): FitSettingsValues => ({
    min_level: settings?.min_level ?? 3,
    adc1_c1: settings?.readout[0]?.c1 ?? 1,
    adc1_c2: settings?.readout[0]?.c2 ?? 0,
    adc2_c1: settings?.readout[1]?.c1 ?? 1,
    adc2_c2: settings?.readout[1]?.c2 ?? 0,
  });
  const [values, setValues] = useState<FitSettingsValues>(fromDevice);
  const deviceKey = JSON.stringify(settings);
  useEffect(() => {
    setValues(fromDevice());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceKey]);
  if (!settings) return null;
  const field = (key: keyof FitSettingsValues, label: string) => (
    <label className="field cal-field cal-field-narrow" key={key}>
      <span>{label}</span>
      <input
        type="number"
        step="any"
        value={values[key]}
        disabled={disabled}
        onChange={(event) => setValues((current) => ({ ...current, [key]: Number(event.target.value) }))}
      />
    </label>
  );
  return (
    <div className="app-group cal-fit-settings">
      <div className="app-group-header">
        <h4>{t("calFitSettingsTitle")}</h4>
      </div>
      <p className="cal-hint">{t("calFitSettingsCopy")}</p>
      <div className="cal-capture-row">
        {field("min_level", t("paramFitMinLevel"))}
        {field("adc1_c1", t("paramAdc1C1"))}
        {field("adc1_c2", t("paramAdc1C2"))}
        {field("adc2_c1", t("paramAdc2C1"))}
        {field("adc2_c2", t("paramAdc2C2"))}
      </div>
      <div className="actions compact">
        <button className="button ghost compact" type="button" disabled={disabled} onClick={() => setValues((current) => ({ ...current, ...PAPER_READOUT }))}>
          {t("calFitPresetPaper")}
        </button>
        <button className="button ghost compact" type="button" disabled={disabled} onClick={() => setValues((current) => ({ ...current, ...IDENTITY_READOUT }))}>
          {t("calFitPresetIdentity")}
        </button>
        <button className="button compact" type="button" disabled={disabled} onClick={() => onApply(values)}>
          {t("calFitApply")}
        </button>
      </div>
    </div>
  );
}
