import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { useI18n } from "../i18n";
import { normalizeDevice, useDevicesPolling } from "../lib/device";
import { useDeviceCommand } from "../lib/deviceCommand";
import { appHref } from "../lib/runtime";
import { BoardIoModal } from "./TerminalPage";

const DEFAULT_MANIFEST_URL = "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-latest.json";
const STANDARD_LOG_BYTES = 16 * 1024;
const EXTENDED_LOG_BYTES = 32 * 1024;
const DEFAULT_EXTERNAL_LED_BRIGHTNESS = 0.35;
const EXTERNAL_LED_BRIGHTNESS_OPTIONS = [
  { value: 0.1, labelKey: "brightnessOption_10" },
  { value: 0.2, labelKey: "brightnessOption_20" },
  { value: 0.35, labelKey: "brightnessOption_35" },
  { value: 0.5, labelKey: "brightnessOption_50" },
  { value: 1, labelKey: "brightnessOption_100_danger" },
] as const;
const STATUS_DRIVEN_SECTIONS: SettingsSection[] = ["about", "gateway", "update", "diagnostics", "flash"];

type SettingsSection =
  | "about"
  | "gateway"
  | "update"
  | "pins"
  | "maintenance"
  | "indicators"
  | "diagnostics"
  | "flash";

type OperationLogEntry = {
  id: number;
  label: string;
  command: string;
  message: string;
  ok: boolean;
  time: string;
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = "-") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function externalLedBrightnessValue(value: unknown) {
  const parsed = numberValue(value, DEFAULT_EXTERNAL_LED_BRIGHTNESS);
  return EXTERNAL_LED_BRIGHTNESS_OPTIONS.some((option) => option.value === parsed)
    ? parsed
    : DEFAULT_EXTERNAL_LED_BRIGHTNESS;
}

function hasIndicatorData(value: unknown) {
  const indicators = recordValue(value);
  return Object.keys(recordValue(indicators.external_led)).length > 0 || Object.keys(recordValue(indicators.oled)).length > 0;
}

function boolString(value: unknown) {
  if (value === true) return "true";
  if (value === false) return "false";
  return stringValue(value);
}

function numberCsv(value: string) {
  return value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item));
}

function arrayCsv(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isFinite(item)).join(",")
    : "";
}

function percent(used: unknown, total: unknown) {
  const usedNumber = numberValue(used, 0);
  const totalNumber = numberValue(total, 0);
  if (totalNumber <= 0) return 0;
  return Math.max(0, Math.min(100, (usedNumber / totalNumber) * 100));
}

function bytesLabel(value: unknown) {
  const bytes = numberValue(value, 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function storageCategories(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      scope: stringValue(item.scope, "other"),
      bytes: numberValue(item.bytes, 0),
    }))
    .filter((item) => item.bytes > 0);
}

function shouldAutoRefreshStatusForSection(section: SettingsSection) {
  return STATUS_DRIVEN_SECTIONS.some((item) => item === section);
}

function pretty(value: unknown) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function isLiveQueryCommand(command: string) {
  return [
    "status",
    "query",
    "memory_status",
    "scan_health",
    "storage_status",
    "log_tail",
    "calibration_status",
    "calibration_dump_level",
    "findme_discover",
  ].includes(command);
}

function Metric({ label, value, small = false }: { label: string; value: unknown; small?: boolean }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className={`metric-value${small ? " small-value" : ""}`}>{stringValue(value)}</div>
    </div>
  );
}

function DetailBox({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{stringValue(value)}</strong>
    </div>
  );
}

type DeviceCommandResult = {
  queued?: unknown;
  result?: Record<string, unknown> | null;
};

type CalibrationSummary = {
  level: number;
  captured_points: number;
  total_points: number;
  missing_points: number;
  complete: boolean;
  source: string;
};

type CalibrationState = {
  enabled: boolean;
  mode_active: boolean;
  session_active: boolean;
  complete: boolean;
  levels: CalibrationSummary[];
  draft_levels: CalibrationSummary[];
  metadata: Record<string, unknown>;
};

type CalibrationCell = {
  sensor_index: number;
  row: number;
  col: number;
  calibrated: boolean;
  value: number | null;
};

type CalibrationLevelLayer = {
  level: number;
  captured_points: number;
  total_points: number;
  complete: boolean;
  cells: CalibrationCell[];
} | null;

type CalibrationLevelPreview = {
  level: number;
  total_points: number;
  saved: CalibrationLevelLayer;
  draft: CalibrationLevelLayer;
  session_active: boolean;
};

type CalibrationWorkbenchProps = {
  t: (key: string) => string;
  deviceUid: string;
  isDeviceOffline: boolean;
  matrixShape: Record<string, unknown>;
  calibrationStatus: Record<string, unknown>;
  busyCommand: string;
  maintenanceMode: boolean;
  run: (label: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<DeviceCommandResult>;
};

function calibrationSource(value: unknown) {
  const direct = recordValue(value);
  const nested = recordValue(direct.calibration);
  if (Object.keys(nested).length > 0) {
    return nested;
  }
  const hasTopLevelKeys = [
    "enabled",
    "mode_active",
    "session_active",
    "complete",
    "levels",
    "draft_levels",
    "metadata",
  ].some((key) => key in direct);
  return hasTopLevelKeys ? direct : {};
}

function parseCalibrationSummaryList(value: unknown): CalibrationSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => recordValue(item))
    .filter((item) => Object.keys(item).length > 0)
    .map((item) => ({
      level: numberValue(item.level, 0),
      captured_points: numberValue(item.captured_points, 0),
      total_points: numberValue(item.total_points, 0),
      missing_points: numberValue(item.missing_points, 0),
      complete: item.complete === true,
      source: stringValue(item.source, "saved"),
    }));
}

function parseCalibrationState(value: unknown): CalibrationState {
  const source = calibrationSource(value);
  return {
    enabled: source.enabled === true,
    mode_active: source.mode_active === true,
    session_active: source.session_active === true,
    complete: source.complete === true,
    levels: parseCalibrationSummaryList(source.levels),
    draft_levels: parseCalibrationSummaryList(source.draft_levels),
    metadata: recordValue(source.metadata),
  };
}

function parseCalibrationCells(value: unknown): CalibrationCell[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => recordValue(item))
    .filter((item) => Object.keys(item).length > 0)
    .map((item) => ({
      sensor_index: numberValue(item.sensor_index, -1),
      row: numberValue(item.row, 0),
      col: numberValue(item.col, 0),
      calibrated: item.calibrated === true,
      value: item.value === null || item.value === undefined ? null : numberValue(item.value, 0),
    }))
    .filter((item) => item.sensor_index >= 0);
}

function parseCalibrationLayer(value: unknown): CalibrationLevelLayer {
  if (value === null || value === undefined) return null;
  const source = recordValue(value);
  if (Object.keys(source).length === 0) return null;
  return {
    level: numberValue(source.level, 0),
    captured_points: numberValue(source.captured_points, 0),
    total_points: numberValue(source.total_points, 0),
    complete: source.complete === true,
    cells: parseCalibrationCells(source.cells),
  };
}

function parseCalibrationLevelPreview(value: unknown): CalibrationLevelPreview | null {
  const source = recordValue(value);
  if (!("level" in source) && !("saved" in source) && !("draft" in source)) {
    return null;
  }
  return {
    level: numberValue(source.level, 0),
    total_points: numberValue(source.total_points, 0),
    saved: parseCalibrationLayer(source.saved),
    draft: parseCalibrationLayer(source.draft),
    session_active: source.session_active === true,
  };
}

function calibrationCellLookup(layer: CalibrationLevelLayer) {
  const lookup = new Map<number, CalibrationCell>();
  if (!layer) return lookup;
  layer.cells.forEach((cell) => {
    lookup.set(cell.sensor_index, cell);
  });
  return lookup;
}

