import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { api, type PressureCalReadings, type PressureCalServerPreset } from "../lib/api";

import { useI18n } from "../i18n";
import { boardProfileForHardwareModel, defaultManifestUrlForHardwareModel } from "../lib/boardProfile";
import { normalizeDevice, useDevicesPolling } from "../lib/device";
import { useDeviceCommand } from "../lib/deviceCommand";
import { appHref } from "../lib/runtime";
import { storageSnapshotFromDevice } from "../lib/storageStatus";
import { BoardIoModal } from "./TerminalPage";
import { ConfirmModal } from "../components/ConfirmModal";
import { TriangleAlert } from "lucide-react";

const STANDARD_LOG_BYTES = 12 * 1024;
const EXTENDED_LOG_BYTES = 24 * 1024;
const DEFAULT_EXTERNAL_LED_BRIGHTNESS = 0.35;
const EXTERNAL_LED_BRIGHTNESS_OPTIONS = [
  { value: 0.1, labelKey: "brightnessOption_10" },
  { value: 0.2, labelKey: "brightnessOption_20" },
  { value: 0.35, labelKey: "brightnessOption_35" },
  { value: 0.5, labelKey: "brightnessOption_50" },
  { value: 1, labelKey: "brightnessOption_100_danger" },
] as const;
const STATUS_DRIVEN_SECTIONS: SettingsSection[] = ["overview", "hardware", "runtime", "diagnostics", "files", "experimental"];

type SettingsSection =
  | "overview"
  | "hardware"
  | "runtime"
  | "maintenance"
  | "diagnostics"
  | "files"
  | "experimental";

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
    "calibration_dump_tare",
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

type CalibrationCaptureSummary = {
  captured_points: number;
  total_points: number;
  missing_points: number;
  complete: boolean;
  source: string;
};

type CalibrationSummary = CalibrationCaptureSummary & {
  level: number;
};

type CalibrationState = {
  enabled: boolean;
  mode_active: boolean;
  session_active: boolean;
  complete: boolean;
  tare_complete: boolean;
  levels_complete: boolean;
  legacy_missing_tare: boolean;
  tare: CalibrationCaptureSummary | null;
  draft_tare: CalibrationCaptureSummary | null;
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

type CalibrationTareLayer = {
  captured_points: number;
  total_points: number;
  complete: boolean;
  cells: CalibrationCell[];
} | null;

type CalibrationTarePreview = {
  total_points: number;
  saved: CalibrationTareLayer;
  draft: CalibrationTareLayer;
  session_active: boolean;
} | null;

// ---------------------------------------------------------------------------
// Pressure Calibration Panel
// ---------------------------------------------------------------------------

const PRESSURE_CAL_PRESETS: Record<string, number[]> = {
  quick:    [5, 20, 45],
  standard: [5, 10, 20, 35, 45],
  detailed: [5, 10, 20, 30, 40, 45],
  fine:     [5, 10, 15, 20, 25, 30, 38, 45],
};
const PRESSURE_MAX_KPA = 45;
// 無加壓狀態下氣壓本就約 3.5 kPa（tare/0 點基準）。低於此值的校準點不可達。
const PRESSURE_BASELINE_KPA = 3.5;
// 結束後的殘壓安全測試：嘗試穩定在此壓力，達標代表殘壓仍高、不可安全關閉氣壓控制。
const PRESSURE_RESIDUAL_TEST_KPA = 10;
const PRESSURE_RESIDUAL_TEST_TIMEOUT_MS = 15000;
const PRESSURE_STABLE_TOLERANCE_KPA = 0.5;
const PRESSURE_STABLE_CONFIRMATION_SAMPLES = 5;
const PRESSURE_STABLE_SAMPLE_INTERVAL_MS = 500;
const PRESSURE_STABLE_ADAPTIVE_DELAY_MS = 8000;
const PRESSURE_STABLE_ADAPTIVE_WINDOW_SAMPLES = 8;
const PRESSURE_STABLE_ADAPTIVE_RANGE_KPA = 0.25;
const PRESSURE_STABLE_ADAPTIVE_TARGET_SLACK_KPA = 1.0;
const PRESSURE_STABLE_MAX_WAIT_MS = 20000;
const PRESSURE_STABLE_TIMEOUT_RANGE_KPA = 0.4;
const PRESSURE_OVERSHOOT_ABORT_KPA = 2.0;
const PRESSURE_OVERSHOOT_ABORT_SAMPLES = 3;
const PRESSURE_POST_CAL_HOLD_KPA = PRESSURE_BASELINE_KPA;
const PRESSURE_POST_CAL_HOLD_SETTLE_MS = 3000;

type PressureCalPhase =
  | "idle" | "starting_session" | "holding_baseline" | "setting_pressure" | "stabilizing"
  | "capturing" | "stopping_pressure" | "committing" | "done" | "error" | "aborting"
  | "awaiting_compressor_off" | "testing_residual" | "residual_unsafe" | "safe_done";

type PressureStableResult = {
  referenceN: number | null;
  reason: "strict" | "adaptive_window" | "timeout_window" | "manual_confirm";
  settledKpa: number | null;
  elapsedMs: number;
};

function recentPressureWindow(values: number[]) {
  return values.slice(-PRESSURE_STABLE_ADAPTIVE_WINDOW_SAMPLES);
}

function pressureWindowRangeKpa(values: number[]) {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  return Math.max(...values) - Math.min(...values);
}

function pressureWindowAverageKpa(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hasStablePressureWindow(targetKpa: number, values: number[], rangeLimitKpa: number, targetSlackKpa: number) {
  const recent = recentPressureWindow(values);
  if (recent.length < PRESSURE_STABLE_ADAPTIVE_WINDOW_SAMPLES) return false;
  return pressureWindowRangeKpa(recent) <= rangeLimitKpa
    && Math.abs(pressureWindowAverageKpa(recent) - targetKpa) <= targetSlackKpa;
}

function PressureCalibrationPanel({ t, deviceUid }: { t: (key: string) => string; deviceUid: string }) {
  const [phase, setPhase] = useState<PressureCalPhase>("idle");
  const [pointIndex, setPointIndex] = useState(0);
  const [points, setPoints] = useState<number[]>(PRESSURE_CAL_PRESETS.standard);
  const [currentKpa, setCurrentKpa] = useState<number | null>(null);
  const [currentImadaValue, setCurrentImadaValue] = useState<number | null>(null);
  const [currentImadaUnit, setCurrentImadaUnit] = useState<string>("N");
  const [calLog, setCalLog] = useState<string[]>([]);
  const [calError, setCalError] = useState("");
  const [showCompressorOffBanner, setShowCompressorOffBanner] = useState(false);
  const [showCompressorOnModal, setShowCompressorOnModal] = useState(false);
  const [showCompressorOffModal, setShowCompressorOffModal] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [serverPresets, setServerPresets] = useState<PressureCalServerPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState("lab_pi");
  const [customUrl, setCustomUrl] = useState("");
  const [customToken, setCustomToken] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [presetKey, setPresetKey] = useState("standard");
  const [newPointInput, setNewPointInput] = useState("");
  const [activeTargetKpa, setActiveTargetKpa] = useState<number | null>(null);
  const abortRef = useRef(false);
  const stableCountRef = useRef(0);
  const overshootCountRef = useRef(0);
  const manualConfirmRef = useRef<PressureStableResult | null>(null);
  const addLogRef = useRef<((line: string) => void) | null>(null);
  const [safetyLatchedWarning, setSafetyLatchedWarning] = useState(false);

  const isRunning = phase !== "idle" && phase !== "done" && phase !== "error"
    && phase !== "residual_unsafe" && phase !== "safe_done";
  const pressureFillPercent = Math.max(0, Math.min(100, ((currentKpa ?? 0) / PRESSURE_MAX_KPA) * 100));

  const phaseLabel = (() => {
    switch (phase) {
      case "idle":              return t("pressureCalStateIdle");
      case "starting_session":  return t("pressureCalStateStartingSession");
      case "holding_baseline":  return t("pressureCalStateHoldingBaseline");
      case "setting_pressure":  return t("pressureCalStateSettingPressure");
      case "stabilizing":       return t("pressureCalStateStabilizing");
      case "capturing":         return t("pressureCalStateCapturing");
      case "stopping_pressure": return t("pressureCalStateStoppingPressure");
      case "committing":        return t("pressureCalStateCommitting");
      case "done":              return t("pressureCalStateDone");
      case "aborting":          return t("pressureCalStateAborting");
      case "error":             return t("pressureCalStateError");
      case "awaiting_compressor_off": return t("pressureCalStateAwaitingCompressorOff");
      case "testing_residual":  return t("pressureCalStateTestingResidual");
      case "residual_unsafe":   return t("pressureCalStateResidualUnsafe");
      case "safe_done":         return t("pressureCalStateSafeDone");
      default:                  return phase;
    }
  })();

  useEffect(() => {
    api.pressureCalSettings().then((s) => {
      setConfigured(s.configured);
      setServerPresets(s.presets ?? []);
      setSelectedPreset(s.preset ?? "lab_pi");
      if (s.url) setCustomUrl(s.url);
    }).catch(() => {});
  }, []);

  useEffect(() => () => { abortRef.current = true; }, []);

  useEffect(() => {
    if (phase !== "idle" || !configured) return;
    const id = setInterval(async () => {
      try {
        const r = await api.pressureCalReadings();
        setCurrentKpa(r.uno.pressure_kpa);
        if (r.imada != null) { setCurrentImadaValue(r.imada.value); setCurrentImadaUnit(r.imada.unit); }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(id);
  }, [phase, configured]);

  async function handleSaveSettings() {
    setSettingsSaving(true);
    setSettingsError("");
    try {
      if (selectedPreset === "custom") {
        await api.savePressureCalSettings("custom", customUrl, customToken || undefined);
      } else {
        await api.savePressureCalSettings(selectedPreset);
      }
      const s = await api.pressureCalSettings();
      setConfigured(s.configured);
      setServerPresets(s.presets ?? []);
      setSelectedPreset(s.preset ?? "lab_pi");
      if (s.url) setCustomUrl(s.url);
      setCustomToken("");
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  }

  function handlePresetChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const key = e.target.value;
    setPresetKey(key);
    if (key in PRESSURE_CAL_PRESETS) setPoints(PRESSURE_CAL_PRESETS[key]);
  }

  function handleAddPoint() {
    const val = parseFloat(newPointInput);
    if (Number.isNaN(val) || val < PRESSURE_BASELINE_KPA || val > PRESSURE_MAX_KPA) return;
    setPoints((prev) => prev.includes(val) ? prev : [...prev, val].sort((a, b) => a - b));
    setPresetKey("custom");
    setNewPointInput("");
  }

  function removePoint(idx: number) {
    setPoints((prev) => prev.filter((_, i) => i !== idx));
    setPresetKey("custom");
  }

  function confirmCurrentPressureValue() {
    if (phase !== "stabilizing" || currentKpa === null) return;
    manualConfirmRef.current = {
      referenceN: currentImadaValue,
      reason: "manual_confirm",
      settledKpa: currentKpa,
      elapsedMs: 0,
    };
  }

  async function stopPressureControl() {
    await api.pressureCalStop();
  }

  async function waitForStable(targetKpa: number): Promise<PressureStableResult> {
    let lastReferenceN: number | null = null;
    let lastKpa: number | null = null;
    const pressureSamples: number[] = [];
    const startedAt = Date.now();
    while (true) {
      if (abortRef.current) {
        return {
          referenceN: lastReferenceN,
          reason: "timeout_window",
          settledKpa: lastKpa,
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (manualConfirmRef.current) {
        const manual = manualConfirmRef.current;
        manualConfirmRef.current = null;
        return {
          ...manual,
          elapsedMs: Date.now() - startedAt,
        };
      }
      try {
        const r: PressureCalReadings = await api.pressureCalReadings();
        setCurrentKpa(r.uno.pressure_kpa);
        if (r.imada != null) {
          setCurrentImadaValue(r.imada.value);
          setCurrentImadaUnit(r.imada.unit);
          lastReferenceN = r.imada.value;
        }
        lastKpa = r.uno.pressure_kpa;
        pressureSamples.push(r.uno.pressure_kpa);
        if (pressureSamples.length > PRESSURE_STABLE_ADAPTIVE_WINDOW_SAMPLES * 2) {
          pressureSamples.shift();
        }
        const elapsedMs = Date.now() - startedAt;

        // UNO safety clamp: the firmware closes the intake but PRESERVES the target
        // and auto-recovers via hysteresis. Do NOT re-issue the target here — a fresh
        // PSET would reset hold_mode back to Boost and spike from the high pressure.
        // Just surface the warning and keep waiting; the firmware resumes climbing.
        if (r.uno.safety_latched) {
          setSafetyLatchedWarning(true);
          stableCountRef.current = 0;
          addLogRef.current?.(`Safety clamp active at ${r.uno.pressure_kpa.toFixed(2)} kPa — holding, will auto-resume.`);
          await new Promise<void>((res) => setTimeout(res, PRESSURE_STABLE_SAMPLE_INTERVAL_MS));
          continue;
        }
        setSafetyLatchedWarning(false);

        if (
          r.uno.valve_open
          && r.uno.pressure_kpa > targetKpa + PRESSURE_OVERSHOOT_ABORT_KPA
        ) {
          overshootCountRef.current++;
          if (overshootCountRef.current >= PRESSURE_OVERSHOOT_ABORT_SAMPLES) {
            try { await stopPressureControl(); } catch { /* ignore */ }
            throw new Error(`pressure_runaway_detected target=${targetKpa.toFixed(2)} current=${r.uno.pressure_kpa.toFixed(2)}`);
          }
        } else {
          overshootCountRef.current = 0;
        }
        if (Math.abs(r.uno.pressure_kpa - targetKpa) < PRESSURE_STABLE_TOLERANCE_KPA) {
          stableCountRef.current++;
          if (stableCountRef.current >= PRESSURE_STABLE_CONFIRMATION_SAMPLES) {
            return {
              referenceN: lastReferenceN,
              reason: "strict",
              settledKpa: r.uno.pressure_kpa,
              elapsedMs,
            };
          }
        } else {
          stableCountRef.current = 0;
        }
        if (
          elapsedMs >= PRESSURE_STABLE_ADAPTIVE_DELAY_MS
          && hasStablePressureWindow(
            targetKpa,
            pressureSamples,
            PRESSURE_STABLE_ADAPTIVE_RANGE_KPA,
            PRESSURE_STABLE_ADAPTIVE_TARGET_SLACK_KPA,
          )
        ) {
          return {
            referenceN: lastReferenceN,
            reason: "adaptive_window",
            settledKpa: pressureWindowAverageKpa(recentPressureWindow(pressureSamples)),
            elapsedMs,
          };
        }
        if (
          elapsedMs >= PRESSURE_STABLE_MAX_WAIT_MS
          && hasStablePressureWindow(
            targetKpa,
            pressureSamples,
            PRESSURE_STABLE_TIMEOUT_RANGE_KPA,
            Number.POSITIVE_INFINITY,
          )
        ) {
          return {
            referenceN: lastReferenceN,
            reason: "timeout_window",
            settledKpa: pressureWindowAverageKpa(recentPressureWindow(pressureSamples)),
            elapsedMs,
          };
        }
      } catch { /* ignore */ }
      await new Promise<void>((res) => setTimeout(res, PRESSURE_STABLE_SAMPLE_INTERVAL_MS));
    }
  }

  async function runCalibration() {
    setShowCompressorOffBanner(false);
    abortRef.current = false;
    setCalLog([]);
    setCalError("");
    setPointIndex(0);
    setSafetyLatchedWarning(false);
    const addLog = (line: string) => setCalLog((prev) => [...prev, line]);
    addLogRef.current = addLog;
    const sortedPoints = [...points].sort((a, b) => a - b);

    try {
      setPhase("starting_session");
      setActiveTargetKpa(null);
      addLog("Starting calibration session...");
      await api.queueDeviceCommand(deviceUid, { command: "calibration_session_begin" });
      await new Promise<void>((res) => setTimeout(res, 1000));

      // Hold the pressure controller at the baseline (≈3.5 kPa) BEFORE sampling the
      // tare/zero point. Otherwise the intake valve keeps feeding air and the pressure
      // drifts upward, contaminating the tare baseline.
      setPhase("holding_baseline");
      setActiveTargetKpa(PRESSURE_BASELINE_KPA);
      addLog(`Holding at baseline ${PRESSURE_BASELINE_KPA} kPa before tare…`);
      await api.pressureCalSetTarget(PRESSURE_BASELINE_KPA);
      stableCountRef.current = 0;
      overshootCountRef.current = 0;
      manualConfirmRef.current = null;
      await waitForStable(PRESSURE_BASELINE_KPA);
      if (abortRef.current) {
        setPhase("aborting");
        setActiveTargetKpa(null);
        addLog("Aborting…");
        try { await stopPressureControl(); } catch { /* ignore */ }
        try { await api.queueDeviceCommand(deviceUid, { command: "calibration_session_abort" }); } catch { /* ignore */ }
        addLog(t("pressureCalSessionAborted"));
        setPhase("idle");
        return;
      }

      setPhase("capturing");
      addLog("Capturing tare baseline at baseline pressure…");
      await api.queueDeviceCommand(deviceUid, { command: "calibration_capture_tare", duration_ms: 3000 });
      await new Promise<void>((res) => setTimeout(res, 4000));
      const baselineKpa = currentKpa ?? 0;
      addLog(`Tare baseline captured. Baseline pressure: ${baselineKpa.toFixed(3)} kPa (levels will be stored as differential).`);

      for (let i = 0; i < sortedPoints.length; i++) {
        if (abortRef.current) break;
        const targetKpa = sortedPoints[i];
        setPointIndex(i);
        setActiveTargetKpa(targetKpa);
        manualConfirmRef.current = null;
        overshootCountRef.current = 0;

        setPhase("setting_pressure");
        addLog(`Setting pressure → ${targetKpa} kPa`);
        await api.pressureCalSetTarget(targetKpa);
        stableCountRef.current = 0;

        setPhase("stabilizing");
        addLog(`Stabilizing at ${targetKpa} kPa…`);
        const stability = await waitForStable(targetKpa);
        if (abortRef.current) break;
        if (stability.reason === "adaptive_window") {
          addLog(`Pressure settled at ${stability.settledKpa?.toFixed(3) ?? "-"} kPa after ${Math.round(stability.elapsedMs / 1000)}s; continuing with adaptive window.`);
        } else if (stability.reason === "manual_confirm") {
          addLog(`Manual confirm at target ${targetKpa} kPa, UNO ${stability.settledKpa?.toFixed(3) ?? "-"} kPa, reference sensor ${stability.referenceN?.toFixed(3) ?? "-"} ${currentImadaUnit}`);
        } else if (stability.reason === "timeout_window") {
          addLog(`Pressure held within ${PRESSURE_STABLE_TIMEOUT_RANGE_KPA.toFixed(2)} kPa window at ${stability.settledKpa?.toFixed(3) ?? "-"} kPa after ${Math.round(stability.elapsedMs / 1000)}s; continuing without waiting longer.`);
        }

        setPhase("capturing");
        const absoluteKpa = stability.settledKpa ?? targetKpa;
        const differentialKpa = Math.max(0, absoluteKpa - baselineKpa);
        addLog(`Capturing at ${absoluteKpa.toFixed(3)} kPa (differential: ${differentialKpa.toFixed(3)} kPa)`);
        await api.queueDeviceCommand(deviceUid, {
          command: "calibration_capture_all",
          level: differentialKpa,
          duration_ms: 3000,
        });
        await new Promise<void>((res) => setTimeout(res, 4000));
        if (abortRef.current) break;
        addLog(`Point ${i + 1}/${sortedPoints.length} done.`);
      }

      if (abortRef.current) {
        setPhase("aborting");
        setActiveTargetKpa(null);
        addLog("Aborting…");
        try { await stopPressureControl(); } catch { /* ignore */ }
        try { await api.queueDeviceCommand(deviceUid, { command: "calibration_session_abort" }); } catch { /* ignore */ }
        addLog(t("pressureCalSessionAborted"));
        setPhase("idle");
        setShowCompressorOffBanner(true);
        return;
      }

      setPhase("committing");
      addLog("Committing session…");
      await api.queueDeviceCommand(deviceUid, { command: "calibration_session_commit", auto_enable: true });
      await new Promise<void>((res) => setTimeout(res, 1000));
      await api.queueDeviceCommand(deviceUid, { command: "calibration_status" });

      addLog("Returning pressure system to baseline hold…");
      setActiveTargetKpa(PRESSURE_POST_CAL_HOLD_KPA);
      await api.pressureCalSetTarget(PRESSURE_POST_CAL_HOLD_KPA);
      await new Promise<void>((res) => setTimeout(res, PRESSURE_POST_CAL_HOLD_SETTLE_MS));

      addLog("Calibration complete! Holding at baseline. Please turn OFF the air compressor.");
      // Hold at baseline and ask the user (full-screen) to turn off the compressor.
      // The residual-pressure safety test runs only after they confirm.
      setPhase("awaiting_compressor_off");
      setShowCompressorOffModal(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCalError(msg);
      setActiveTargetKpa(null);
      setPhase("error");
      addLog(`Error: ${msg}`);
      try { await stopPressureControl(); } catch { /* ignore */ }
      setShowCompressorOffBanner(true);
    }
  }

  // Drive the controller toward targetKpa for up to timeoutMs. Returns true if the
  // pressure converges near the target (residual is high enough to hold it), false if
  // the timeout elapses without reaching it (residual is depleted → safe to shut down).
  async function waitForResidualOrTimeout(targetKpa: number, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    let stable = 0;
    while (Date.now() - startedAt < timeoutMs) {
      if (abortRef.current) return false;
      try {
        const r: PressureCalReadings = await api.pressureCalReadings();
        setCurrentKpa(r.uno.pressure_kpa);
        if (r.imada != null) { setCurrentImadaValue(r.imada.value); setCurrentImadaUnit(r.imada.unit); }
        if (Math.abs(r.uno.pressure_kpa - targetKpa) < PRESSURE_STABLE_TOLERANCE_KPA) {
          stable++;
          if (stable >= PRESSURE_STABLE_CONFIRMATION_SAMPLES) return true;
        } else {
          stable = 0;
        }
      } catch { /* ignore */ }
      await new Promise<void>((res) => setTimeout(res, PRESSURE_STABLE_SAMPLE_INTERVAL_MS));
    }
    return false;
  }

  // Triggered after the user confirms the compressor is off. Probes whether residual
  // pressure can still hold PRESSURE_RESIDUAL_TEST_KPA. If it can, disabling pressure
  // control would let stored pressure rush in dangerously, so we keep holding at the
  // baseline and let the user bleed off pressure and re-test. Only when the residual is
  // too low to reach the test pressure do we disable pressure control.
  async function runResidualSafetyTest() {
    setShowCompressorOffModal(false);
    const addLog = (line: string) => setCalLog((prev) => [...prev, line]);
    abortRef.current = false;
    try {
      setPhase("testing_residual");
      setActiveTargetKpa(PRESSURE_RESIDUAL_TEST_KPA);
      addLog(`Testing residual pressure: trying to hold ${PRESSURE_RESIDUAL_TEST_KPA} kPa…`);
      await api.pressureCalSetTarget(PRESSURE_RESIDUAL_TEST_KPA);
      const reached = await waitForResidualOrTimeout(PRESSURE_RESIDUAL_TEST_KPA, PRESSURE_RESIDUAL_TEST_TIMEOUT_MS);
      if (abortRef.current) {
        try { await stopPressureControl(); } catch { /* ignore */ }
        setActiveTargetKpa(null);
        setPhase("idle");
        return;
      }
      if (reached) {
        // Residual still high → unsafe to disable. Return to baseline hold and wait.
        addLog(`Residual pressure still holds ${PRESSURE_RESIDUAL_TEST_KPA} kPa — not safe to disable pressure control. Bleed off pressure and re-test.`);
        setActiveTargetKpa(PRESSURE_BASELINE_KPA);
        try { await api.pressureCalSetTarget(PRESSURE_BASELINE_KPA); } catch { /* ignore */ }
        setPhase("residual_unsafe");
      } else {
        // Residual depleted → safe to disable pressure control.
        addLog("Residual pressure depleted — disabling pressure control.");
        await api.pressureCalStop();
        setActiveTargetKpa(null);
        setPhase("safe_done");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCalError(msg);
      setActiveTargetKpa(null);
      setPhase("error");
      addLog(`Error: ${msg}`);
      try { await stopPressureControl(); } catch { /* ignore */ }
    }
  }

  return (
    <div className="settings-stack">
      <div className="settings-detail-header">
        <h3>{t("pressureCalibration")}</h3>
      </div>

      {showCompressorOffBanner && (
        <div className="compressor-safety-banner">
          <span className="banner-icon"><TriangleAlert size={22} strokeWidth={1.8} /></span>
          <span className="banner-text">{t("compressorOffBanner")}</span>
          <button className="banner-dismiss" type="button" onClick={() => setShowCompressorOffBanner(false)}>
            {t("compressorOffDismiss")}
          </button>
        </div>
      )}

      {/* API Settings */}
      <div className="settings-card">
        <div className="settings-detail-header">
          <div>
            <h4>{t("pressureCalApiSettings")}</h4>
          </div>
          <button className="button primary" type="button" disabled={settingsSaving} onClick={() => void handleSaveSettings()}>
            {settingsSaving ? t("running") : t("pressureCalApiSave")}
          </button>
        </div>
        <div className="field-grid">
          <div className="field">
            <label>{t("pressureCalServer")}</label>
            <select value={selectedPreset} onChange={(e) => setSelectedPreset(e.target.value)} disabled={isRunning}>
              {serverPresets.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
              <option value="custom">{t("pressureCalServerCustom")}</option>
            </select>
          </div>
          {selectedPreset !== "custom" && serverPresets.find((p) => p.id === selectedPreset) && (
            <div className="field">
              <label>{t("pressureCalApiUrl")}</label>
              <input type="url" value={serverPresets.find((p) => p.id === selectedPreset)!.url} readOnly />
            </div>
          )}
        </div>
        {selectedPreset === "custom" && (
          <div className="field-grid">
            <div className="field">
              <label>{t("pressureCalApiUrl")}</label>
              <input type="url" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} />
            </div>
            <div className="field">
              <label>{t("pressureCalApiToken")}</label>
              <input type="password" value={customToken} onChange={(e) => setCustomToken(e.target.value)} placeholder={configured ? "••••••••" : ""} />
            </div>
          </div>
        )}
        {settingsError && <p className="notice error">{settingsError}</p>}
        {!configured && !settingsError && <p className="notice">{t("pressureCalApiNotConfigured")}</p>}
      </div>

      {/* Live readings */}
      {configured && (
        <div className="settings-card">
          <h4>{t("pressureCalLiveStatusCard")}</h4>
          <div className="metric-row">
            <Metric label={t("pressureCalTargetKpa")} value={activeTargetKpa !== null ? `${activeTargetKpa.toFixed(3)} kPa` : "-"} />
            <Metric label={t("pressureCalMaxKpa")} value={`${PRESSURE_MAX_KPA.toFixed(0)} kPa`} />
          </div>
          <div className="pressure-live-bar-track" aria-label={t("pressureCalMaxKpa")}>
            <div className="pressure-live-bar-fill" style={{ width: `${pressureFillPercent}%` }} />
          </div>
          <div className="metric-row">
            <Metric label={t("pressureCalUnoKpa")} value={currentKpa !== null ? `${currentKpa.toFixed(3)} kPa` : "-"} />
            <Metric label={t("pressureCalReferencePressure")} value={currentImadaValue !== null ? `${currentImadaValue.toFixed(3)} ${currentImadaUnit}` : t("pressureCalRefNotConnected")} />
          </div>
          {phase === "stabilizing" && (
            <div className="actions compact">
              <button
                className="button primary"
                type="button"
                disabled={currentKpa === null}
                onClick={confirmCurrentPressureValue}
              >
                {t("manualConfirmCapture")}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Calibration Points */}
      <div className="settings-card">
        <div className="settings-detail-header">
          <div>
            <h4>{t("pressureCalPoints")}</h4>
            <p>{t("pressureCalSafetyLimit")}</p>
          </div>
          <div className="field">
            <label>{t("pressureCalPointsPreset")}</label>
            <select value={presetKey} onChange={handlePresetChange} disabled={isRunning}>
              {Object.keys(PRESSURE_CAL_PRESETS).map((key) => (
                <option key={key} value={key}>
                  {t(`pressureCalPreset${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
                </option>
              ))}
              <option value="custom">{t("pressureCalPresetCustom")}</option>
            </select>
          </div>
        </div>
        <div className="calibration-level-list">
          {points.map((p, i) => (
            <div key={i} className="calibration-level-item">
              <button type="button">
                <strong>{p} {t("pressureCalPointUnit")}</strong>
              </button>
              {!isRunning && (
                <button className="button danger tiny" type="button" onClick={() => removePoint(i)}>
                  {t("pressureCalRemovePoint")}
                </button>
              )}
            </div>
          ))}
        </div>
        {!isRunning && (
          <div className="field-grid">
            <div className="field">
              <label>kPa ({PRESSURE_BASELINE_KPA}–{PRESSURE_MAX_KPA})</label>
              <input type="number" min={PRESSURE_BASELINE_KPA} max={PRESSURE_MAX_KPA} value={newPointInput} onChange={(e) => setNewPointInput(e.target.value)} />
            </div>
            <div className="field settings-field-action">
              <button className="button" type="button" onClick={handleAddPoint}>
                {t("pressureCalAddPoint")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Progress */}
      {phase !== "idle" && (() => {
        const terminalPhase = phase === "done" || phase === "error"
          || phase === "residual_unsafe" || phase === "safe_done";
        const showPointCounter = !terminalPhase
          && phase !== "awaiting_compressor_off" && phase !== "testing_residual";
        return (
          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("pressureCalProgress")}</h4>
                <p>{phaseLabel}{showPointCounter ? ` — ${pointIndex + 1}/${points.length}` : ""}</p>
              </div>
            </div>
            {!terminalPhase && (
              <div className="level-progress-bar">
                <div className="level-progress-bar-fill" style={{ width: `${Math.round((pointIndex / Math.max(points.length, 1)) * 100)}%` }} />
              </div>
            )}
            {calLog.length > 0 && (
              <div className="changelog-panel">
                <pre>{calLog.slice(-10).join("\n")}</pre>
              </div>
            )}
            {phase === "error" && <p className="notice error">{calError}</p>}
            {safetyLatchedWarning && phase === "stabilizing" && (
              <p className="notice warning">{t("safetyLatchedWarning")}</p>
            )}
            {phase === "awaiting_compressor_off" && !showCompressorOffModal && (
              <div className="actions compact">
                <button className="button primary" type="button" onClick={() => setShowCompressorOffModal(true)}>
                  {t("compressorOffConfirmOk")}
                </button>
              </div>
            )}
            {phase === "residual_unsafe" && (
              <>
                <p className="notice warning">{t("residualUnsafeMessage")}</p>
                <div className="actions compact">
                  <button className="button primary" type="button" onClick={() => void runResidualSafetyTest()}>
                    {t("residualRetryTest")}
                  </button>
                </div>
              </>
            )}
            {phase === "safe_done" && <p className="notice success">{t("residualSafeMessage")}</p>}
          </div>
        );
      })()}

      {/* Controls */}
      <div className="actions compact">
        <button
          className="button primary"
          type="button"
          disabled={isRunning || !configured || !deviceUid || points.length === 0}
          onClick={() => setShowCompressorOnModal(true)}
        >
          {t("pressureCalStart")}
        </button>
        {isRunning && (
          <button className="button danger" type="button" onClick={() => { abortRef.current = true; }}>
            {t("pressureCalEmergencyStop")}
          </button>
        )}
      </div>

      {showCompressorOnModal && (
        <ConfirmModal
          title={t("compressorOnConfirmTitle")}
          message={t("compressorOnConfirm")}
          confirmLabel={t("compressorOnConfirmOk")}
          cancelLabel={t("cancel")}
          onConfirm={() => { setShowCompressorOnModal(false); void runCalibration(); }}
          onCancel={() => setShowCompressorOnModal(false)}
        />
      )}

      {showCompressorOffModal && (
        <ConfirmModal
          title={t("compressorOffConfirmTitle")}
          message={t("compressorOffConfirmMsg")}
          confirmLabel={t("compressorOffConfirmOk")}
          cancelLabel={t("cancel")}
          onConfirm={() => void runResidualSafetyTest()}
          onCancel={() => setShowCompressorOffModal(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

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
    "tare_complete",
    "levels_complete",
    "legacy_missing_tare",
    "tare",
    "draft_tare",
    "levels",
    "draft_levels",
    "metadata",
  ].some((key) => key in direct);
  return hasTopLevelKeys ? direct : {};
}

function parseCalibrationCaptureSummary(value: unknown, fallbackSource: string): CalibrationCaptureSummary | null {
  const source = recordValue(value);
  if (Object.keys(source).length === 0) return null;
  return {
    captured_points: numberValue(source.captured_points, 0),
    total_points: numberValue(source.total_points, 0),
    missing_points: numberValue(source.missing_points, 0),
    complete: source.complete === true,
    source: stringValue(source.source, fallbackSource),
  };
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
    tare_complete: source.tare_complete === true,
    levels_complete: source.levels_complete === true,
    legacy_missing_tare: source.legacy_missing_tare === true,
    tare: parseCalibrationCaptureSummary(source.tare, "saved"),
    draft_tare: parseCalibrationCaptureSummary(source.draft_tare, "draft"),
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

function parseCalibrationTareLayer(value: unknown): CalibrationTareLayer {
  if (value === null || value === undefined) return null;
  const source = recordValue(value);
  if (Object.keys(source).length === 0) return null;
  return {
    captured_points: numberValue(source.captured_points, 0),
    total_points: numberValue(source.total_points, 0),
    complete: source.complete === true,
    cells: parseCalibrationCells(source.cells),
  };
}

function parseCalibrationTarePreview(value: unknown): CalibrationTarePreview {
  const source = recordValue(value);
  if (!("saved" in source) && !("draft" in source)) {
    return null;
  }
  return {
    total_points: numberValue(source.total_points, 0),
    saved: parseCalibrationTareLayer(source.saved),
    draft: parseCalibrationTareLayer(source.draft),
    session_active: source.session_active === true,
  };
}

function calibrationCellLookup(layer: CalibrationLevelLayer | CalibrationTareLayer) {
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
  const [tarePreview, setTarePreview] = useState<CalibrationTarePreview>(null);
  const [calibrationLevelPreview, setCalibrationLevelPreview] = useState<CalibrationLevelPreview | null>(null);
  const [tarePreviewError, setTarePreviewError] = useState("");
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

  async function loadTarePreview() {
    setTarePreviewError("");
    const response = await run(t("preview"), { command: "calibration_dump_tare" });
    const preview = parseCalibrationTarePreview(response.result);
    if (!preview) {
      setTarePreviewError(t("previewUnavailable"));
      return;
    }
    setTarePreview(preview);
  }

  useEffect(() => {
    if (!deviceUid || isDeviceOffline) return;
    void syncCalibrationStatus().catch(() => undefined);
  }, [deviceUid, isDeviceOffline]);

  const totalSensors = rows * cols;
  const savedTareLookup = calibrationCellLookup(tarePreview?.saved ?? null);
  const draftTareLookup = calibrationCellLookup(tarePreview?.draft ?? null);
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

  function findNextUncalibrated(current: number): number | null {
    for (let i = 1; i < totalSensors; i++) {
      const idx = (current + i) % totalSensors;
      const cell = draftLookup.get(idx) ?? savedLookup.get(idx);
      if (!cell?.calibrated) return idx;
    }
    return null;
  }

  async function captureSelectedSensor() {
    const capturedIndex = selectedCalibrationSensor;
    await run(t("captureSelectedSensor"), {
      command: "calibration_capture_cell",
      sensor_index: capturedIndex,
      level: calibrationLevel,
      duration_ms: calibrationDuration,
    }, 40000);
    await syncCalibrationStatus();
    await loadLevelPreview(calibrationLevel);
    const next = findNextUncalibrated(capturedIndex);
    if (next !== null) setSelectedCalibrationSensor(next);
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

  async function captureTare() {
    await run(t("captureTare"), {
      command: "calibration_capture_tare",
      duration_ms: calibrationDuration,
    }, 45000);
    await syncCalibrationStatus();
    await loadTarePreview();
  }

  async function dumpTare() {
    await loadTarePreview();
  }

  async function startCalibrationSession() {
    await run(t("startCalibrationSession"), { command: "calibration_session_begin" });
    await syncCalibrationStatus();
  }

  async function abortCalibrationSession() {
    if (!window.confirm(t("abortCalibrationSessionConfirm"))) return;
    await run(t("abortCalibrationSession"), { command: "calibration_session_abort" });
    setTarePreview(null);
    setCalibrationLevelPreview(null);
    setSelectedLevel(null);
    await syncCalibrationStatus();
  }

  async function commitCalibrationSession() {
    await run(t("commitCalibrationSession"), { command: "calibration_session_commit", auto_enable: false });
    await syncCalibrationStatus();
    if (tarePreview) {
      await loadTarePreview();
    }
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

  async function applyTare() {
    await run(t("applyTare"), { command: "calibration_tare_capture", duration_ms: 1000 });
    await syncCalibrationStatus();
  }

  async function clearCalibrationProfile() {
    if (!window.confirm(t("clearCalibrationProfileConfirm"))) return;
    await run(t("clearCalibrationProfile"), { command: "calibration_clear_profile" });
    setTarePreview(null);
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
        <DetailBox label={t("tareState")} value={calibrationState.tare_complete ? t("profileComplete") : t("profileIncomplete")} />
        <DetailBox label={t("levelState")} value={calibrationState.levels_complete ? t("profileComplete") : t("profileIncomplete")} />
        <DetailBox label={t("calibrationLevelCount")} value={calibrationState.levels.length} />
        <DetailBox label={t("matrixShape")} value={`${rows || "-"} x ${cols || "-"}`} />
      </div>
      {calibrationState.legacy_missing_tare ? <p className="notice">{t("calibrationLegacyMissingTare")}</p> : null}

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
          <button className="button" type="button" disabled={busyCommand === "calibration_capture_tare" || !maintenanceMode || !deviceUid || totalSensors === 0} onClick={() => void captureTare()}>
            {busyCommand === "calibration_capture_tare" ? t("running") : t("captureTare")}
          </button>
          <button className="button" type="button" disabled={busyCommand === "calibration_dump_tare" || !deviceUid || isDeviceOffline} onClick={() => void dumpTare()}>
            {busyCommand === "calibration_dump_tare" ? t("running") : t("dumpTare")}
          </button>
          <button className="button" type="button" disabled={busyCommand === "calibration_enable" || !deviceUid || !calibrationState.complete} onClick={() => void enableCalibrationProfile()}>
            {busyCommand === "calibration_enable" ? t("running") : t("enableCalibrationProfile")}
          </button>
          <button className="button" type="button" disabled={busyCommand === "calibration_disable" || !deviceUid} onClick={() => void disableCalibrationProfile()}>
            {busyCommand === "calibration_disable" ? t("running") : t("disableCalibrationProfile")}
          </button>
          <button className="button" type="button" disabled={busyCommand === "calibration_tare_capture" || !maintenanceMode || !deviceUid || isDeviceOffline} onClick={() => void applyTare()} title={t("applyTareHint")}>
            {busyCommand === "calibration_tare_capture" ? t("running") : t("applyTare")}
          </button>
          <button className="button danger" type="button" disabled={busyCommand === "calibration_clear_profile" || !maintenanceMode || !deviceUid} onClick={() => void clearCalibrationProfile()}>
            {busyCommand === "calibration_clear_profile" ? t("running") : t("clearCalibrationProfile")}
          </button>
          <button className="button" type="button" disabled={busyCommand === "storage_status" || !deviceUid || isDeviceOffline} onClick={() => void run(t("refreshFlashUsage"), { command: "storage_status" })}>
            {busyCommand === "storage_status" ? t("running") : t("refreshFlashUsage")}
          </button>
          <a className="button" href={appHref(`device/${encodeURIComponent(deviceUid)}/files`)} target="_blank" rel="noreferrer">
            {t("maintenanceFiles")}
          </a>
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

        <div className="calibration-right-stack">
          <section className="settings-card calibration-preview-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("tarePreviewTitle")}</h4>
                <p>{t("tarePreviewCopy")}</p>
              </div>
            </div>
            <div className="settings-detail-grid compact">
              <DetailBox label={t("savedCalibrationLayer")} value={tarePreview?.saved?.captured_points ?? calibrationState.tare?.captured_points ?? 0} />
              <DetailBox label={t("draftCalibrationLayer")} value={tarePreview?.draft?.captured_points ?? calibrationState.draft_tare?.captured_points ?? 0} />
              <DetailBox label={t("calibrationSessionState")} value={tarePreview?.session_active || calibrationState.session_active ? t("sessionActive") : t("sessionInactive")} />
            </div>
            {tarePreviewError ? <p className="notice error">{tarePreviewError}</p> : null}
            {tarePreview ? (
              <div className="calibration-preview-grid" style={{ gridTemplateColumns: `repeat(${Math.max(cols, 1)}, minmax(0, 1fr))` }}>
                {Array.from({ length: totalSensors }).map((_, visualIndex) => {
                  const rowIndex = rows > 0 ? visualIndex % rows : 0;
                  const colIndex = rows > 0 ? Math.floor(visualIndex / rows) : 0;
                  const sensorIndex = colIndex * rows + rowIndex;
                  const draftCell = draftTareLookup.get(sensorIndex);
                  const savedCell = savedTareLookup.get(sensorIndex);
                  const activeCell = draftCell ?? savedCell;
                  return (
                    <div key={`tare-preview-${sensorIndex}`} className={`calibration-preview-cell${draftCell?.calibrated ? " draft" : ""}${!draftCell?.calibrated && savedCell?.calibrated ? " saved" : ""}`}>
                      <strong>P{sensorIndex}</strong>
                      <span>{activeCell?.calibrated ? String(activeCell.value ?? "-") : "-"}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="service-muted">{t("tarePreviewEmpty")}</p>
            )}
          </section>

          <section className="settings-card calibration-browser-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("calibrationLevelBrowser")}</h4>
                <p>{t("calibrationLevelBrowserCopy")}</p>
              </div>
            </div>
            <div className="calibration-level-list">
              {mergedLevels.length > 0 ? mergedLevels.map((item) => {
                const pct = item.total_points > 0 ? Math.round(item.captured_points / item.total_points * 100) : 0;
                return (
                  <div className={`calibration-level-item${selectedLevel === item.level ? " active" : ""}`} key={`${item.source}-${item.level}`}>
                    <button type="button" onClick={() => void loadLevelPreview(item.level)}>
                      <div className="calibration-level-item-header">
                        <strong>{t("paramLevel")} {item.level} kPa</strong>
                        <span className={`level-source-badge${item.source === "draft" ? " draft" : ""}`}>{item.source}</span>
                      </div>
                      <div className="level-progress-bar">
                        <div className="level-progress-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="level-progress-text">{item.captured_points}/{item.total_points} ({pct}%)</span>
                    </button>
                    <button className="button danger tiny" type="button" disabled={busyCommand === "calibration_delete_level" || !maintenanceMode} onClick={() => void deleteCalibrationLevel(item.level)}>
                      {t("delete")}
                    </button>
                  </div>
                );
              }) : <p className="service-muted">{t("noCalibrationLevels")}</p>}
            </div>
          </section>

          <section className="settings-card calibration-preview-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("calibrationLevelPreview")}</h4>
                <p>{selectedLevel === null ? t("noCalibrationPreviewSelected") : `${t("paramLevel")} ${selectedLevel}`}</p>
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
              <p className="service-muted">{t("noCalibrationPreviewSelected")}</p>
            )}
          </section>
        </div>
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
  const logging = recordValue(status.logging ?? runtime.logging ?? (lastResultCommand === "set_log" ? lastResult.log_status ?? lastResult.logging : undefined));
  const otaConfig = recordValue(status.ota ?? status.update_config ?? (lastResultCommand === "set_ota_config" ? lastResult.ota : undefined));
  const storageSnapshot = storageSnapshotFromDevice(device);
  const storageUsage = storageSnapshot.categories;
  const storageTotal = storageSnapshot.totalBytes;
  const storageUsed = storageSnapshot.usedBytes;
  const storageFree = storageSnapshot.freeBytes;
  const hasStoragePayload = storageSnapshot.hasPayload;
  const ramTotal = numberValue(memory.heap_total, 0);
  const ramFree = numberValue(memory.heap_free, 0);
  const ramUsed = numberValue(memory.heap_used, ramTotal > ramFree ? ramTotal - ramFree : 0);
  const ramUsedPercent = percent(ramUsed, ramTotal);
  const imu = recordValue(status.imu ?? runtime.imu ?? (lastResultCommand === "set_imu" ? lastResult.imu : undefined));
  const filter = recordValue(status.filter ?? runtime.filter ?? (lastResultCommand === "set_filter" ? lastResult.filter : undefined));
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

  const [activeSection, setActiveSection] = useState<SettingsSection>("overview");
  const boardProfile = useMemo(() => boardProfileForHardwareModel(normalized?.hardwareModel), [normalized?.hardwareModel]);
  const powerStatusCopy = boardProfile.powerUx === "remote_only" ? t("powerStatusCopyRemoteOnly") : t("powerStatusCopy");
  const pinLayoutCopy = boardProfile.powerUx === "remote_only" ? t("pinLayoutCopyGcu") : t("pinLayoutCopyV1");
  const [manifestUrl, setManifestUrl] = useState(() => defaultManifestUrlForHardwareModel(normalized?.hardwareModel));
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
  const [chargeProfile, setChargeProfile] = useState(stringValue(batteryStatus.profile, "balanced"));
  const [imuEnabled, setImuEnabled] = useState(imu.enabled !== false);
  const [filterEnabled, setFilterEnabled] = useState(filter.enabled === true);
  const [filterMedian, setFilterMedian] = useState(numberValue(filter.median, 3));
  const [filterAlpha, setFilterAlpha] = useState(numberValue(filter.alpha, 0.25));
  const [logEnabled, setLogEnabled] = useState(logging.enabled !== false);
  const [logLevel, setLogLevel] = useState(stringValue(logging.level, "error"));
  const [logMode, setLogMode] = useState(stringValue(logging.mode, "standard"));
  const [externalLedMode, setExternalLedMode] = useState(stringValue(externalLed.mode, "off"));
  const [brightness, setBrightness] = useState(externalLedBrightnessValue(externalLed.brightness));
  const [externalPreset, setExternalPreset] = useState(stringValue(externalLed.preset, "stream_health"));
  const [oledMode, setOledMode] = useState(stringValue(oled.mode, "off"));
  const [oledPage, setOledPage] = useState(stringValue(oled.page, "live_status"));
  const [oledUpdateHz, setOledUpdateHz] = useState(numberValue(oled.update_hz, 1));
  const [oledContrast, setOledContrast] = useState(numberValue(oled.contrast, 128));
  const [oledRotation, setOledRotation] = useState(numberValue(oled.rotation, 0));
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
    { id: "overview", label: t("settingsSection_overview") },
    { id: "hardware", label: t("settingsSection_hardware") },
    { id: "runtime", label: t("settingsSection_runtime") },
    { id: "maintenance", label: t("settingsSection_maintenance") },
    { id: "diagnostics", label: t("settingsSection_diagnostics") },
    { id: "files", label: t("settingsSection_files") },
    { id: "experimental", label: t("settingsSection_experimental") },
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
    if (filter.enabled === undefined && filter.median === undefined && filter.alpha === undefined) {
      setFilterEnabled(false);
      setFilterMedian(3);
      setFilterAlpha(0.25);
      return;
    }
    setFilterEnabled(filter.enabled === true);
    if (filter.median !== undefined) setFilterMedian(numberValue(filter.median, 3));
    if (filter.alpha !== undefined) setFilterAlpha(numberValue(filter.alpha, 0.25));
  }, [deviceUid, filter.alpha, filter.enabled, filter.median]);

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
      return;
    }
    setManifestUrl(defaultManifestUrlForHardwareModel(normalized?.hardwareModel));
  }, [normalized?.hardwareModel, otaConfig.auto_apply_on_boot, otaConfig.manifest_url]);

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
    if (oled.rotation !== undefined) setOledRotation(numberValue(oled.rotation, 0));
  }, [oled.contrast, oled.mode, oled.page, oled.update_hz, oled.rotation]);

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
    if (activeSection !== "hardware" || !deviceUid || busyCommand || isDeviceOffline) return;
    if (analogPinsFromStatus && selectPinsFromStatus) return;
    if (pinStatusAutoRequestedRef.current[deviceUid]) return;
    pinStatusAutoRequestedRef.current[deviceUid] = true;
    void run(t("refreshStatus"), { command: "status" }, 10000).catch(() => undefined);
  }, [activeSection, analogPinsFromStatus, busyCommand, deviceUid, isDeviceOffline, selectPinsFromStatus, t]);

  function runIndicatorsStatusRefresh() {
    if (!deviceUid || isDeviceOffline) return;
    lastIndicatorsStatusAutoRefreshKeyRef.current = `${deviceUid}:hardware`;
    indicatorsStatusAutoRefreshPendingRef.current = false;
    void run(t("refreshStatus"), { command: "status" }, 10000).catch(() => undefined);
  }

  useEffect(() => {
    if (activeSection !== "hardware" || !deviceUid || isDeviceOffline) {
      lastIndicatorsStatusAutoRefreshKeyRef.current = "";
      indicatorsStatusAutoRefreshPendingRef.current = false;
      return;
    }
    const refreshKey = `${deviceUid}:hardware`;
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

  async function applyFilter() {
    await run(t("saveFilter"), {
      command: "set_filter",
      enabled: filterEnabled,
      median: filterMedian,
      alpha: filterAlpha,
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
    if (activeSection === "overview") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_overview")}</h3>
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
          <div className="settings-card">
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
        </div>
      );
    }

    if (activeSection === "hardware") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_hardware")}</h3>
              <p>{pinLayoutCopy} {t("matrixShape")}: {normalized?.matrixShape ?? "-"}</p>
            </div>
            <button className="button" type="button" onClick={() => setShowIoModal(true)}>
              {t("ioConfigOpen")}
            </button>
          </div>
          <div className="settings-card">
            <h4>{t("settingsSection_pins")}</h4>
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
          </div>
          <div className="settings-card">
            <h4>{t("externalLedIndicators")}</h4>
            {!boardProfile.supportsExternalLed ? (
              <>
                <p className="notice">{t("unsupportedOnThisBoard")}</p>
                <p className="service-muted">{t("externalLedUnsupportedCopy")}</p>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
          <div className="settings-card">
            <h4>{t("ssd1306Display")}</h4>
            {!boardProfile.supportsOled ? (
              <>
                <p className="notice">{t("unsupportedOnThisBoard")}</p>
                <p className="service-muted">{t("oledUnsupportedCopy")}</p>
              </>
            ) : (
              <>
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
                  <div className="field">
                    <label>{t("oledRotation")}</label>
                    <select value={oledRotation} onChange={(event) => setOledRotation(Number(event.target.value))}>
                      <option value={0}>{t("oledRotation_0")}</option>
                      <option value={1}>{t("oledRotation_90")}</option>
                      <option value={2}>{t("oledRotation_180")}</option>
                      <option value={3}>{t("oledRotation_270")}</option>
                    </select>
                  </div>
                </div>
                <div className="actions">
                  <button className="button" type="button" disabled={isCommandBusy("set_indicators") || !deviceUid} onClick={() => void run(t("saveScreen"), { command: "set_indicators", oled: { mode: oledMode, page: oledPage, update_hz: oledUpdateHz, contrast: oledContrast, rotation: oledRotation } })}>
                    {isCommandBusy("set_indicators") ? t("running") : t("saveScreen")}
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="settings-card">
            <h4>{t("batteryStatus")}</h4>
            {!boardProfile.supportsChargeControl ? (
              <>
                <p className="notice">{t("unsupportedOnThisBoard")}</p>
                <p className="service-muted">{t("chargeControlUnsupportedCopy")}</p>
              </>
            ) : (
              <>
                <div className="settings-detail-header">
                  <div>
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
                    <option value="ultra_slow">{t("ultraSlowChargingMode")}</option>
                    <option value="slow">{t("slowChargingMode")}</option>
                    <option value="balanced">{t("balancedChargingMode")}</option>
                    <option value="fast">{t("fastChargingMode")}</option>
                    <option value="extreme">{t("extremeChargingMode")}</option>
                  </select>
                </div>
                </div>
                <div className="metric-row">
                  <Metric label={t("battery")} value={batteryStatus.state ?? "-"} />
                  <Metric label={t("chargeProfile")} value={batteryStatus.profile ?? "-"} />
                  <Metric label={t("chargeCurrentMa")} value={batteryStatus.charge_current_ma ?? "-"} />
                  <Metric label={t("inputLimitMa")} value={batteryStatus.input_limit_ma ?? "-"} />
                  <Metric label={t("vbatRegMv")} value={batteryStatus.vbat_reg_mv ?? "-"} />
                  <Metric label={t("safetyTimerHours")} value={batteryStatus.safety_timer_hours ?? "-"} />
                  <Metric label={t("configured")} value={boolString(batteryStatus.configured)} />
                  <Metric label={t("chargerDetected")} value={boolString(batteryStatus.charger_detected ?? batteryStatus.detected)} />
                </div>
              </>
            )}
          </div>
          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("powerStatus")}</h4>
                <p>{powerStatusCopy}</p>
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
        </div>
      );
    }

    if (activeSection === "runtime") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_runtime")}</h3>
              <p>{t("runtimeSettingsCopy")}</p>
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("settingsSection_update")}</h4>
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
          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("scanPerformance")}</h4>
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
          <div className="settings-card">
            <h4>{t("streamBufferDiagnostics")}</h4>
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
        </div>
      );
    }

    if (activeSection === "maintenance") {
      return (
        <div className="settings-stack">
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
          <PressureCalibrationPanel t={t} deviceUid={deviceUid} />
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

    if (activeSection === "files") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_files")}</h3>
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
              <strong>{hasStoragePayload ? `${bytesLabel(storageUsed)} / ${bytesLabel(storageTotal)}` : t("flashUnavailable")}</strong>
            </div>
            <div className="storage-bar-track" aria-label={t("deviceStorage")}>
              {storageUsage.length > 0 ? storageUsage.map((item) => (
                <span
                  key={item.scope}
                  className={`storage-segment ${item.scope}`}
                  style={{ width: `${percent(item.bytes, storageTotal)}%` }}
                />
              )) : storageTotal > 0 ? (
                <span
                  className="storage-segment other"
                  style={{ width: `${percent(storageUsed, storageTotal)}%` }}
                />
              ) : null}
            </div>
            <div className="storage-summary">
              <span>{t("used")}: {bytesLabel(storageUsed)}</span>
              <span>{t("free")}: {bytesLabel(storageFree)}</span>
              <span>{t("total")}: {hasStoragePayload ? bytesLabel(storageTotal) : "-"}</span>
            </div>
            <div className="storage-legend">
              {!hasStoragePayload ? <span>{t("flashUnavailable")}</span> : null}
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
              <a className="button" href={appHref(`device/${encodeURIComponent(deviceUid)}/files`)} target="_blank" rel="noreferrer">
                {t("fileBrowser")}
              </a>
              <button className="button danger" type="button" disabled={isCommandBusy("log_clear") || !deviceUid} onClick={() => void run("Log clear", { command: "log_clear" })}>
                {isCommandBusy("log_clear") ? t("running") : "Clear logs"}
              </button>
            </div>
            <div className="settings-detail-grid compact">
              <DetailBox label={t("paramEnabled")} value={boolString(logging.enabled)} />
              <DetailBox label={t("logLevel")} value={logging.level ?? "-"} />
              <DetailBox label={t("logMode")} value={logging.mode ?? "-"} />
              <DetailBox label="Max bytes" value={logging.max_bytes ? bytesLabel(logging.max_bytes) : "-"} />
              <DetailBox label={t("logFlashFootprint")} value={logging.effective_total_bytes ? bytesLabel(logging.effective_total_bytes) : "-"} />
              <DetailBox label={t("logCurrentBytes")} value={logging.bytes !== undefined ? bytesLabel(logging.bytes) : "-"} />
            </div>
          </div>
        </div>
      );
    }

    if (activeSection === "experimental") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_experimental")}</h3>
              <p>{t("experimentalSettingsCopy")}</p>
            </div>
          </div>
          <div className="settings-card">
            <h4>{t("filterDiagnostics")}</h4>
            <p>{t("filterDiagnosticsCopy")}</p>
            <div className="field-grid">
              <label className="switch-row">
                <input type="checkbox" checked={filterEnabled} onChange={(event) => setFilterEnabled(event.target.checked)} />
                <span>{t("filterEnabled")}</span>
              </label>
              <div className="field">
                <label>{t("filterMedian")}</label>
                <select value={filterMedian} disabled={!filterEnabled} onChange={(event) => setFilterMedian(Number(event.target.value))}>
                  <option value={1}>1 ({t("filterMedianOff")})</option>
                  <option value={3}>3</option>
                  <option value={5}>5</option>
                </select>
              </div>
              <div className="field">
                <label>{t("filterAlpha")}</label>
                <input type="number" min={0.05} max={0.6} step={0.05} value={filterAlpha}
                  disabled={!filterEnabled} onChange={(event) => setFilterAlpha(Number(event.target.value))} />
              </div>
            </div>
            <div className="metric-row">
              <Metric label={t("filterEnabled")} value={boolString(filter.enabled)} />
              <Metric label={t("filterMedian")} value={filter.median ?? "-"} />
              <Metric label={t("filterAlpha")} value={filter.alpha ?? "-"} />
            </div>
            <div className="actions compact">
              <button className="button primary" type="button"
                disabled={isCommandBusy("set_filter") || !deviceUid || isDeviceOffline}
                onClick={() => void applyFilter()}>
                {isCommandBusy("set_filter") ? t("running") : t("saveFilter")}
              </button>
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
          defaultAnalogPins={boardProfile.defaultAnalogPins}
          defaultSelectPins={boardProfile.defaultSelectPins}
          boardName={boardProfile.hardwareModel}
          supportsPinVisualizer={boardProfile.supportsIoVisualizer}
          overviewAsset={boardProfile.overviewAsset}
          analogPinOrder={boardProfile.analogPinOrder}
          digitalPinOrder={boardProfile.digitalPinOrder}
          analogPinSlots={boardProfile.analogPinSlots}
          digitalPinSlots={boardProfile.digitalPinSlots}
          analogHeading={boardProfile.analogPinHeading}
          digitalHeading={boardProfile.digitalPinHeading}
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