function CalibrationWorkbench({
  t,
  deviceUid,
  isDeviceOffline,
  matrixShape,
  calibrationStatus,
  busyCommand,
  maintenanceMode,
  run,
}: CalibrationWorkbenchProps) {
  const rows = numberValue(matrixShape.rows, 0);
  const cols = numberValue(matrixShape.cols, 0);
  const [calibrationState, setCalibrationState] = useState<CalibrationState>(() => parseCalibrationState(calibrationStatus));
  const [selectedCalibrationSensor, setSelectedCalibrationSensor] = useState(0);
  const [calibrationLevel, setCalibrationLevel] = useState(10);
  const [calibrationDuration, setCalibrationDuration] = useState(3000);
  const [selectedLevel, setSelectedLevel] = useState<number | null>(null);
  const [calibrationLevelPreview, setCalibrationLevelPreview] = useState<CalibrationLevelPreview | null>(null);
  const [calibrationPreviewError, setCalibrationPreviewError] = useState("");

  useEffect(() => {
    setCalibrationState(parseCalibrationState(calibrationStatus));
  }, [calibrationStatus]);

  useEffect(() => {
    const totalSensors = rows * cols;
    if (selectedCalibrationSensor >= totalSensors) {
      setSelectedCalibrationSensor(0);
    }
  }, [cols, rows, selectedCalibrationSensor]);

  async function syncCalibrationStatus() {
    const response = await run(t("refreshStatus"), { command: "calibration_status" });
    setCalibrationState(parseCalibrationState(response.result));
    return response;
  }

  async function loadLevelPreview(level: number) {
    setCalibrationPreviewError("");
    const response = await run(t("preview"), { command: "calibration_dump_level", level });
    const preview = parseCalibrationLevelPreview(response.result);
    if (!preview) {
      setCalibrationPreviewError(t("previewUnavailable"));
      return;
    }
    setSelectedLevel(level);
    setCalibrationLevelPreview(preview);
  }

  useEffect(() => {
    if (!deviceUid || isDeviceOffline) return;
    void syncCalibrationStatus().catch(() => undefined);
  }, [deviceUid, isDeviceOffline]);

  const totalSensors = rows * cols;
  const savedLookup = calibrationCellLookup(calibrationLevelPreview?.saved ?? null);
  const draftLookup = calibrationCellLookup(calibrationLevelPreview?.draft ?? null);
  const mergedLevels = useMemo(() => {
    const seen = new Map<number, CalibrationSummary>();
    calibrationState.levels.forEach((item) => seen.set(item.level, item));
    calibrationState.draft_levels.forEach((item) => {
      if (!seen.has(item.level)) seen.set(item.level, item);
    });
    return Array.from(seen.values()).sort((a, b) => a.level - b.level);
  }, [calibrationState.draft_levels, calibrationState.levels]);

  async function captureSelectedSensor() {
    await run(t("captureSelectedSensor"), {
      command: "calibration_capture_cell",
      sensor_index: selectedCalibrationSensor,
      level: calibrationLevel,
      duration_ms: calibrationDuration,
    }, 40000);
    await syncCalibrationStatus();
    await loadLevelPreview(calibrationLevel);
  }

  async function captureAllSensors() {
    await run(t("captureAllSensors"), {
      command: "calibration_capture_all",
      level: calibrationLevel,
      duration_ms: calibrationDuration,
    }, 45000);
    await syncCalibrationStatus();
    await loadLevelPreview(calibrationLevel);
  }

  async function startCalibrationSession() {
    await run(t("startCalibrationSession"), { command: "calibration_session_begin" });
    await syncCalibrationStatus();
  }

  async function abortCalibrationSession() {
    if (!window.confirm(t("abortCalibrationSessionConfirm"))) return;
    await run(t("abortCalibrationSession"), { command: "calibration_session_abort" });
    setCalibrationLevelPreview(null);
    setSelectedLevel(null);
    await syncCalibrationStatus();
  }

  async function commitCalibrationSession() {
    await run(t("commitCalibrationSession"), { command: "calibration_session_commit", auto_enable: false });
    await syncCalibrationStatus();
    if (selectedLevel !== null) {
      await loadLevelPreview(selectedLevel);
    }
  }

  async function enableCalibrationProfile() {
    await run(t("enableCalibrationProfile"), { command: "calibration_enable" });
    await syncCalibrationStatus();
  }

  async function disableCalibrationProfile() {
    await run(t("disableCalibrationProfile"), { command: "calibration_disable" });
    await syncCalibrationStatus();
  }

  async function clearCalibrationProfile() {
    if (!window.confirm(t("clearCalibrationProfileConfirm"))) return;
    await run(t("clearCalibrationProfile"), { command: "calibration_clear_profile" });
    setCalibrationLevelPreview(null);
    setSelectedLevel(null);
    await syncCalibrationStatus();
  }

  async function deleteCalibrationLevel(level: number) {
    if (!window.confirm(t("deleteCalibrationLevelConfirm"))) return;
    await run(t("deleteCalibrationLevel"), { command: "calibration_delete_level", level });
    if (selectedLevel === level) {
      setCalibrationLevelPreview(null);
      setSelectedLevel(null);
    }
    await syncCalibrationStatus();
  }

  return (
    <div className="settings-stack calibration-workbench">
      <div className="settings-detail-header">
        <div>
          <h3>{t("settingsSection_maintenance")}</h3>
          <p>{t("calibrationWorkbenchCopy")}</p>
        </div>
        <div className="actions compact">
          <button className="button primary" type="button" disabled={busyCommand === "enter_maintenance" || !deviceUid} onClick={() => void run(t("enterMaintenance"), { command: "enter_maintenance", reason: "calibration_workbench" })}>
            {busyCommand === "enter_maintenance" ? t("running") : t("enterMaintenance")}
          </button>
          <button className="button" type="button" disabled={busyCommand === "exit_maintenance" || !deviceUid} onClick={() => void run(t("exitMaintenance"), { command: "exit_maintenance" })}>
            {busyCommand === "exit_maintenance" ? t("running") : t("exitMaintenance")}
          </button>
          <button className="button" type="button" disabled={busyCommand === "calibration_status" || !deviceUid || isDeviceOffline} onClick={() => void syncCalibrationStatus()}>
            {busyCommand === "calibration_status" ? t("running") : t("refreshStatus")}
          </button>
        </div>
      </div>

      <div className="settings-detail-grid compact calibration-status-grid">
        <DetailBox label={t("maintenanceModeLabel")} value={maintenanceMode ? t("enabledState") : t("disabledState")} />
        <DetailBox label={t("calibrationEnabled")} value={calibrationState.enabled ? t("enabledState") : t("disabledState")} />
        <DetailBox label={t("calibrationSessionState")} value={calibrationState.session_active ? t("sessionActive") : t("sessionInactive")} />
        <DetailBox label={t("calibrationProfileState")} value={calibrationState.complete ? t("profileComplete") : t("profileIncomplete")} />
        <DetailBox label={t("calibrationLevelCount")} value={calibrationState.levels.length} />
        <DetailBox label={t("matrixShape")} value={`${rows || "-"} x ${cols || "-"}`} />
      </div>

      <div className="settings-card">
        <div className="settings-detail-header">
          <div>
            <h4>{t("calibrationFlowControls")}</h4>
            <p>{t("calibrationFlowControlsCopy")}</p>
          </div>
        </div>
        <div className="actions compact">
          <button className="button" type="button" disabled={busyCommand === "calibration_session_begin" || !maintenanceMode || !deviceUid} onClick={() => void startCalibrationSession()}>
            {busyCommand === "calibration_session_begin" ? t("running") : t("startCalibrationSession")}
          </button>
          <button className="button danger" type="button" disabled={busyCommand === "calibration_session_abort" || !maintenanceMode || !deviceUid} onClick={() => void abortCalibrationSession()}>
            {busyCommand === "calibration_session_abort" ? t("running") : t("abortCalibrationSession")}
          </button>
          <button className="button primary" type="button" disabled={busyCommand === "calibration_session_commit" || !maintenanceMode || !deviceUid} onClick={() => void commitCalibrationSession()}>
            {busyCommand === "calibration_session_commit" ? t("running") : t("commitCalibrationSession")}
          </button>
          <button className="button" type="button" disabled={busyCommand === "calibration_enable" || !deviceUid || !calibrationState.complete} onClick={() => void enableCalibrationProfile()}>
            {busyCommand === "calibration_enable" ? t("running") : t("enableCalibrationProfile")}
          </button>
          <button className="button" type="button" disabled={busyCommand === "calibration_disable" || !deviceUid} onClick={() => void disableCalibrationProfile()}>
            {busyCommand === "calibration_disable" ? t("running") : t("disableCalibrationProfile")}
          </button>
          <button className="button danger" type="button" disabled={busyCommand === "calibration_clear_profile" || !maintenanceMode || !deviceUid} onClick={() => void clearCalibrationProfile()}>
            {busyCommand === "calibration_clear_profile" ? t("running") : t("clearCalibrationProfile")}
          </button>
        </div>
      </div>

      <div className="calibration-layout">
        <section className="settings-card calibration-capture-card">
          <div className="settings-detail-header">
            <div>
              <h4>{t("calibrationCaptureTitle")}</h4>
              <p>{t("calibrationCaptureCopy")}</p>
            </div>
          </div>
          <div className="field-grid">
            <div className="field">
              <label>{t("paramLevel")}</label>
              <input type="number" value={calibrationLevel} onChange={(event) => setCalibrationLevel(Number(event.target.value) || 0)} />
            </div>
            <div className="field">
              <label>{t("paramDurationMs")}</label>
              <input type="number" value={calibrationDuration} onChange={(event) => setCalibrationDuration(Number(event.target.value) || 3000)} />
            </div>
            <div className="field">
              <label>{t("selectedCalibrationSensor")}</label>
              <input type="number" value={selectedCalibrationSensor} onChange={(event) => setSelectedCalibrationSensor(Math.max(0, Number(event.target.value) || 0))} />
            </div>
          </div>

          <div className="actions compact">
            <button className="button primary" type="button" disabled={busyCommand === "calibration_capture_cell" || !maintenanceMode || !deviceUid || totalSensors === 0} onClick={() => void captureSelectedSensor()}>
              {busyCommand === "calibration_capture_cell" ? t("running") : t("captureSelectedSensor")}
            </button>
            <button className="button" type="button" disabled={busyCommand === "calibration_capture_all" || !maintenanceMode || !deviceUid || totalSensors === 0} onClick={() => void captureAllSensors()}>
              {busyCommand === "calibration_capture_all" ? t("running") : t("captureAllSensors")}
            </button>
          </div>

          <div className="calibration-matrix" style={{ gridTemplateColumns: `repeat(${Math.max(cols, 1)}, minmax(0, 1fr))` }}>
            {Array.from({ length: totalSensors }).map((_, visualIndex) => {
              const rowIndex = rows > 0 ? visualIndex % rows : 0;
              const colIndex = rows > 0 ? Math.floor(visualIndex / rows) : 0;
              const sensorIndex = colIndex * rows + rowIndex;
              const draftCell = draftLookup.get(sensorIndex);
              const savedCell = savedLookup.get(sensorIndex);
              const activeCell = draftCell ?? savedCell;
              return (
                <button
                  key={sensorIndex}
                  className={`calibration-cell${selectedCalibrationSensor === sensorIndex ? " selected" : ""}${draftCell?.calibrated ? " draft" : ""}${!draftCell?.calibrated && savedCell?.calibrated ? " saved" : ""}`}
                  type="button"
                  onClick={() => setSelectedCalibrationSensor(sensorIndex)}
                >
                  <strong>P{sensorIndex}</strong>
                  <small>{activeCell?.calibrated ? String(activeCell.value ?? "-") : "-"}</small>
                </button>
              );
            })}
          </div>
        </section>

        <section className="settings-card calibration-browser-card">
          <div className="settings-detail-header">
            <div>
              <h4>{t("calibrationLevelBrowser")}</h4>
              <p>{t("calibrationLevelBrowserCopy")}</p>
            </div>
          </div>
          <div className="calibration-level-list">
            {mergedLevels.length > 0 ? mergedLevels.map((item) => (
              <div className={`calibration-level-item${selectedLevel === item.level ? " active" : ""}`} key={`${item.source}-${item.level}`}>
                <button type="button" onClick={() => void loadLevelPreview(item.level)}>
                  <strong>{t("paramLevel")} {item.level}</strong>
                  <span>{item.captured_points}/{item.total_points}</span>
                </button>
                <button className="button danger tiny" type="button" disabled={busyCommand === "calibration_delete_level" || !maintenanceMode} onClick={() => void deleteCalibrationLevel(item.level)}>
                  {t("delete")}
                </button>
              </div>
            )) : <p className="service-muted">{t("noCalibrationLevels")}</p>}
          </div>

          <div className="calibration-preview-panel">
            <div className="settings-detail-header">
              <div>
                <h4>{t("calibrationLevelPreview")}</h4>
                <p>{selectedLevel === null ? t("noPreviewSelected") : `${t("paramLevel")} ${selectedLevel}`}</p>
              </div>
              {selectedLevel !== null ? (
                <button className="button" type="button" disabled={busyCommand === "calibration_dump_level" || isDeviceOffline} onClick={() => void loadLevelPreview(selectedLevel)}>
                  {busyCommand === "calibration_dump_level" ? t("running") : t("preview")}
                </button>
              ) : null}
            </div>
            {calibrationPreviewError ? <p className="notice error">{calibrationPreviewError}</p> : null}
            {calibrationLevelPreview ? (
              <>
                <div className="settings-detail-grid compact">
                  <DetailBox label={t("savedCalibrationLayer")} value={calibrationLevelPreview.saved?.captured_points ?? 0} />
                  <DetailBox label={t("draftCalibrationLayer")} value={calibrationLevelPreview.draft?.captured_points ?? 0} />
                  <DetailBox label={t("calibrationSessionState")} value={calibrationLevelPreview.session_active ? t("sessionActive") : t("sessionInactive")} />
                </div>
                <div className="calibration-preview-grid" style={{ gridTemplateColumns: `repeat(${Math.max(cols, 1)}, minmax(0, 1fr))` }}>
                  {Array.from({ length: totalSensors }).map((_, visualIndex) => {
                    const rowIndex = rows > 0 ? visualIndex % rows : 0;
                    const colIndex = rows > 0 ? Math.floor(visualIndex / rows) : 0;
                    const sensorIndex = colIndex * rows + rowIndex;
                    const draftCell = draftLookup.get(sensorIndex);
                    const savedCell = savedLookup.get(sensorIndex);
                    const activeCell = draftCell ?? savedCell;
                    return (
                      <div key={`preview-${sensorIndex}`} className={`calibration-preview-cell${draftCell?.calibrated ? " draft" : ""}${!draftCell?.calibrated && savedCell?.calibrated ? " saved" : ""}`}>
                        <strong>P{sensorIndex}</strong>
                        <span>{activeCell?.calibrated ? String(activeCell.value ?? "-") : "-"}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="service-muted">{t("noPreviewSelected")}</p>
            )}
          </div>

          <div className="actions compact">
            <button className="button" type="button" disabled={busyCommand === "storage_status" || !deviceUid || isDeviceOffline} onClick={() => void run(t("refreshFlashUsage"), { command: "storage_status" })}>
              {busyCommand === "storage_status" ? t("running") : t("refreshFlashUsage")}
            </button>
            <button className="button" type="button" disabled={busyCommand === "log_tail" || !deviceUid || isDeviceOffline} onClick={() => void run("Log tail", { command: "log_tail", max_lines: 80 })}>
              {busyCommand === "log_tail" ? t("running") : "Logs"}
            </button>
            <a className="button" href={appHref(`device/${encodeURIComponent(deviceUid)}/files`)} target="_blank" rel="noreferrer">
              {t("maintenanceFiles")}
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

export function DeviceSettingsPage() {
  const { t } = useI18n();
  const { deviceUid = "" } = useParams();
  const { devices, refresh } = useDevicesPolling();
  const { queue, errorMessage } = useDeviceCommand(deviceUid);
  const device = useMemo(() => devices.find((item) => item.device_uid === deviceUid), [devices, deviceUid]);
  const normalized = device ? normalizeDevice(device) : null;
  const isDeviceOffline = normalized?.isOffline === true;
  const status = recordValue(device?.last_status);
  const lastResult = recordValue(device?.last_result);
  const lastResultCommand = stringValue(lastResult.command, "");
  const runtime = recordValue(status.runtime);
  const lastAppliedScanTiming = recordValue(lastResultCommand === "set_scan_timing" ? recordValue(lastResult.runtime).scan_timing : undefined);
  const rawFindme = recordValue(normalized?.findme ?? status.findme ?? runtime.findme);
  const scanHealthSource = recordValue(status.scan_health ?? lastResult.scan_health ?? (lastResultCommand === "scan_health" ? lastResult : undefined));
  const scanHealth = scanHealthSource;
  const scanTiming = recordValue(runtime.scan_timing);
  const streamBuffer = recordValue(status.stream_buffer ?? runtime.stream_buffer ?? (lastResultCommand === "set_stream_buffer" ? lastResult.stream_buffer : undefined));
  const confirmedScanTiming = recordValue(lastAppliedScanTiming ?? scanTiming);
  const matrixLayout = recordValue(status.matrix_layout ?? device?.last_result?.matrix_layout);
  const analogPinsFromStatus = arrayCsv(matrixLayout.analog_pins ?? matrixLayout.active_rows);
  const selectPinsFromStatus = arrayCsv(matrixLayout.select_pins ?? matrixLayout.active_cols);
  const wifi = recordValue(status.wifi);
  const batteryStatus = recordValue(status.battery ?? (lastResultCommand === "set_charge_profile" ? lastResult.battery : undefined));
  const powerStatus = recordValue(status.power ?? (lastResultCommand === "power_set_state" ? lastResult.power : undefined));
  // The backend hoists memory_status's `data` (heap_*) onto last_status's top
  // level, so read from there; fall back to the fresh memory_status result.
  const memory = recordValue(status.memory ?? (lastResultCommand === "memory_status" ? recordValue(lastResult.data) : undefined) ?? status);
  const logging = recordValue(status.logging ?? runtime.logging ?? (lastResultCommand === "set_log" ? lastResult.logging : undefined));
  const otaConfig = recordValue(status.ota ?? status.update_config ?? (lastResultCommand === "set_ota_config" ? lastResult.ota : undefined));
  const storage = recordValue(status.storage ?? (lastResultCommand === "storage_status" ? lastResult : undefined));
  const storageUsage = storageCategories(storage.categories);
  const storageTotal = numberValue(storage.total_bytes, 0);
  const storageUsed = numberValue(storage.used_bytes, 0);
  const ramTotal = numberValue(memory.heap_total, 0);
  const ramFree = numberValue(memory.heap_free, 0);
  const ramUsed = numberValue(memory.heap_used, ramTotal > ramFree ? ramTotal - ramFree : 0);
  const ramUsedPercent = percent(ramUsed, ramTotal);
  const imu = recordValue(status.imu ?? runtime.imu ?? (lastResultCommand === "set_imu" ? lastResult.imu : undefined));
  const calibrationStatus = recordValue(status.calibration);
  const lastKnownIndicatorsRef = useRef<Record<string, unknown>>({});
  const lastKnownIndicatorsDeviceUidRef = useRef(deviceUid);
  if (lastKnownIndicatorsDeviceUidRef.current !== deviceUid) {
    lastKnownIndicatorsDeviceUidRef.current = deviceUid;
    lastKnownIndicatorsRef.current = {};
  }
  const indicatorSources = [
    status.indicators,
    runtime.indicators,
    lastResultCommand === "status" || lastResultCommand === "set_indicators" ? lastResult.indicators : undefined,
  ];
  const nextIndicators = indicatorSources.map((value) => recordValue(value)).find((value) => hasIndicatorData(value)) ?? {};
  if (hasIndicatorData(nextIndicators)) {
    lastKnownIndicatorsRef.current = nextIndicators;
  }
  const indicators = recordValue(hasIndicatorData(nextIndicators) ? nextIndicators : lastKnownIndicatorsRef.current);
  const externalLed = recordValue(indicators.external_led);
  const oled = recordValue(indicators.oled);
  const updateState = recordValue(status.update_state ?? device?.update_state ?? (lastResultCommand === "check_update" ? lastResult.update_state : undefined));
  const updateChangelogUrl = stringValue(updateState.changelog_url ?? (lastResultCommand === "check_update" ? lastResult.changelog_url : undefined), "");

  const [activeSection, setActiveSection] = useState<SettingsSection>("about");
  const [manifestUrl, setManifestUrl] = useState(DEFAULT_MANIFEST_URL);
  const [autoOtaOnBoot, setAutoOtaOnBoot] = useState(otaConfig.auto_apply_on_boot === true);
  const [updateChangelogVisible, setUpdateChangelogVisible] = useState(false);
  const [updateChangelogBody, setUpdateChangelogBody] = useState("");
  const [updateChangelogLoading, setUpdateChangelogLoading] = useState(false);
  const [updateChangelogError, setUpdateChangelogError] = useState("");
  const [analogPins, setAnalogPins] = useState("");
  const [selectPins, setSelectPins] = useState("");
  const [pinDraftDirty, setPinDraftDirty] = useState(false);
  const [pendingScanTimingApply, setPendingScanTimingApply] = useState<Record<string, number> | null>(null);
  const authoritativeScanTiming = recordValue(pendingScanTimingApply ?? lastAppliedScanTiming ?? scanTiming);
  const [targetFps, setTargetFps] = useState(numberValue(authoritativeScanTiming.target_fps ?? scanHealth.requested_target_fps, 60));
  const [settleUs, setSettleUs] = useState(numberValue(authoritativeScanTiming.settle_us ?? scanHealth.settle_us, 20));
  const [sendEveryNFrames, setSendEveryNFrames] = useState(numberValue(authoritativeScanTiming.send_every_n_frames ?? scanHealth.send_every_n_frames, 1));
  const [scanDraftDirty, setScanDraftDirty] = useState(false);
  const [streamBufferEnabled, setStreamBufferEnabled] = useState(streamBuffer.enabled !== false);
  const [streamBufferMode, setStreamBufferMode] = useState(stringValue(streamBuffer.mode, "standard"));
  const [chargeProfile, setChargeProfile] = useState(stringValue(batteryStatus.profile, "compatible"));
  const [imuEnabled, setImuEnabled] = useState(imu.enabled !== false);
  const [logEnabled, setLogEnabled] = useState(logging.enabled !== false);
  const [logLevel, setLogLevel] = useState(stringValue(logging.level, "info"));
  const [logMode, setLogMode] = useState(stringValue(logging.mode, "standard"));
  const [externalLedMode, setExternalLedMode] = useState(stringValue(externalLed.mode, "off"));
  const [brightness, setBrightness] = useState(externalLedBrightnessValue(externalLed.brightness));
  const [externalPreset, setExternalPreset] = useState(stringValue(externalLed.preset, "stream_health"));
  const [oledMode, setOledMode] = useState(stringValue(oled.mode, "off"));
  const [oledPage, setOledPage] = useState(stringValue(oled.page, "live_status"));
  const [oledUpdateHz, setOledUpdateHz] = useState(numberValue(oled.update_hz, 1));
  const [oledContrast, setOledContrast] = useState(numberValue(oled.contrast, 128));
  const [showIoModal, setShowIoModal] = useState(false);
  const [ramMonitorEnabled, setRamMonitorEnabled] = useState(false);
  const [ramRefreshInFlight, setRamRefreshInFlight] = useState(false);
  const [ramLastUpdated, setRamLastUpdated] = useState("");
  const ramRefreshInFlightRef = useRef(false);
  const [operationToast, setOperationToast] = useState<OperationLogEntry | null>(null);
  const [operationLog, setOperationLog] = useState<OperationLogEntry[]>([]);
  const [busyCommand, setBusyCommand] = useState("");
  const toastTimerRef = useRef(0);
  const operationLogIdRef = useRef(1);
  const pinStatusAutoRequestedRef = useRef<Record<string, boolean>>({});
  const lastIndicatorsStatusAutoRefreshKeyRef = useRef("");
  const indicatorsStatusAutoRefreshPendingRef = useRef(false);
  const statusDrivenSectionAutoRefreshKeyRef = useRef("");
  const lastAttachedFindmeRef = useRef<Record<string, unknown>>({});
  const findmeState = stringValue(rawFindme.state, "");
  if (findmeState === "attached") {
    lastAttachedFindmeRef.current = rawFindme;
  }
  const findme = recordValue(busyCommand && stringValue(lastAttachedFindmeRef.current.state, "") === "attached" ? lastAttachedFindmeRef.current : rawFindme);

  const sections: { id: SettingsSection; label: string }[] = [
    { id: "about", label: t("settingsSection_about") },
    { id: "gateway", label: t("gatewayTitle") },
    { id: "update", label: t("settingsSection_update") },
    { id: "pins", label: t("settingsSection_pins") },
    { id: "maintenance", label: t("settingsSection_maintenance") },
    { id: "indicators", label: t("settingsSection_indicators") },
    { id: "diagnostics", label: t("settingsSection_diagnostics") },
    { id: "flash", label: t("deviceFlash") },
  ];

  useEffect(() => {
    if (pinDraftDirty) return;
    setAnalogPins(analogPinsFromStatus);
    setSelectPins(selectPinsFromStatus);
  }, [analogPinsFromStatus, pinDraftDirty, selectPinsFromStatus]);

  useEffect(() => {
    if (scanDraftDirty || pendingScanTimingApply) return;
    const nextTargetFps = numberValue(authoritativeScanTiming.target_fps ?? scanHealth.requested_target_fps, Number.NaN);
    const nextSettleUs = numberValue(authoritativeScanTiming.settle_us ?? scanHealth.settle_us, Number.NaN);
    const nextSendEveryNFrames = numberValue(authoritativeScanTiming.send_every_n_frames ?? scanHealth.send_every_n_frames, Number.NaN);
    if (Number.isFinite(nextTargetFps)) setTargetFps(nextTargetFps);
    if (Number.isFinite(nextSettleUs)) setSettleUs(nextSettleUs);
    if (Number.isFinite(nextSendEveryNFrames)) setSendEveryNFrames(nextSendEveryNFrames);
  }, [
    authoritativeScanTiming.send_every_n_frames,
    authoritativeScanTiming.settle_us,
    authoritativeScanTiming.target_fps,
    pendingScanTimingApply,
    scanDraftDirty,
    scanHealth.requested_target_fps,
    scanHealth.send_every_n_frames,
    scanHealth.settle_us,
  ]);

  useEffect(() => {
    if (!pendingScanTimingApply) return;
    const confirmedTargetFps = numberValue(confirmedScanTiming.target_fps, Number.NaN);
    const confirmedSettleUs = numberValue(confirmedScanTiming.settle_us, Number.NaN);
    const confirmedSendEveryNFrames = numberValue(confirmedScanTiming.send_every_n_frames, Number.NaN);
    if (
      confirmedTargetFps === pendingScanTimingApply.target_fps &&
      confirmedSettleUs === pendingScanTimingApply.settle_us &&
      confirmedSendEveryNFrames === pendingScanTimingApply.send_every_n_frames
    ) {
      setPendingScanTimingApply(null);
      setScanDraftDirty(false);
    }
  }, [confirmedScanTiming.send_every_n_frames, confirmedScanTiming.settle_us, confirmedScanTiming.target_fps, pendingScanTimingApply]);

  useEffect(() => {
    if (imu.enabled !== undefined) {
      setImuEnabled(imu.enabled !== false);
    }
  }, [imu.enabled]);

  useEffect(() => {
    if (streamBuffer.enabled !== undefined) {
      setStreamBufferEnabled(streamBuffer.enabled !== false);
    }
    const nextMode = stringValue(streamBuffer.mode, "");
    if (nextMode) {
      setStreamBufferMode(nextMode);
    }
  }, [streamBuffer.enabled, streamBuffer.mode]);

  useEffect(() => {
    if (otaConfig.auto_apply_on_boot !== undefined) {
      setAutoOtaOnBoot(otaConfig.auto_apply_on_boot === true);
    }
    const nextManifestUrl = stringValue(otaConfig.manifest_url, "");
    if (nextManifestUrl) {
      setManifestUrl(nextManifestUrl);
    }
  }, [otaConfig.auto_apply_on_boot, otaConfig.manifest_url]);

  useEffect(() => {
    setUpdateChangelogVisible(false);
    setUpdateChangelogBody("");
    setUpdateChangelogLoading(false);
    setUpdateChangelogError("");
  }, [updateChangelogUrl]);

  useEffect(() => {
    if (logging.enabled !== undefined) setLogEnabled(logging.enabled !== false);
    const nextLogLevel = stringValue(logging.level, "");
    if (nextLogLevel) setLogLevel(nextLogLevel);
    const nextLogMode = stringValue(logging.mode, "");
    if (nextLogMode) setLogMode(nextLogMode);
  }, [logging.enabled, logging.level, logging.mode]);

  useEffect(() => {
    const nextProfile = stringValue(batteryStatus.profile, "");
    if (nextProfile) {
      setChargeProfile(nextProfile);
    }
  }, [batteryStatus.profile]);

  useEffect(() => {
    const nextExternalMode = stringValue(externalLed.mode, "");
    if (nextExternalMode) setExternalLedMode(nextExternalMode);
    const nextPreset = stringValue(externalLed.preset, "");
    if (nextPreset) setExternalPreset(nextPreset);
    if (externalLed.brightness !== undefined) setBrightness(externalLedBrightnessValue(externalLed.brightness));
  }, [externalLed.brightness, externalLed.mode, externalLed.preset]);

  useEffect(() => {
    const nextOledMode = stringValue(oled.mode, "");
    if (nextOledMode) setOledMode(nextOledMode);
    const nextOledPage = stringValue(oled.page, "");
    if (nextOledPage) setOledPage(nextOledPage);
    if (oled.update_hz !== undefined) setOledUpdateHz(numberValue(oled.update_hz, 1));
    if (oled.contrast !== undefined) setOledContrast(numberValue(oled.contrast, 128));
  }, [oled.contrast, oled.mode, oled.page, oled.update_hz]);

  function isCommandBusy(command: string) {
    return busyCommand === command;
  }

  function pushOperationLog(entry: OperationLogEntry) {
    setOperationLog((current) => [entry, ...current].slice(0, 24));
    setOperationToast(entry);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setOperationToast(null);
      toastTimerRef.current = 0;
    }, 3200);
  }

  function dismissOperationToast() {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = 0;
    }
    setOperationToast(null);
  }

  async function run(label: string, payload: Record<string, unknown>, timeoutMs = 20000) {
    const command = String(payload.command ?? "");
    if (isDeviceOffline && isLiveQueryCommand(command)) {
      return { queued: null, result: null };
    }
    setBusyCommand(command);
    try {
      const response = await queue(payload, timeoutMs);
      const ok = response.result?.status !== "error" && response.result?.ok !== false;
      const resultMessage = response.result?.message ?? response.result?.status ?? t("terminalNoResponse");
      pushOperationLog({
        id: operationLogIdRef.current++,
        label,
        command,
        message: pretty(resultMessage),
        ok,
        time: new Date().toLocaleTimeString(),
      });
      await refresh();
      return response;
    } catch (error) {
      pushOperationLog({
        id: operationLogIdRef.current++,
        label,
        command,
        message: error instanceof Error ? error.message : pretty(error),
        ok: false,
        time: new Date().toLocaleTimeString(),
      });
      throw error;
    } finally {
      setBusyCommand("");
    }
  }

  async function refreshRamStatus() {
    if (!deviceUid || isDeviceOffline || ramRefreshInFlightRef.current) return;
    ramRefreshInFlightRef.current = true;
    setRamRefreshInFlight(true);
    try {
      await run(t("ramRefresh"), { command: "memory_status" }, 10000);
      setRamLastUpdated(new Date().toLocaleTimeString());
    } catch (error) {
      void error;
    } finally {
      ramRefreshInFlightRef.current = false;
      setRamRefreshInFlight(false);
    }
  }

  useEffect(() => {
    if (!ramMonitorEnabled || !deviceUid || isDeviceOffline) return undefined;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refreshRamStatus();
    };
    tick();
    const intervalId = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [deviceUid, isDeviceOffline, ramMonitorEnabled]);

  useEffect(() => () => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!deviceUid || !shouldAutoRefreshStatusForSection(activeSection) || isDeviceOffline) {
      statusDrivenSectionAutoRefreshKeyRef.current = "";
      return;
    }
    const refreshKey = `${deviceUid}:${activeSection}`;
    if (statusDrivenSectionAutoRefreshKeyRef.current === refreshKey || busyCommand) return;
    statusDrivenSectionAutoRefreshKeyRef.current = refreshKey;
    void run(t("refreshStatus"), { command: "status" }, 10000).catch(() => undefined);
  }, [activeSection, busyCommand, deviceUid, isDeviceOffline, t]);

  useEffect(() => {
    if (activeSection !== "pins" || !deviceUid || busyCommand || isDeviceOffline) return;
    if (analogPinsFromStatus && selectPinsFromStatus) return;
    if (pinStatusAutoRequestedRef.current[deviceUid]) return;
    pinStatusAutoRequestedRef.current[deviceUid] = true;
    void run(t("refreshStatus"), { command: "status" }, 10000).catch(() => undefined);
  }, [activeSection, analogPinsFromStatus, busyCommand, deviceUid, isDeviceOffline, selectPinsFromStatus, t]);

  function runIndicatorsStatusRefresh() {
    if (!deviceUid || isDeviceOffline) return;
    lastIndicatorsStatusAutoRefreshKeyRef.current = `${deviceUid}:indicators`;
    indicatorsStatusAutoRefreshPendingRef.current = false;
    void run(t("refreshStatus"), { command: "status" }, 10000).catch(() => undefined);
  }

  useEffect(() => {
    if (activeSection !== "indicators" || !deviceUid || isDeviceOffline) {
      lastIndicatorsStatusAutoRefreshKeyRef.current = "";
      indicatorsStatusAutoRefreshPendingRef.current = false;
      return;
    }
    const refreshKey = `${deviceUid}:indicators`;
    if (lastIndicatorsStatusAutoRefreshKeyRef.current === refreshKey) return;
    if (busyCommand) {
      indicatorsStatusAutoRefreshPendingRef.current = true;
      return;
    }
    runIndicatorsStatusRefresh();
  }, [activeSection, busyCommand, deviceUid, isDeviceOffline]);

  function applyScanPreset(fps: number) {
    setScanDraftDirty(true);
    setTargetFps(fps);
    setSettleUs(fps > 60 ? 15 : 20);
    setSendEveryNFrames(1);
  }

  async function applyIoPins(nextAnalogPins: number[], nextSelectPins: number[]) {
    setPinDraftDirty(true);
    setAnalogPins(nextAnalogPins.join(","));
    setSelectPins(nextSelectPins.join(","));
    await run(t("applyPinLayout"), {
      command: "set_matrix_layout",
      analog_pins: nextAnalogPins,
      select_pins: nextSelectPins,
    });
    setPinDraftDirty(false);
  }

  async function applyPinLayout() {
    await run(t("applyPinLayout"), { command: "set_matrix_layout", analog_pins: numberCsv(analogPins), select_pins: numberCsv(selectPins) });
    setPinDraftDirty(false);
  }

  async function applyScanTiming() {
    const nextTiming = { target_fps: targetFps, settle_us: settleUs, send_every_n_frames: sendEveryNFrames };
    setPendingScanTimingApply(nextTiming);
    try {
      await run(t("applyScanTiming"), { command: "set_scan_timing", ...nextTiming });
    } catch (error) {
      setPendingScanTimingApply(null);
      throw error;
    }
  }

  async function applyChargeProfile() {
    await run(t("saveChargeProfile"), { command: "set_charge_profile", profile: chargeProfile });
  }

  async function applyStreamBuffer() {
    await run(t("saveStreamBuffer"), {
      command: "set_stream_buffer",
      enabled: streamBufferEnabled,
      mode: streamBufferMode,
    });
  }

  async function applyPowerState(state: "normal" | "soft_off_auto") {
    await run(t("savePowerState"), { command: "power_set_state", state });
  }

  async function loadUpdateChangelog() {
    if (!updateChangelogUrl) {
      setUpdateChangelogVisible(true);
      setUpdateChangelogError(t("changelogUnavailable"));
      return;
    }
    setUpdateChangelogVisible(true);
    setUpdateChangelogLoading(true);
    setUpdateChangelogError("");
    try {
      const response = await fetch(updateChangelogUrl);
      if (!response.ok) {
        throw new Error(`http_${response.status}`);
      }
      const text = (await response.text()).trim();
      setUpdateChangelogBody(text);
      if (!text) {
        setUpdateChangelogError(t("changelogUnavailable"));
      }
    } catch (error) {
      setUpdateChangelogBody("");
      setUpdateChangelogError(error instanceof Error ? error.message : t("changelogUnavailable"));
    } finally {
      setUpdateChangelogLoading(false);
    }
  }

  async function saveOtaConfig() {
    await run(t("saveUpdateSettings"), { command: "set_ota_config", auto_apply_on_boot: autoOtaOnBoot, manifest_url: manifestUrl });
  }

  async function saveLogSettings() {
    await run(t("saveLogSettings"), {
      command: "set_log",
      enabled: logEnabled,
      level: logLevel,
      mode: logMode,
      max_bytes: logMode === "extended" ? EXTENDED_LOG_BYTES : STANDARD_LOG_BYTES,
    });
  }

  function renderSection() {
    if (activeSection === "about") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_about")}</h3>
              <p>{normalized?.displayName ?? deviceUid}</p>
            </div>
            <div className="actions compact">
              <button className="button primary" type="button" disabled={isCommandBusy("status") || !deviceUid || isDeviceOffline} onClick={() => void run(t("refreshStatus"), { command: "status" })}>
                {isCommandBusy("status") ? t("running") : t("refreshStatus")}
              </button>
              <button className="button danger" type="button" disabled={isCommandBusy("reboot") || !deviceUid} onClick={() => void run("Reboot", { command: "reboot" })}>
                {isCommandBusy("reboot") ? t("running") : "Reboot"}
              </button>
            </div>
          </div>
          <div className="settings-detail-grid">
            <DetailBox label={t("deviceUid")} value={deviceUid} />
            <DetailBox label={t("deviceName")} value={normalized?.displayName ?? "-"} />
            <DetailBox label={t("mode")} value={normalized?.mode ?? "-"} />
            <DetailBox label={t("firmwareVersion")} value={normalized?.firmwareVersion ?? "-"} />
            <DetailBox label={t("protocol")} value={normalized?.protocol ?? "-"} />
            <DetailBox label={t("hardwareModel")} value={normalized?.hardwareModel ?? "-"} />
            <DetailBox label={t("matrixShape")} value={normalized?.matrixShape ?? "-"} />
            <DetailBox label={t("lastSeen")} value={normalized?.lastSeen ?? "-"} />
          </div>
        </div>
      );
    }

    if (activeSection === "gateway") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("gatewayTitle")}</h3>
              <p>{t("gatewayCopy")}</p>
            </div>
            <button className="button primary" type="button" disabled={isCommandBusy("findme_discover") || !deviceUid || isDeviceOffline} onClick={() => void run("FindMe", { command: "findme_discover" }, 15000)}>
              {isCommandBusy("findme_discover") ? t("running") : t("rediscoverGateway")}
            </button>
          </div>
          <div className="settings-detail-grid">
            <DetailBox label={t("gatewaySource")} value={findme.state ?? "-"} />
            <DetailBox label={t("gatewayId")} value={findme.gateway_id ?? "-"} />
            <DetailBox label={t("gatewayHost")} value={findme.host ?? "-"} />
            <DetailBox label={t("gatewayUdpPort")} value={findme.udp_port ?? "-"} />
            <DetailBox label={t("transport")} value={device?.transport_path ?? status.transport_path ?? "-"} />
            <DetailBox label={t("heartbeat")} value={findme.last_heartbeat_at ?? device?.last_heartbeat_at ?? status.last_heartbeat_at ?? "-"} />
            <DetailBox label={t("heartbeatInterval")} value={findme.heartbeat_interval_ms ?? "-"} />
            <DetailBox label={t("gatewayLastSuccess")} value={findme.last_success_ms ?? "-"} />
            <DetailBox label={t("gatewayLastError")} value={findme.last_error ?? "-"} />
          </div>
        </div>
      );
    }

    if (activeSection === "update") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_update")}</h3>
              <p>Arduino whole-firmware OTA manifest.</p>
            </div>
            <div className="actions compact">
              <button className="button" type="button" disabled={isCommandBusy("check_update") || !deviceUid} onClick={() => void run("Check update", { command: "check_update", manifest_url: manifestUrl }, 30000)}>
                {isCommandBusy("check_update") ? t("running") : "Check"}
              </button>
              <button className="button primary" type="button" disabled={isCommandBusy("apply_update") || !deviceUid} onClick={() => void run("Apply update", { command: "apply_update", manifest_url: manifestUrl }, 90000)}>
                {isCommandBusy("apply_update") ? t("running") : "Apply"}
              </button>
            </div>
          </div>
          <div className="field">
            <label>Manifest URL</label>
            <input value={manifestUrl} onChange={(event) => setManifestUrl(event.target.value)} />
          </div>
          <div className="control-row">
            <label className="switch-row">
              <input type="checkbox" checked={autoOtaOnBoot} onChange={(event) => setAutoOtaOnBoot(event.target.checked)} />
              <span>{t("autoOtaOnBoot")}</span>
            </label>
            <button className="button" type="button" disabled={isCommandBusy("set_ota_config") || !deviceUid} onClick={() => void saveOtaConfig()}>
              {isCommandBusy("set_ota_config") ? t("running") : t("saveUpdateSettings")}
            </button>
          </div>
          <div className="settings-detail-grid compact">
            <DetailBox label="Phase" value={updateState.phase ?? "-"} />
            <DetailBox label="Version" value={updateState.version ?? "-"} />
            <DetailBox label="URL" value={updateState.url ?? "-"} />
            <DetailBox label="Error" value={updateState.last_error ?? updateState.error ?? "-"} />
          </div>
          <div className="actions compact">
            <button
              className="button"
              type="button"
              disabled={!updateChangelogUrl || updateChangelogLoading}
              onClick={() => {
                if (updateChangelogVisible) {
                  setUpdateChangelogVisible(false);
                  return;
                }
                void loadUpdateChangelog();
              }}
            >
              {updateChangelogVisible ? t("hideChangelog") : (updateChangelogLoading ? t("loading") : t("viewChangelog"))}
            </button>
          </div>
          {updateChangelogVisible ? (
            <div className="changelog-panel">
              {updateChangelogLoading ? <p className="service-muted">{t("loading")}</p> : null}
              {updateChangelogError ? <p className="service-muted">{updateChangelogError || t("changelogUnavailable")}</p> : null}
              {updateChangelogBody ? <pre>{updateChangelogBody}</pre> : null}
              {!updateChangelogLoading && !updateChangelogBody && !updateChangelogError ? <p className="service-muted">{t("changelogUnavailable")}</p> : null}
            </div>
          ) : null}
        </div>
      );
    }

    if (activeSection === "pins") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_pins")}</h3>
              <p>{t("matrixShape")}: {normalized?.matrixShape ?? "-"}</p>
            </div>
            <button className="button" type="button" onClick={() => setShowIoModal(true)}>
              {t("ioConfigOpen")}
            </button>
          </div>
          <div className="field-grid">
            <div className="field">
              <label>{t("analogPins")}</label>
              <input value={analogPins} onChange={(event) => { setPinDraftDirty(true); setAnalogPins(event.target.value); }} />
            </div>
            <div className="field">
              <label>{t("selectPins")}</label>
              <input value={selectPins} onChange={(event) => { setPinDraftDirty(true); setSelectPins(event.target.value); }} />
            </div>
          </div>
          <div className="actions">
            <button className="button primary" type="button" disabled={isCommandBusy("set_matrix_layout") || !deviceUid} onClick={() => void applyPinLayout()}>
              {isCommandBusy("set_matrix_layout") ? t("running") : t("applyPinLayout")}
            </button>
          </div>
          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h3>{t("scanPerformance")}</h3>
                <p>{t("scanPerformanceCopy")}</p>
              </div>
              <button className="button" type="button" disabled={isCommandBusy("scan_health") || !deviceUid || isDeviceOffline} onClick={() => void run("Scan health", { command: "scan_health" })}>
                {isCommandBusy("scan_health") ? t("running") : "Health"}
              </button>
            </div>
            <div className="scan-timing-row">
              <div className="segmented-control">
                <button className={targetFps === 60 ? "active" : ""} type="button" onClick={() => applyScanPreset(60)}>
                  {t("standardFps")}
                </button>
                <button className={targetFps === 90 ? "active" : ""} type="button" onClick={() => applyScanPreset(90)}>
                  {t("extendedFps")}
                </button>
              </div>
              <div className="field-grid">
                <div className="field">
                  <label>{t("targetFps")}</label>
                  <input type="number" value={targetFps} onChange={(event) => { setScanDraftDirty(true); setTargetFps(Number(event.target.value) || 60); }} />
                </div>
                <div className="field">
                  <label>{t("settleUs")}</label>
                  <input type="number" value={settleUs} onChange={(event) => { setScanDraftDirty(true); setSettleUs(Number(event.target.value) || 20); }} />
                </div>
                <div className="field">
                  <label>{t("sendEveryNFrames")}</label>
                  <input type="number" value={sendEveryNFrames} onChange={(event) => { setScanDraftDirty(true); setSendEveryNFrames(Number(event.target.value) || 1); }} />
                </div>
                <div className="field settings-field-action">
                  <label>{t("currentScanTiming")}</label>
                  <button className="button primary" type="button" disabled={isCommandBusy("set_scan_timing") || !deviceUid} onClick={() => void applyScanTiming()}>
                    {isCommandBusy("set_scan_timing") ? t("running") : t("applyScanTiming")}
                  </button>
                </div>
              </div>
            </div>
            <div className="settings-detail-grid compact">
              <DetailBox label={t("targetFps")} value={authoritativeScanTiming.target_fps ?? scanHealth.requested_target_fps ?? "-"} />
              <DetailBox label={t("settleUs")} value={authoritativeScanTiming.settle_us ?? scanHealth.settle_us ?? "-"} />
              <DetailBox label={t("sendEveryNFrames")} value={authoritativeScanTiming.send_every_n_frames ?? scanHealth.send_every_n_frames ?? "-"} />
              <DetailBox label="Produced" value={scanHealth.produced_frames ?? "-"} />
            </div>
          </div>
        </div>
      );
    }

    if (activeSection === "maintenance") {
      return (
        <CalibrationWorkbench
          t={t}
          deviceUid={deviceUid}
          isDeviceOffline={isDeviceOffline}
          matrixShape={recordValue(status.matrix_shape)}
          calibrationStatus={calibrationStatus}
          busyCommand={busyCommand}
          maintenanceMode={normalized?.mode === "maintenance" || normalized?.mode === "safe_maintenance"}
          run={run}
        />
      );
    }

    if (activeSection === "indicators") {
      return (
        <div className="settings-stack">
          <div className="settings-card">
            <h4>{t("externalLedIndicators")}</h4>
            <p>{t("externalLedIndicatorsCopy")}</p>
            <div className="field-grid">
              <div className="field">
                <label>{t("externalLedMode")}</label>
                <select value={externalLedMode} onChange={(event) => setExternalLedMode(event.target.value)}>
                  <option value="off">{t("indicatorMode_off")}</option>
                  <option value="enabled">{t("indicatorMode_enabled")}</option>
                </select>
              </div>
              <div className="field">
                <label>{t("externalLedPreset")}</label>
                <select value={externalPreset} onChange={(event) => setExternalPreset(event.target.value)}>
                  <option value="stream_health">{t("indicatorPreset_stream_health")}</option>
                  <option value="pressure_activity">{t("indicatorPreset_pressure_activity")}</option>
                  <option value="recording_focus">{t("indicatorPreset_recording_focus")}</option>
                  <option value="calibration_focus">{t("indicatorPreset_calibration_focus")}</option>
                  <option value="identify">{t("indicatorPreset_identify")}</option>
                </select>
              </div>
              <div className="field">
                <label>{t("paramBrightness")}</label>
                <select value={String(brightness)} onChange={(event) => setBrightness(Number(event.target.value) || DEFAULT_EXTERNAL_LED_BRIGHTNESS)}>
                  {EXTERNAL_LED_BRIGHTNESS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="metric-row">
              <Metric label={t("externalLedPin")} value={externalLed.pin ?? "-"} />
              <Metric label={t("externalLedCount")} value={externalLed.count ?? "-"} />
              <Metric label={t("externalLedInitialized")} value={boolString(externalLed.initialized)} />
              <Metric label={t("activePreset")} value={externalLed.active_preset ?? "-"} />
              <Metric label={t("externalLedLastShow")} value={externalLed.last_show_ms ?? "-"} />
              <Metric label={t("externalLedLastError")} value={externalLed.last_error ?? "-"} />
            </div>
            <div className="actions">
              <button className="button primary" type="button" disabled={isCommandBusy("set_indicators") || !deviceUid} onClick={() => void run(t("saveExternalLed"), { command: "set_indicators", external_led: { mode: externalLedMode, preset: externalPreset, brightness } })}>
                {isCommandBusy("set_indicators") ? t("running") : t("saveExternalLed")}
              </button>
              <button className="button" type="button" disabled={isCommandBusy("set_indicators") || !deviceUid} onClick={() => void run(t("testExternalLed"), { command: "set_indicators", external_led: { mode: "enabled", preset: "identify", brightness } })}>
                {isCommandBusy("set_indicators") ? t("running") : t("testExternalLed")}
              </button>
            </div>
          </div>
          <div className="settings-card">
            <h4>{t("ssd1306Display")}</h4>
            <p>{oled.detected ? t("screenDetected") : t("noSsd1306Detected")}</p>
            <div className="metric-row">
              <Metric label={t("detected")} value={boolString(oled.detected)} />
              <Metric label={t("oledAddress")} value={oled.addr ?? "-"} />
              <Metric label={t("oledLastError")} value={oled.last_error ?? "-"} />
            </div>
            <div className="field-grid">
              <div className="field">
                <label>{t("paramOledMode")}</label>
                <select value={oledMode} onChange={(event) => setOledMode(event.target.value)}>
                  <option value="off">{t("indicatorMode_off")}</option>
                  <option value="auto">{t("indicatorMode_auto")}</option>
                  <option value="enabled">{t("indicatorMode_enabled")}</option>
                </select>
              </div>
              <div className="field">
                <label>{t("oledPage")}</label>
                <select value={oledPage} onChange={(event) => setOledPage(event.target.value)}>
                  <option value="live_status">{t("oledPage_live_status")}</option>
                  <option value="sensor_snapshot">{t("oledPage_sensor_snapshot")}</option>
                  <option value="recording_status">{t("oledPage_recording_status")}</option>
                </select>
              </div>
              <div className="field">
                <label>{t("oledUpdateHz")}</label>
                <input type="number" value={oledUpdateHz} onChange={(event) => setOledUpdateHz(Number(event.target.value) || 1)} />
              </div>
              <div className="field">
                <label>{t("oledContrast")}</label>
                <input type="number" value={oledContrast} onChange={(event) => setOledContrast(Number(event.target.value) || 128)} />
              </div>
            </div>
            <div className="actions">
              <button className="button" type="button" disabled={isCommandBusy("set_indicators") || !deviceUid} onClick={() => void run(t("saveScreen"), { command: "set_indicators", oled: { mode: oledMode, page: oledPage, update_hz: oledUpdateHz, contrast: oledContrast } })}>
                {isCommandBusy("set_indicators") ? t("running") : t("saveScreen")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (activeSection === "diagnostics") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_diagnostics")}</h3>
              <p>{t("diagnosticsNotesCopy")}</p>
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("streamDiagnostics")}</h4>
                <p>{t("streamDiagnosticsCopy")}</p>
              </div>
              <button className="button" type="button" disabled={isCommandBusy("scan_health") || !deviceUid || isDeviceOffline} onClick={() => void run("Scan health", { command: "scan_health" })}>
                {isCommandBusy("scan_health") ? t("running") : "Health"}
              </button>
            </div>
            <div className="metric-row">
              <Metric label={t("actualScanFps")} value={scanHealth.actual_scan_fps ?? "-"} />
              <Metric label={t("scanBudgetUs")} value={scanHealth.budget_us ?? "-"} />
              <Metric label={t("overrunFrames")} value={scanHealth.overrun_frames ?? "-"} />
              <Metric label={t("udpSentFrames")} value={scanHealth.udp_sent_frames ?? "-"} />
              <Metric label={t("udpSendFailures")} value={scanHealth.udp_send_failures ?? "-"} />
              <Metric label={t("lastUdpSendUs")} value={scanHealth.last_udp_send_us ?? "-"} />
              <Metric label={t("streamBufferQueueCapacity")} value={scanHealth.queue_capacity_frames ?? "-"} />
              <Metric label={t("streamBufferQueueDropped")} value={scanHealth.queue_dropped_frames ?? "-"} />
              <Metric label={t("streamBufferQueueMax")} value={scanHealth.queue_max_occupied_frames ?? "-"} />
              <Metric label="Wi-Fi" value={boolString(wifi.connected)} />
              <Metric label="IP" value={wifi.ip ?? "-"} small />
              <Metric label="RSSI" value={wifi.rssi ?? "-"} />
            </div>
            <div className="settings-card-subsection">
              <h5>{t("streamBufferDiagnostics")}</h5>
              <div className="field-grid">
                <label className="switch-row">
                  <input type="checkbox" checked={streamBufferEnabled} onChange={(event) => setStreamBufferEnabled(event.target.checked)} />
                  <span>{t("paramEnabled")}</span>
                </label>
                <div className="field">
                  <label>{t("streamBufferMode")}</label>
                  <select value={streamBufferMode} disabled={!streamBufferEnabled} onChange={(event) => setStreamBufferMode(event.target.value)}>
                    <option value="standard">{t("streamBufferStandardMode")}</option>
                    <option value="extended">{t("streamBufferExtendedMode")}</option>
                  </select>
                </div>
              </div>
              <div className="metric-row">
                <Metric label={t("streamBufferMode")} value={streamBuffer.mode ?? "-"} />
                <Metric label={t("streamBufferDepth")} value={streamBuffer.depth_frames ?? "-"} />
                <Metric label={t("streamBufferQueueOccupied")} value={scanHealth.queue_occupied_frames ?? "-"} />
              </div>
              <div className="actions compact">
                <button className="button" type="button" disabled={isCommandBusy("set_stream_buffer") || !deviceUid || isDeviceOffline} onClick={() => void applyStreamBuffer()}>
                  {isCommandBusy("set_stream_buffer") ? t("running") : t("saveStreamBuffer")}
                </button>
              </div>
            </div>
          </div>
          <div className="settings-card">
            <h4>{t("imuDiagnostics")}</h4>
            <div className="metric-row">
              <Metric label={t("imuState")} value={imu.state ?? (imu.enabled === false ? "disabled" : "-")} />
              <Metric label={t("imuHeapDelta")} value={numberValue(imu.heap_after, 0) - numberValue(imu.heap_before, 0)} />
              <Metric label={t("imuSampleRateHz")} value={imu.sample_rate_hz ?? "-"} />
              <Metric label={t("imuCacheAgeMs")} value={imu.cache_age_ms ?? "-"} />
              <Metric label={t("imuLastReadUs")} value={imu.last_read_duration_us ?? "-"} />
              <Metric label={t("imuLastError")} value={imu.last_error ?? "-"} small />
            </div>
            <div className="control-row">
              <label className="switch-row">
                <input type="checkbox" checked={imuEnabled} onChange={(event) => setImuEnabled(event.target.checked)} />
                <span>{t("paramEnabled")}</span>
              </label>
              <button className="button" type="button" disabled={isCommandBusy("set_imu") || !deviceUid} onClick={() => void run(t("saveImu"), { command: "set_imu", enabled: imuEnabled })}>
                {isCommandBusy("set_imu") ? t("running") : t("saveImu")}
              </button>
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("batteryStatus")}</h4>
                <p>{t("chargeProfileCopy")}</p>
              </div>
              <button className="button primary" type="button" disabled={isCommandBusy("set_charge_profile") || !deviceUid} onClick={() => void applyChargeProfile()}>
                {isCommandBusy("set_charge_profile") ? t("running") : t("saveChargeProfile")}
              </button>
            </div>
            <div className="field-grid">
              <div className="field">
                <label>{t("chargeProfile")}</label>
                <select value={chargeProfile} onChange={(event) => setChargeProfile(event.target.value)}>
                  <option value="compatible">{t("compatibleChargingMode")}</option>
                  <option value="fast">{t("fastChargingMode")}</option>
                </select>
              </div>
            </div>
            <div className="metric-row">
              <Metric label={t("battery")} value={batteryStatus.state ?? "-"} />
              <Metric label={t("chargeProfile")} value={batteryStatus.profile ?? "-"} />
              <Metric label={t("chargeCurrentMa")} value={batteryStatus.charge_current_ma ?? "-"} />
              <Metric label={t("inputLimitMa")} value={batteryStatus.input_limit_ma ?? "-"} />
              <Metric label={t("vbatRegMv")} value={batteryStatus.vbat_reg_mv ?? "-"} />
              <Metric label={t("terminationPercent")} value={batteryStatus.termination_percent ?? "-"} />
              <Metric label={t("prechargePercent")} value={batteryStatus.precharge_percent ?? "-"} />
              <Metric label={t("safetyTimerHours")} value={batteryStatus.safety_timer_hours ?? "-"} />
              <Metric label={t("configured")} value={boolString(batteryStatus.configured)} />
              <Metric label={t("chargerDetected")} value={boolString(batteryStatus.charger_detected ?? batteryStatus.detected)} />
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("powerStatus")}</h4>
                <p>{t("powerStatusCopy")}</p>
              </div>
              <div className="actions compact">
                <button className="button" type="button" disabled={isCommandBusy("power_set_state") || !deviceUid} onClick={() => void applyPowerState("normal")}>
                  {isCommandBusy("power_set_state") ? t("running") : t("resumeNormalMode")}
                </button>
                <button className="button primary" type="button" disabled={isCommandBusy("power_set_state") || !deviceUid} onClick={() => void applyPowerState("soft_off_auto")}>
                  {isCommandBusy("power_set_state") ? t("running") : t("softOffAuto")}
                </button>
              </div>
            </div>
            <div className="metric-row">
              <Metric label={t("powerState")} value={powerStatus.state ?? "-"} />
              <Metric label={t("wakeSource")} value={powerStatus.wake_source ?? "-"} />
              <Metric label={t("softOffReason")} value={powerStatus.soft_off_reason ?? "-"} small />
              <Metric label={t("chargerPresent")} value={boolString(powerStatus.charger_present)} />
              <Metric label={t("chargeState")} value={powerStatus.charge_state ?? batteryStatus.charge_state ?? "-"} />
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("ramDiagnostics")}</h4>
                <p>{t("ramDiagnosticsCopy")}</p>
              </div>
              <div className="actions compact">
                {ramMonitorEnabled ? (
                  <button className="button" type="button" onClick={() => setRamMonitorEnabled(false)}>
                    {t("closeRam")}
                  </button>
                ) : (
                  <button className="button primary" type="button" disabled={isCommandBusy("memory_status") || !deviceUid || isDeviceOffline} onClick={() => setRamMonitorEnabled(true)}>
                    {t("viewRam")}
                  </button>
                )}
              </div>
            </div>
            {ramMonitorEnabled ? (
              <>
                <div className="ram-bar-track" aria-label={t("ramDiagnostics")}>
                  <span className="ram-bar-used" style={{ width: `${ramUsedPercent}%` }} />
                </div>
                <div className="storage-summary">
                  <span>{t("used")}: {bytesLabel(ramUsed)}</span>
                  <span>{t("free")}: {bytesLabel(ramFree)}</span>
                  <span>{t("total")}: {ramTotal ? bytesLabel(ramTotal) : "-"}</span>
                </div>
                <div className="metric-row">
                  <Metric label="Heap free" value={memory.heap_free ?? "-"} />
                  <Metric label="Largest block" value={memory.heap_largest_free_block ?? "-"} />
                  <Metric label="Min free" value={memory.heap_min_free ?? "-"} />
                  <Metric label={t("ramRefreshState")} value={ramRefreshInFlight ? t("refreshing") : t("idle")} />
                  <Metric label={t("ramLastUpdated")} value={ramLastUpdated || "-"} />
                </div>
              </>
            ) : (
              <p className="service-muted">{t("ramMonitorClosedCopy")}</p>
            )}
          </div>
          <details className="terminal-json-details">
            <summary>Last response</summary>
            <pre>{pretty(lastResult)}</pre>
          </details>
        </div>
      );
    }

    if (activeSection === "flash") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("deviceFlash")}</h3>
              <p>{t("flashDiagnosticsCopy")}</p>
            </div>
            <div className="actions compact">
              <button className="button primary" type="button" disabled={isCommandBusy("storage_status") || !deviceUid || isDeviceOffline} onClick={() => void run(t("refreshFlashUsage"), { command: "storage_status" })}>
                {isCommandBusy("storage_status") ? t("running") : t("refreshFlashUsage")}
              </button>
              <a className="button" href={appHref(`device/${encodeURIComponent(deviceUid)}/files`)} target="_blank" rel="noreferrer">
                {t("fileBrowser")}
              </a>
            </div>
          </div>
          <div className="storage-card">
            <div className="storage-card-header">
              <span>{t("deviceStorage")}</span>
              <strong>{storageTotal ? `${bytesLabel(storageUsed)} / ${bytesLabel(storageTotal)}` : t("flashUnavailable")}</strong>
            </div>
            <div className="storage-bar-track" aria-label={t("deviceStorage")}>
              {storageUsage.length > 0 ? storageUsage.map((item) => (
                <span
                  key={item.scope}
                  className={`storage-segment ${item.scope}`}
                  style={{ width: `${percent(item.bytes, storageTotal)}%` }}
                />
              )) : null}
            </div>
            <div className="storage-summary">
              <span>{t("used")}: {bytesLabel(storageUsed)}</span>
              <span>{t("free")}: {bytesLabel(storage.free_bytes)}</span>
              <span>{t("total")}: {storageTotal ? bytesLabel(storageTotal) : "-"}</span>
            </div>
            <div className="storage-legend">
              {storageUsage.length === 0 ? <span>{t("flashUnavailable")}</span> : null}
              {storageUsage.map((item) => (
                <span key={item.scope}>
                  <i className={`storage-dot ${item.scope}`} />
                  {item.scope}: {bytesLabel(item.bytes)}
                </span>
              ))}
            </div>
          </div>
          <div className="settings-card">
            <h4>{t("logSettings")}</h4>
            <div className="field-grid">
              <label className="switch-row">
                <input type="checkbox" checked={logEnabled} onChange={(event) => setLogEnabled(event.target.checked)} />
                <span>{t("paramEnabled")}</span>
              </label>
              <div className="field">
                <label>{t("logLevel")}</label>
                <select value={logLevel} onChange={(event) => setLogLevel(event.target.value)}>
                  <option value="error">error</option>
                  <option value="warn">warn</option>
                  <option value="info">info</option>
                  <option value="debug">debug</option>
                </select>
              </div>
              <div className="field">
                <label>{t("logMode")}</label>
                <select value={logMode} onChange={(event) => setLogMode(event.target.value)}>
                  <option value="standard">{t("logModeStandard")}</option>
                  <option value="extended">{t("logModeExtended")}</option>
                </select>
              </div>
            </div>
            <div className="actions compact">
              <button className="button primary" type="button" disabled={isCommandBusy("set_log") || !deviceUid} onClick={() => void saveLogSettings()}>
                {isCommandBusy("set_log") ? t("running") : t("saveLogSettings")}
              </button>
              <button className="button" type="button" disabled={isCommandBusy("log_tail") || !deviceUid || isDeviceOffline} onClick={() => void run("Log tail", { command: "log_tail", max_lines: 50 })}>
                {isCommandBusy("log_tail") ? t("running") : "Logs"}
              </button>
              <button className="button danger" type="button" disabled={isCommandBusy("log_clear") || !deviceUid} onClick={() => void run("Log clear", { command: "log_clear" })}>
                {isCommandBusy("log_clear") ? t("running") : "Clear logs"}
              </button>
            </div>
            <div className="settings-detail-grid compact">
              <DetailBox label={t("paramEnabled")} value={boolString(logging.enabled)} />
              <DetailBox label={t("logLevel")} value={logging.level ?? "-"} />
              <DetailBox label={t("logMode")} value={logging.mode ?? "-"} />
              <DetailBox label="Max bytes" value={logging.max_bytes ?? "-"} />
            </div>
          </div>
        </div>
      );
    }

    return null;
  }

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("settingsApp")}</h2>
          <p className="page-copy">{deviceUid}</p>
        </div>
      </section>

      {errorMessage ? <p className="notice error">{errorMessage}</p> : null}

      <section className="settings-overview">
        <div className="settings-overview-card">
          <span>{t("mode")}</span>
          <strong>{normalized?.mode ?? "-"}</strong>
          <small>{t("protocol")}: {normalized?.protocol ?? "-"}</small>
        </div>
        <div className="settings-overview-card">
          <span>{t("firmwareVersion")}</span>
          <strong>{normalized?.firmwareVersion ?? "-"}</strong>
          <small>{t("hardwareModel")}: {normalized?.hardwareModel ?? "-"}</small>
        </div>
        <div className="settings-overview-card">
          <span>{t("gatewayTitle")}</span>
          <strong>{stringValue(findme.state)}</strong>
          <small>{stringValue(findme.gateway_id)} {stringValue(findme.host)}</small>
        </div>
        <div className="settings-overview-card">
          <span>{t("matrixShape")}</span>
          <strong>{normalized?.matrixShape ?? "-"}</strong>
          <small>{t("lastSeen")}: {normalized?.lastSeen ?? "-"}</small>
        </div>
      </section>

      <section className="settings-shell">
        <aside className="settings-sidebar" aria-label={t("settingsApp")}>
          {sections.map((section) => (
            <button
              key={section.id}
              className={activeSection === section.id ? "active" : ""}
              type="button"
              onClick={() => setActiveSection(section.id)}
            >
              <strong>{section.label}</strong>
            </button>
          ))}
        </aside>
        <article className="panel settings-detail">
          {renderSection()}
        </article>
      </section>

      {showIoModal ? (
        <BoardIoModal
          onClose={() => setShowIoModal(false)}
          initialAnalogPins={numberCsv(analogPins)}
          initialSelectPins={numberCsv(selectPins)}
          onApply={applyIoPins}
          applyDisabled={isCommandBusy("set_matrix_layout") || !deviceUid}
        />
      ) : null}

      {operationToast ? (
        <div className="operation-toast" data-state={operationToast.ok ? "success" : "error"} role="status">
          <div className="operation-toast-header">
            <strong>{operationToast.label}</strong>
            <button className="operation-toast-close" type="button" aria-label={t("closeToast")} onClick={dismissOperationToast}>
              x
            </button>
          </div>
          <span>{operationToast.message}</span>
        </div>
      ) : null}

      <details className="operation-log">
        <summary>{t("operationLog")}</summary>
        {operationLog.length > 0 ? (
          <div className="operation-log-list">
            {operationLog.map((entry) => (
              <div className="operation-log-item" data-state={entry.ok ? "success" : "error"} key={entry.id}>
                <span className="operation-log-time">{entry.time}</span>
                <strong>{entry.label}</strong>
                <code>{entry.command || "-"}</code>
                <span>{entry.message}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="service-muted">{t("operationLogEmpty")}</p>
        )}
      </details>
    </>
  );
}
