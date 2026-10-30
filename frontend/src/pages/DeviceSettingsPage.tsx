import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { api, type PressureCalReadings, type PressureCalServerPreset } from "../lib/api";

import { useI18n } from "../i18n";
import { V15F_HARDWARE_MODEL, boardProfileForHardwareModel, displayHardwareModel, manifestUrlForHardwareModel } from "../lib/boardProfile";
import { actionButtonActionsForGesture, buildActionButtonCommand, normalizeActionButtonStatus, type ActionButtonAction, type ActionButtonGesture } from "../lib/actionButton";
import { BATTERY_PRESETS, batteryCapacityChoiceFor, batteryIndicatorState, batteryLedThresholdValidationError, batteryPresetFor, type BatteryCapacityChoice, batteryProfileSetupRequired, batteryProfileValidationError, buildBatteryGaugeResyncCommand, buildBatteryLedThresholdCommand, buildBatteryProfileCommand, durationLabel, estimateBatteryTime, normalizeBatteryStatus } from "../lib/batteryProfile";
import { isHubRelayed, normalizeDevice, updateTransferProgress, useDevicesPolling } from "../lib/device";
import { pollDeviceCommand, quietCommand, useDeviceCommand } from "../lib/deviceCommand";
import { appHref } from "../lib/runtime";
import { storageSnapshotFromDevice } from "../lib/storageStatus";
import { BoardIoModal } from "./TerminalPage";
import { BatteryStatusIndicator } from "../components/BatteryStatusIndicator";
import { ConfirmModal } from "../components/ConfirmModal";
import { CalibrationWorkbench, type CalibrationRun } from "../components/calibration/CalibrationWorkbench";
import { DeviceAppsPanel } from "../components/DeviceAppsPanel";
import { DeviceClockCard } from "../components/DeviceClockCard";
import { DeviceHealthCard } from "../components/DeviceHealthCard";
import { ScanHealthCard } from "../components/ScanHealthCard";
import { compareVersionCores, normalizeUpdateChannel, waitingForStableToCatchUp, type UpdateChannel } from "../lib/versioning";
import { Battery, Check, CircleOff, Lightbulb, Power, TriangleAlert, X } from "lucide-react";
import { Markdown } from "../components/Markdown";
import { Select, type SelectChangeEvent } from "../components/Select";

// Spike-validated (firmware/spikes/README.md's "PHY rate config" section,
// 2026-08-06: raw ADC off + 40fps ran clean at 0% loss over ESP-NOW once
// the link was configured to WIFI_PHY_RATE_MCS3_LGI in NewHorizonsOS-OTA
// v0.12.1 / New-Horizons-Hub v0.1.1 -- the earlier default-rate ceiling
// topped out around 24fps), not an arbitrary UI choice.
const DIRECT_STABILITY_FPS = 40;

const STANDARD_LOG_BYTES = 12 * 1024;
const EXTENDED_LOG_BYTES = 24 * 1024;
const DEFAULT_EXTERNAL_LED_BRIGHTNESS = 0.35;
const DEFAULT_BOARD_LED_BRIGHTNESS = 0.30;
const BOARD_LED_BRIGHTNESS_OPTIONS = [0.1, 0.2, 0.3, 0.5, 1] as const;
const EXTERNAL_LED_BRIGHTNESS_OPTIONS = [
  { value: 0.1, labelKey: "brightnessOption_10" },
  { value: 0.2, labelKey: "brightnessOption_20" },
  { value: 0.35, labelKey: "brightnessOption_35" },
  { value: 0.5, labelKey: "brightnessOption_50" },
  { value: 1, labelKey: "brightnessOption_100_danger" },
] as const;
const STATUS_DRIVEN_SECTIONS: SettingsSection[] = ["overview", "hardware", "runtime", "update", "diagnostics", "files", "experimental"];

type SettingsSection =
  | "overview"
  | "hardware"
  | "action_button"
  | "runtime"
  | "update"
  | "clock"
  | "maintenance"
  | "diagnostics"
  | "files"
  | "apps"
  | "experimental";

// How long a result toast stays up; its bottom bar runs down over the same time.
const TOAST_MS = 3200;

type OperationLogEntry = {
  id: number;
  label: string;
  command: string;
  message: string;
  ok: boolean;
  time: string;
};

// The toast's second line. A result that only echoes the command or a bare
// status word ("status", "ok") says nothing the icon does not, so it reads
// "Done" instead; failures always show what came back.
function toastDetail(entry: OperationLogEntry, t: (key: string) => string) {
  const message = entry.message.trim();
  const echo = [entry.command, entry.label, "ok", "success"].some((word) => word && message.toLowerCase() === word.toLowerCase());
  if (entry.ok && (!message || echo)) return t("toastDone");
  return message;
}

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

function boardLedBrightnessValue(value: unknown) {
  const parsed = numberValue(value, DEFAULT_BOARD_LED_BRIGHTNESS);
  return BOARD_LED_BRIGHTNESS_OPTIONS.includes(parsed as typeof BOARD_LED_BRIGHTNESS_OPTIONS[number])
    ? parsed
    : DEFAULT_BOARD_LED_BRIGHTNESS;
}

function hasIndicatorData(value: unknown) {
  const indicators = recordValue(value);
  return Object.keys(recordValue(indicators.board_led)).length > 0 || Object.keys(recordValue(indicators.battery_led)).length > 0 || Object.keys(recordValue(indicators.external_led)).length > 0 || Object.keys(recordValue(indicators.oled)).length > 0;
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

// Facts read from the device: label on the left, value on the right.
function FactList({ items }: { items: [string, unknown][] }) {
  return (
    <dl className="settings-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{stringValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

// Raw readings and rarely changed settings, one click away so the main
// controls stay readable.
function MoreDetails({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="settings-more">
      <summary>{label}</summary>
      <div className="settings-more-body">{children}</div>
    </details>
  );
}

type DeviceCommandResult = {
  queued?: unknown;
  result?: Record<string, unknown> | null;
};

// ---------------------------------------------------------------------------
// Pressure Calibration Panel
// ---------------------------------------------------------------------------

const PRESSURE_CAL_PRESETS: Record<string, number[]> = {
  quick:    [6, 12, 20],
  standard: [6, 10, 15, 20, 25],
  detailed: [6, 8, 10, 12, 15, 18, 20, 25],
  fine:     [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28],
  experiment: [2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10.5, 12, 13.5, 15, 16.5, 18, 19, 20],
};
// 平台上限：腔體熱熔膠密封約 30 kPa 會漏，28 kPa 保壓 5 分鐘無漂移（2026-09-25）。
const PRESSURE_MAX_KPA = 28;
// 無加壓狀態下 MPX 讀數約 0.384 kPa（tare/0 點基準）。舊值 3.5 是 MPX Vs 誤接 Vin
// （讀數 ×2.19、零點 3.426）時的數字，2026-09-25 改接 5 V 後不再適用。
const PRESSURE_BASELINE_KPA = 0.5;
// 結束後的殘壓安全測試：嘗試穩定在此壓力，達標代表殘壓仍高、不可安全關閉氣壓控制。
const PRESSURE_RESIDUAL_TEST_KPA = 5;
const PRESSURE_RESIDUAL_TEST_TIMEOUT_MS = 15000;
// The procedure below follows the paper's sweep script
// (air_pressure_patent/lab_tools/run_sweep.py): stable = within 0.5 kPa for 5
// polls 0.5 s apart, giving up after 90 s and carrying on with a warning.
const PRESSURE_STABLE_TOLERANCE_KPA = 0.5;
const PRESSURE_STABLE_CONFIRMATION_SAMPLES = 5;
const PRESSURE_STABLE_SAMPLE_INTERVAL_MS = 500;
const PRESSURE_STABLE_TIMEOUT_MS = 90000;
// Preconditioning: N cycles to 20 kPa gauge, held 5 s, vented below 0.3 kPa.
const PRESSURE_PRELOAD_DEFAULT_CYCLES = 8;
const PRESSURE_PRELOAD_KPA = 20;
const PRESSURE_PRELOAD_HOLD_MS = 5000;
const PRESSURE_VENT_GAUGE_KPA = 0.3;
const PRESSURE_VENT_TIMEOUT_MS = 120000;
// Venting is the intake shut and the chamber leaking down; a rise this big
// means the intake is not shut.
const PRESSURE_VENT_RISE_ABORT_KPA = 1.5;
// Each plateau is held 15 s and its value taken over the last 10 s: hold
// 5 s, then capture for 10 s while sampling the pressure. The zero is taken
// the same way at the baseline.
const PRESSURE_PLATEAU_HOLD_MS = 5000;
const PRESSURE_WINDOW_MS = 10000;
const PRESSURE_ZERO_HOLD_MS = 10000;
// A capture blocks the device for its duration before it answers.
const PRESSURE_CAPTURE_TIMEOUT_MARGIN_MS = 40000;
const PRESSURE_OVERSHOOT_ABORT_KPA = 2.0;
const PRESSURE_OVERSHOOT_ABORT_SAMPLES = 3;
const PRESSURE_POST_CAL_HOLD_KPA = PRESSURE_BASELINE_KPA;
const PRESSURE_POST_CAL_HOLD_SETTLE_MS = 3000;

type PressureCalPhase =
  | "idle" | "starting_session" | "holding_baseline" | "preloading" | "setting_pressure" | "stabilizing"
  | "capturing" | "stopping_pressure" | "committing" | "done" | "error" | "aborting"
  | "awaiting_compressor_off" | "testing_residual" | "residual_unsafe" | "safe_done";

type PressureStableResult = {
  referenceN: number | null;
  reason: "strict" | "timeout" | "manual_confirm";
  settledKpa: number | null;
  elapsedMs: number;
};

function medianOf(values: number[]) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function meanOf(values: number[]) {
  return values.length === 0 ? NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

class PressureCalAborted extends Error {
  constructor() {
    super("aborted");
  }
}

function PressureCalibrationPanel({ t, deviceUid, run }: { t: (key: string) => string; deviceUid: string; run: CalibrationRun }) {
  const [phase, setPhase] = useState<PressureCalPhase>("idle");
  const [pointIndex, setPointIndex] = useState(0);
  const [points, setPoints] = useState<number[]>(PRESSURE_CAL_PRESETS.experiment);
  const [preloadCycles, setPreloadCycles] = useState(PRESSURE_PRELOAD_DEFAULT_CYCLES);
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
  const [presetKey, setPresetKey] = useState("experiment");
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
      case "preloading":        return t("pressureCalStatePreloading");
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

  function handlePresetChange(e: SelectChangeEvent) {
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
    const startedAt = Date.now();
    while (true) {
      if (abortRef.current) throw new PressureCalAborted();
      if (manualConfirmRef.current) {
        const manual = manualConfirmRef.current;
        manualConfirmRef.current = null;
        return { ...manual, elapsedMs: Date.now() - startedAt };
      }
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= PRESSURE_STABLE_TIMEOUT_MS) {
        // The paper's script logs this and carries on; so does this.
        return { referenceN: lastReferenceN, reason: "timeout", settledKpa: lastKpa, elapsedMs };
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

        // UNO safety clamp: the firmware closes the intake but PRESERVES the target
        // and auto-recovers via hysteresis. Do NOT re-issue the target here — a fresh
        // PSET would reset hold_mode back to Boost and spike from the high pressure.
        // Just surface the warning and keep waiting; the firmware resumes climbing.
        if (r.uno.safety_latched) {
          setSafetyLatchedWarning(true);
          stableCountRef.current = 0;
          addLogRef.current?.(`Safety clamp active at ${r.uno.pressure_kpa.toFixed(2)} kPa — holding, will auto-resume.`);
          await sleep(PRESSURE_STABLE_SAMPLE_INTERVAL_MS);
          continue;
        }
        setSafetyLatchedWarning(false);

        if (
          r.uno.valve_open
          && r.uno.pressure_kpa > targetKpa + PRESSURE_OVERSHOOT_ABORT_KPA
        ) {
          overshootCountRef.current++;
          if (overshootCountRef.current >= PRESSURE_OVERSHOOT_ABORT_SAMPLES) {
            throw new Error(`pressure_runaway_detected target=${targetKpa.toFixed(2)} current=${r.uno.pressure_kpa.toFixed(2)}`);
          }
        } else {
          overshootCountRef.current = 0;
        }
        if (Math.abs(r.uno.pressure_kpa - targetKpa) < PRESSURE_STABLE_TOLERANCE_KPA) {
          stableCountRef.current++;
          if (stableCountRef.current >= PRESSURE_STABLE_CONFIRMATION_SAMPLES) {
            return { referenceN: lastReferenceN, reason: "strict", settledKpa: r.uno.pressure_kpa, elapsedMs };
          }
        } else {
          stableCountRef.current = 0;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("pressure_runaway_detected")) throw error;
        /* a missed reading: try again */
      }
      await sleep(PRESSURE_STABLE_SAMPLE_INTERVAL_MS);
    }
  }

  // Sets the target and waits for it, as the paper's settle() does.
  async function settleAt(targetKpa: number) {
    stableCountRef.current = 0;
    overshootCountRef.current = 0;
    manualConfirmRef.current = null;
    await api.pressureCalSetTarget(targetKpa);
    return waitForStable(targetKpa);
  }

  // Keeps polling (so the live readout moves) for `ms`; returns the samples.
  async function sampleFor(ms: number) {
    const samples: number[] = [];
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (abortRef.current) throw new PressureCalAborted();
      try {
        const r = await api.pressureCalReadings();
        setCurrentKpa(r.uno.pressure_kpa);
        samples.push(r.uno.pressure_kpa);
      } catch { /* a missed reading */ }
      await sleep(PRESSURE_STABLE_SAMPLE_INTERVAL_MS);
    }
    return samples;
  }

  // The paper's to_zero(): back to the baseline target -- the intake shuts
  // and the chamber leaks down -- until the gauge reads under 0.3 kPa.
  async function ventToZero(zeroKpa: number) {
    let start: number | null = null;
    await api.pressureCalSetTarget(PRESSURE_BASELINE_KPA);
    const until = Date.now() + PRESSURE_VENT_TIMEOUT_MS;
    while (Date.now() < until) {
      if (abortRef.current) throw new PressureCalAborted();
      try {
        const r = await api.pressureCalReadings();
        setCurrentKpa(r.uno.pressure_kpa);
        const gauge = r.uno.pressure_kpa - zeroKpa;
        start ??= gauge;
        if (gauge > start + PRESSURE_VENT_RISE_ABORT_KPA) {
          throw new Error(`pressure_rising_while_venting ${start.toFixed(2)} -> ${gauge.toFixed(2)} kPa`);
        }
        if (gauge < PRESSURE_VENT_GAUGE_KPA) return;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("pressure_rising_while_venting")) throw error;
      }
      await sleep(PRESSURE_STABLE_SAMPLE_INTERVAL_MS);
    }
    addLogRef.current?.(`Vent did not reach ${PRESSURE_VENT_GAUGE_KPA} kPa within ${PRESSURE_VENT_TIMEOUT_MS / 1000} s; continuing.`);
  }

  // A device command that must succeed; throws its error code otherwise.
  async function deviceCommand(label: string, payload: Record<string, unknown>, timeoutMs = 20000) {
    const response = await run(label, payload, timeoutMs, { waitForLock: true });
    const result = response.result;
    if (!result || result.status === "error" || result.ok === false) {
      throw new Error(String(result?.error || result?.message || "no_response"));
    }
    return result;
  }

  // Runs a capture while sampling the pressure over the same window.
  async function captureWithWindow(label: string, payload: Record<string, unknown>) {
    let finished = false;
    const capture = deviceCommand(label, payload, PRESSURE_WINDOW_MS + PRESSURE_CAPTURE_TIMEOUT_MARGIN_MS)
      .finally(() => { finished = true; });
    const samples: number[] = [];
    while (!finished) {
      try {
        const r = await api.pressureCalReadings();
        setCurrentKpa(r.uno.pressure_kpa);
        samples.push(r.uno.pressure_kpa);
      } catch { /* a missed reading */ }
      await sleep(PRESSURE_STABLE_SAMPLE_INTERVAL_MS);
    }
    const result = await capture;
    return { result, samples };
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
    let sessionStarted = false;

    try {
      setPhase("starting_session");
      setActiveTargetKpa(null);
      addLog("Entering maintenance and starting a calibration session…");
      await deviceCommand(t("enterMaintenance"), { command: "enter_maintenance", reason: "calibration" });
      await deviceCommand(t("pressureCalStateStartingSession"), { command: "calibration_session_begin" });
      sessionStarted = true;

      // A first zero estimate, for the preconditioning targets and venting.
      setPhase("holding_baseline");
      setActiveTargetKpa(PRESSURE_BASELINE_KPA);
      addLog(`Holding at baseline ${PRESSURE_BASELINE_KPA} kPa…`);
      await settleAt(PRESSURE_BASELINE_KPA);
      let zeroKpa = medianOf(await sampleFor(5000));
      addLog(`Zero estimate ${zeroKpa.toFixed(3)} kPa.`);

      for (let cycle = 1; cycle <= preloadCycles; cycle++) {
        setPhase("preloading");
        const target = PRESSURE_PRELOAD_KPA + zeroKpa;
        setActiveTargetKpa(target);
        addLog(`Preload ${cycle}/${preloadCycles}: ${PRESSURE_PRELOAD_KPA} kPa…`);
        const stability = await settleAt(target);
        if (stability.reason === "timeout") addLog(`  not strictly stable after ${PRESSURE_STABLE_TIMEOUT_MS / 1000} s; continuing.`);
        await sampleFor(PRESSURE_PRELOAD_HOLD_MS);
        setActiveTargetKpa(PRESSURE_BASELINE_KPA);
        await ventToZero(zeroKpa);
      }

      // The zero: hold the baseline, then take the baseline capture (the
      // tare) and the pressure zero over the same window.
      setPhase("holding_baseline");
      setActiveTargetKpa(PRESSURE_BASELINE_KPA);
      await settleAt(PRESSURE_BASELINE_KPA);
      await sampleFor(PRESSURE_ZERO_HOLD_MS);
      setPhase("capturing");
      addLog("Capturing the baseline…");
      const zero = await captureWithWindow(t("pressureCalStateCapturing"), {
        command: "calibration_capture_tare",
        duration_ms: PRESSURE_WINDOW_MS,
      });
      zeroKpa = medianOf(zero.samples);
      addLog(`Baseline captured. Pressure zero ${zeroKpa.toFixed(3)} kPa (median of ${zero.samples.length} readings).`);

      const timedOut: number[] = [];
      for (let i = 0; i < sortedPoints.length; i++) {
        const level = sortedPoints[i];
        const target = level + zeroKpa;
        setPointIndex(i);
        setActiveTargetKpa(target);

        setPhase("stabilizing");
        addLog(`Level ${level} kPa (target ${target.toFixed(3)})…`);
        const stability = await settleAt(target);
        if (stability.reason === "timeout") {
          timedOut.push(level);
          addLog(`  not strictly stable after ${PRESSURE_STABLE_TIMEOUT_MS / 1000} s; continuing.`);
        } else if (stability.reason === "manual_confirm") {
          addLog(`Manual confirm at target ${target.toFixed(3)} kPa, UNO ${stability.settledKpa?.toFixed(3) ?? "-"} kPa, reference sensor ${stability.referenceN?.toFixed(3) ?? "-"} ${currentImadaUnit}`);
        }
        await sampleFor(PRESSURE_PLATEAU_HOLD_MS);

        setPhase("capturing");
        const plateau = await captureWithWindow(t("pressureCalStateCapturing"), {
          command: "calibration_capture_all",
          level,
          duration_ms: PRESSURE_WINDOW_MS,
        });
        // The reference is what the chamber actually held over the capture.
        const reference = meanOf(plateau.samples) - zeroKpa;
        if (Number.isFinite(reference)) {
          await deviceCommand(t("pressureCalStateCapturing"), {
            command: "calibration_set_reference",
            level,
            reference: Number(reference.toFixed(3)),
          });
        }
        addLog(`  captured; reference ${Number.isFinite(reference) ? reference.toFixed(3) : "-"} kPa.`);
      }

      setPhase("committing");
      addLog("Saving…");
      let committed: Record<string, unknown>;
      try {
        committed = await deviceCommand(t("pressureCalStateCommitting"), { command: "calibration_session_commit", auto_enable: true });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "calibration_incomplete") throw error;
        // Keep what was captured even though some sensors cannot be fitted.
        committed = await deviceCommand(t("pressureCalStateCommitting"), { command: "calibration_session_commit", auto_enable: false });
        addLog("Saved, but not every sensor could be fitted, so calibration is not switched on.");
      }
      sessionStarted = false;
      const fit = (committed.data as Record<string, unknown> | undefined)?.fit as Record<string, unknown> | undefined;
      if (fit) addLog(`Fitted ${String(fit.cells_fitted ?? "?")}/${String(fit.cells_total ?? "?")} sensors.`);
      if (timedOut.length) addLog(`Levels that never met the strict stability rule: ${timedOut.join(", ")} kPa.`);

      addLog("Returning pressure system to baseline hold…");
      setActiveTargetKpa(PRESSURE_POST_CAL_HOLD_KPA);
      await api.pressureCalSetTarget(PRESSURE_POST_CAL_HOLD_KPA);
      await sleep(PRESSURE_POST_CAL_HOLD_SETTLE_MS);

      addLog("Calibration complete! Holding at baseline. Please turn OFF the air compressor.");
      // Hold at baseline and ask the user (full-screen) to turn off the compressor.
      // The residual-pressure safety test runs only after they confirm.
      setPhase("awaiting_compressor_off");
      setShowCompressorOffModal(true);
    } catch (err) {
      const aborted = err instanceof PressureCalAborted;
      const msg = err instanceof Error ? err.message : String(err);
      if (aborted) {
        setPhase("aborting");
        addLog("Aborting…");
      } else {
        setCalError(msg);
        addLog(`Error: ${msg}`);
      }
      if (sessionStarted) {
        try { await deviceCommand(t("pressureCalSessionAborted"), { command: "calibration_session_abort" }); } catch { /* ignore */ }
        addLog(t("pressureCalSessionAborted"));
      }
      // Never stop pressure control here: with the compressor still on, a
      // stop can open the intake (see the residual test below). Return to
      // the baseline hold instead and take the same compressor-off route a
      // finished calibration takes.
      setActiveTargetKpa(PRESSURE_BASELINE_KPA);
      try { await api.pressureCalSetTarget(PRESSURE_BASELINE_KPA); } catch { /* ignore */ }
      setPhase(aborted ? "awaiting_compressor_off" : "error");
      setShowCompressorOffModal(true);
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
      {/* Titled by the collapsible section CalibrationWorkbench puts it in. */}
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
            <Select value={selectedPreset} onChange={(e) => setSelectedPreset(e.target.value)} disabled={isRunning}>
              {serverPresets.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
              <option value="custom">{t("pressureCalServerCustom")}</option>
            </Select>
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
            <Select value={presetKey} onChange={handlePresetChange} disabled={isRunning}>
              {Object.keys(PRESSURE_CAL_PRESETS).map((key) => (
                <option key={key} value={key}>
                  {t(`pressureCalPreset${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
                </option>
              ))}
              <option value="custom">{t("pressureCalPresetCustom")}</option>
            </Select>
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
        <div className="field-grid">
          <div className="field">
            <label>{t("pressureCalPreloadCycles")}</label>
            <input
              type="number"
              min={0}
              max={20}
              step={1}
              value={preloadCycles}
              disabled={isRunning}
              onChange={(e) => setPreloadCycles(Math.max(0, Math.min(20, Math.round(Number(e.target.value) || 0))))}
            />
            <span className="field-hint">{t("pressureCalPreloadHint")}</span>
          </div>
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

export function DeviceSettingsPage() {
  const { t } = useI18n();
  const { deviceUid = "" } = useParams();
  const { devices, refresh } = useDevicesPolling();
  const { queue, errorMessage } = useDeviceCommand(deviceUid);
  const device = useMemo(() => devices.find((item) => item.device_uid === deviceUid), [devices, deviceUid]);
  const normalized = device ? normalizeDevice(device) : null;
  const isDeviceOffline = normalized?.isOffline === true;
  const isControlUnavailable = normalized?.isControlUnavailable === true;
  /*
    Legacy offline-only guards kept here as regression breadcrumbs while reconnecting
    now also disables live queries and control:
    if (!ramMonitorEnabled || !deviceUid || isDeviceOffline) return undefined;
    if (!deviceUid || !shouldAutoRefreshStatusForSection(activeSection) || isDeviceOffline)
    if (activeSection !== "hardware" || !deviceUid || busyCommand || isDeviceOffline) return;
    if (activeSection !== "hardware" || !deviceUid || isDeviceOffline)
    if (!deviceUid || isDeviceOffline) return;
    disabled={isCommandBusy("status") || !deviceUid || isDeviceOffline}
    disabled={isCommandBusy("findme_discover") || !deviceUid || isDeviceOffline}
    disabled={isCommandBusy("storage_status") || !deviceUid || isDeviceOffline}
    disabled={busyCommand === "calibration_status" || !deviceUid || isDeviceOffline}
  */
  const connectionLabel =
    normalized?.connectionState === "reconnecting"
      ? t("reconnecting")
      : normalized?.connectionState === "offline"
        ? t("offline")
        : normalized?.mode ?? "-";
  const inMaintenanceMode = normalized?.mode === "maintenance" || normalized?.mode === "safe_maintenance";
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
  const batteryStatus = recordValue(status.battery ?? (["set_charge_profile", "set_battery_profile", "resync_battery_gauge", "battery_status"].includes(lastResultCommand) ? lastResult.battery : undefined));
  const battery = normalizeBatteryStatus(batteryStatus);
  const powerStatus = recordValue(status.power ?? (lastResultCommand === "power_set_state" || lastResultCommand === "battery_status" ? lastResult.power : undefined));
  const actionButton = normalizeActionButtonStatus(
    status.action_button ?? (lastResultCommand === "set_action_button" ? lastResult.action_button : undefined),
  );
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
  const streamRawAdcEnabled = (status.stream_raw_adc ?? runtime.stream_raw_adc ?? (lastResultCommand === "set_raw_adc" ? lastResult.stream_raw_adc : undefined)) === true;
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
  const boardLed = recordValue(indicators.board_led);
  const batteryLed = recordValue(indicators.battery_led);
  const externalLed = recordValue(indicators.external_led);
  const oled = recordValue(indicators.oled);
  const updateState = recordValue(status.update_state ?? device?.update_state ?? (lastResultCommand === "check_update" ? lastResult.update_state : undefined));
  const updateChangelogUrl = stringValue(updateState.changelog_url ?? (lastResultCommand === "check_update" ? lastResult.changelog_url : undefined), "");

  const [activeSection, setActiveSection] = useState<SettingsSection>("overview");
  // The Mode overview card's dropdown: a pending choice, applied explicitly.
  // Follows the device's reported mode whenever that changes.
  const currentMode = normalized?.mode ?? "";
  const [modeDraft, setModeDraft] = useState(currentMode);
  useEffect(() => {
    setModeDraft(currentMode);
  }, [currentMode, deviceUid]);
  const boardProfile = useMemo(() => boardProfileForHardwareModel(normalized?.hardwareModel), [normalized?.hardwareModel]);
  const powerStatusCopy = boardProfile.powerUx === "remote_only" ? t("powerStatusCopyRemoteOnly") : boardProfile.hardwareModel === V15F_HARDWARE_MODEL ? t("powerStatusCopyV15") : t("powerStatusCopy");
  const pinLayoutCopy = boardProfile.powerUx === "remote_only" ? t("pinLayoutCopyGcu") : t("pinLayoutCopyV1");
  // Firmware with update channels reports ota.channel. There, manifestUrl is
  // only an optional custom override (empty = follow the channel); on older
  // firmware it is the manifest itself, as before.
  const otaChannelSupported = typeof otaConfig.channel === "string";
  const deviceUpdateChannel = normalizeUpdateChannel(otaConfig.channel);
  const [manifestUrl, setManifestUrl] = useState(() => (otaChannelSupported ? "" : manifestUrlForHardwareModel(normalized?.hardwareModel)));
  const [showCustomManifest, setShowCustomManifest] = useState(false);
  const [confirmBetaChannel, setConfirmBetaChannel] = useState(false);
  // Restart and Clear logs ask first; one dialog serves both.
  const [pendingConfirm, setPendingConfirm] = useState<{ title: string; message: string; confirmLabel: string; action: () => void } | null>(null);
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
  const [batteryCapacityChoice, setBatteryCapacityChoice] = useState<BatteryCapacityChoice>("400");
  const [customBatteryCapacity, setCustomBatteryCapacity] = useState("");
  const [maxBatteryChargeCurrent, setMaxBatteryChargeCurrent] = useState("100");
  const batteryProfileDraftError = batteryProfileValidationError(batteryCapacityChoice, customBatteryCapacity, maxBatteryChargeCurrent);
  // Fill the manual battery form from what the device already has, once per
  // device, so editing it starts from the saved values rather than defaults.
  const batteryDraftSeededForRef = useRef("");
  useEffect(() => {
    if (!deviceUid || batteryDraftSeededForRef.current === deviceUid) return;
    if (battery.profileResolved !== true || battery.capacityMah === null || battery.maxChargeCurrentMa === null) return;
    batteryDraftSeededForRef.current = deviceUid;
    const choice = batteryCapacityChoiceFor(battery.capacityMah, battery.maxChargeCurrentMa);
    setBatteryCapacityChoice(choice);
    if (choice === "custom") setCustomBatteryCapacity(String(battery.capacityMah));
    setMaxBatteryChargeCurrent(String(battery.maxChargeCurrentMa));
  }, [battery.capacityMah, battery.maxChargeCurrentMa, battery.profileResolved, deviceUid]);
  const [lowBatteryThresholdPercent, setLowBatteryThresholdPercent] = useState(stringValue(batteryLed.low_battery_threshold_percent, "10"));
  const batteryLedThresholdDraftError = batteryLedThresholdValidationError(Number(lowBatteryThresholdPercent));
  const [imuEnabled, setImuEnabled] = useState(imu.enabled !== false);
  const [filterEnabled, setFilterEnabled] = useState(filter.enabled === true);
  const [filterMedian, setFilterMedian] = useState(numberValue(filter.median, 3));
  const [filterAlpha, setFilterAlpha] = useState(numberValue(filter.alpha, 0.25));
  const [rawAdcEnabled, setRawAdcEnabled] = useState(streamRawAdcEnabled);
  const [logEnabled, setLogEnabled] = useState(logging.enabled !== false);
  const [logLevel, setLogLevel] = useState(stringValue(logging.level, "error"));
  const [logMode, setLogMode] = useState(stringValue(logging.mode, "standard"));
  const [externalLedMode, setExternalLedMode] = useState(stringValue(externalLed.mode, "off"));
  const [boardLedBrightness, setBoardLedBrightness] = useState(boardLedBrightnessValue(boardLed.brightness));
  const [brightness, setBrightness] = useState(externalLedBrightnessValue(externalLed.brightness));
  const [externalPreset, setExternalPreset] = useState(stringValue(externalLed.preset, "system_status"));
  const [externalColor, setExternalColor] = useState(stringValue(externalLed.color, "teal"));
  const [oledMode, setOledMode] = useState(stringValue(oled.mode, "off"));
  const [oledPage, setOledPage] = useState(stringValue(oled.page, "live_status"));
  const [oledUpdateHz, setOledUpdateHz] = useState(numberValue(oled.update_hz, 1));
  const [oledContrast, setOledContrast] = useState(numberValue(oled.contrast, 128));
  const [oledRotation, setOledRotation] = useState(numberValue(oled.rotation, 0));
  const [actionButtonShortPress, setActionButtonShortPress] = useState<ActionButtonAction>(actionButton.shortPress ?? "none");
  const [actionButtonLongPress, setActionButtonLongPress] = useState<ActionButtonAction>(actionButton.longPress ?? "soft_off");
  const [actionButtonDraftTouched, setActionButtonDraftTouched] = useState(false);
  const batteryChargeState = stringValue(powerStatus.charge_state ?? batteryStatus.charge_state, "");
  const batteryGaugeSyncing = battery.syncState === "syncing";
  const batteryGaugeSyncFailed = battery.syncState === "error";
  const batteryTimeEstimate = estimateBatteryTime(battery, batteryChargeState);
  const batteryIndicator = batteryIndicatorState(
    boardProfile.supportsBatteryPercentageIndicator,
    battery.socPercent,
    batteryChargeState === "charging" && !batteryGaugeSyncing,
  );
  const batteryLedSupported = boardProfile.supportsBatteryStatusLed && batteryLed.supported === true;
  const [showIoModal, setShowIoModal] = useState(false);
  const [showWifiSetupRebootModal, setShowWifiSetupRebootModal] = useState(false);
  const [deviceGroupDraft, setDeviceGroupDraft] = useState(stringValue(device?.device_group, ""));
  const [deviceGroupSaving, setDeviceGroupSaving] = useState(false);
  const [ramMonitorEnabled, setRamMonitorEnabled] = useState(false);
  const [ramRefreshInFlight, setRamRefreshInFlight] = useState(false);
  const [ramLastUpdated, setRamLastUpdated] = useState("");
  const ramRefreshInFlightRef = useRef(false);
  const [operationToast, setOperationToast] = useState<OperationLogEntry | null>(null);
  const [operationLog, setOperationLog] = useState<OperationLogEntry[]>([]);
  const [busyCommand, setBusyCommand] = useState("");
  // The actual mutex for run() below -- busyCommand (React state) is only
  // updated asynchronously, so two effects that both read busyCommand==""
  // in the same tick can both decide to call run() before either's
  // setBusyCommand("...") commits. This ref is checked-and-set
  // synchronously at the top of run(), so at most one command is ever
  // in flight for this device from the frontend at a time.
  // The package registry arrived in firmware v1.1.0; on anything older the
  // install and package controls are hidden rather than shown and then failing.
  const supportsAppRegistry =
    !normalized?.firmwareVersion || compareVersionCores(normalized.firmwareVersion, "v1.1.0") >= 0;
  const commandInFlightRef = useRef(false);
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

  // Most used first. Action Button and Clock have no tab of their own: they
  // are shown inside Hardware and Streaming (renderActiveSection).
  const sections: { id: SettingsSection; label: string }[] = [
    { id: "overview", label: t("settingsSection_overview") },
    { id: "maintenance", label: t("settingsSection_maintenance") },
    { id: "apps", label: t("settingsSection_apps") },
    { id: "hardware", label: t("settingsSection_hardware") },
    { id: "runtime", label: t("settingsSection_runtime") },
    { id: "update", label: t("settingsSection_update") },
    { id: "diagnostics", label: t("settingsSection_diagnostics") },
    { id: "files", label: t("settingsSection_files") },
    { id: "experimental", label: t("settingsSection_experimental") },
  ];
  const actionButtonDraftDirty = actionButtonShortPress !== (actionButton.shortPress ?? "none") ||
    actionButtonLongPress !== (actionButton.longPress ?? "soft_off");

  useEffect(() => {
    if (boardLed.brightness !== undefined) setBoardLedBrightness(boardLedBrightnessValue(boardLed.brightness));
  }, [boardLed.brightness]);

  useEffect(() => {
    setDeviceGroupDraft(stringValue(device?.device_group, ""));
  }, [device?.device_group, deviceUid]);

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
    setRawAdcEnabled(streamRawAdcEnabled);
  }, [deviceUid, streamRawAdcEnabled]);

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
    if (otaChannelSupported) {
      setManifestUrl(nextManifestUrl);
      if (nextManifestUrl) setShowCustomManifest(true);
      return;
    }
    if (nextManifestUrl) {
      setManifestUrl(nextManifestUrl);
      return;
    }
    setManifestUrl(manifestUrlForHardwareModel(normalized?.hardwareModel));
  }, [normalized?.hardwareModel, otaChannelSupported, otaConfig.auto_apply_on_boot, otaConfig.manifest_url]);

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
    if (batteryLed.low_battery_threshold_percent !== undefined) {
      setLowBatteryThresholdPercent(stringValue(batteryLed.low_battery_threshold_percent, "10"));
    }
  }, [batteryLed.low_battery_threshold_percent]);

  useEffect(() => {
    const nextExternalMode = stringValue(externalLed.mode, "");
    if (nextExternalMode) setExternalLedMode(nextExternalMode);
    const nextPreset = stringValue(externalLed.preset, "");
    if (nextPreset) setExternalPreset(nextPreset);
    const nextColor = stringValue(externalLed.color, "");
    if (nextColor) setExternalColor(nextColor);
    if (externalLed.brightness !== undefined) setBrightness(externalLedBrightnessValue(externalLed.brightness));
  }, [externalLed.brightness, externalLed.mode, externalLed.preset, externalLed.color]);

  useEffect(() => {
    const persistedShortPress = actionButton.shortPress ?? "none";
    const persistedLongPress = actionButton.longPress ?? "soft_off";
    const persistedMatchesDraft =
      actionButtonShortPress === persistedShortPress &&
      actionButtonLongPress === persistedLongPress;
    if (!actionButtonDraftTouched || persistedMatchesDraft) {
      setActionButtonShortPress(persistedShortPress);
      setActionButtonLongPress(persistedLongPress);
      setActionButtonDraftTouched(false);
    }
  }, [
    actionButton.longPress,
    actionButton.shortPress,
    actionButtonDraftTouched,
    actionButtonLongPress,
    actionButtonShortPress,
  ]);

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
    }, TOAST_MS);
  }

  function dismissOperationToast() {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = 0;
    }
    setOperationToast(null);
  }

  async function persistDeviceGroup(nextGroup: string) {
    if (!deviceUid) return;
    const trimmed = nextGroup.trim();
    setDeviceGroupSaving(true);
    try {
      await api.saveDeviceGroup(deviceUid, trimmed);
      pushOperationLog({
        id: operationLogIdRef.current++,
        label: trimmed ? t("saveDeviceGroup") : t("clearDeviceGroup"),
        command: "device_group",
        message: trimmed ? t("deviceGroupSaved") : t("deviceGroupCleared"),
        ok: true,
        time: new Date().toLocaleTimeString(),
      });
      await refresh();
      setDeviceGroupDraft(trimmed);
    } catch (error) {
      pushOperationLog({
        id: operationLogIdRef.current++,
        label: trimmed ? t("saveDeviceGroup") : t("clearDeviceGroup"),
        command: "device_group",
        message: error instanceof Error ? error.message : pretty(error),
        ok: false,
        time: new Date().toLocaleTimeString(),
      });
      throw error;
    } finally {
      setDeviceGroupSaving(false);
    }
  }

  async function run(
    label: string,
    payload: Record<string, unknown>,
    timeoutMs = 20000,
    options: { waitForLock?: boolean; background?: boolean } = {},
  ) {
    const command = String(payload.command ?? "");
    if (isControlUnavailable && isLiveQueryCommand(command)) {
      return { queued: null, result: null };
    }
    // Synchronous mutex -- see commandInFlightRef's declaration comment.
    // By default a call skips the dispatch entirely (no log entry) rather
    // than queueing: best-effort refreshes retry on their own next tick.
    // A click that must not be lost (the calibration flow) passes
    // waitForLock instead, so a background poll holding the lock delays it
    // rather than silently eating it.
    if (commandInFlightRef.current && options.waitForLock) {
      const deadline = Date.now() + timeoutMs;
      while (commandInFlightRef.current && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    }
    if (commandInFlightRef.current) {
      return { queued: null, result: null };
    }
    commandInFlightRef.current = true;
    if (options.background) {
      // A repeating read (the Apps tab's live preview): it holds the mutex so
      // it cannot collide with an operator's command -- a Hub relays one
      // command per device at a time -- but it neither logs, nor marks the
      // page busy, nor refetches the device list 2-4 times a second.
      try {
        return await pollDeviceCommand(deviceUid, payload, timeoutMs);
      } finally {
        commandInFlightRef.current = false;
      }
    }
    setBusyCommand(command);
    try {
      const response = await queue(payload, timeoutMs);
      // response.result is null when the client-side timeout fired before
      // any command_result arrived (see wsClient.ts's sendDeviceCommand())
      // -- must be treated as a failure, not defaulted to true just
      // because neither "error" condition below happens to match null.
      const ok = response.result !== null && response.result?.status !== "error" && response.result?.ok !== false;
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
      commandInFlightRef.current = false;
      setBusyCommand("");
    }
  }

  async function refreshRamStatus() {
    // busyCommand check added so this doesn't collide with a manual
    // command in flight -- unlike the other auto-refresh effects below,
    // this one is a repeating interval rather than a one-shot, so the
    // check lives here (checked fresh on every call) instead of an effect
    // dependency array, to avoid tearing down/recreating the interval
    // every time busyCommand changes.
    if (!deviceUid || isControlUnavailable || ramRefreshInFlightRef.current || busyCommand) return;
    ramRefreshInFlightRef.current = true;
    setRamRefreshInFlight(true);
    try {
      await run(t("ramRefresh"), quietCommand({ command: "memory_status" }), 18000);
      setRamLastUpdated(new Date().toLocaleTimeString());
    } catch (error) {
      void error;
    } finally {
      ramRefreshInFlightRef.current = false;
      setRamRefreshInFlight(false);
    }
  }

  useEffect(() => {
    // if (!ramMonitorEnabled || !deviceUid || isDeviceOffline) return undefined;
    if (!ramMonitorEnabled || !deviceUid || isControlUnavailable) return undefined;
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
  }, [deviceUid, isControlUnavailable, ramMonitorEnabled]);

  // While the gauge resyncs, poll once a second -- but only the battery card's
  // slice (battery_status, ~1 KB), not the full ~18 KB status: building that
  // costs the device ~14 ms of main-loop time, a late scan every second.
  // Firmware before v1.14.0 has no battery_status; fall back to status there.
  const batteryStatusUnsupportedRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!batteryGaugeSyncing || !deviceUid || isControlUnavailable) return undefined;
    let cancelled = false;
    const intervalId = window.setInterval(() => {
      if (cancelled || commandInFlightRef.current) return;
      if (batteryStatusUnsupportedRef.current[deviceUid]) {
        void run(t("refreshStatus"), quietCommand({ command: "status" }), 18000).catch(() => undefined);
        return;
      }
      void run(t("refreshStatus"), quietCommand({ command: "battery_status" }), 18000, { background: true })
        .then((response) => {
          const result = response?.result as Record<string, unknown> | null | undefined;
          if (result && result.ok === false && String(result.error ?? result.message ?? "") === "unknown_command") {
            batteryStatusUnsupportedRef.current[deviceUid] = true;
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [batteryGaugeSyncing, deviceUid, isControlUnavailable, t]);

  // A Hub-relayed (ESP-NOW) check_update/apply_update only starts the
  // operation; its outcome reaches update_state over the next seconds or
  // minutes. Re-read status while it runs, or the card never shows it.
  const hubRelayed = isHubRelayed(device);
  const updatePhase = String(updateState.phase ?? "");
  const relayedUpdateRunning = hubRelayed && ["checking", "starting", "downloading"].includes(updatePhase);
  useEffect(() => {
    if (!relayedUpdateRunning || !deviceUid || isControlUnavailable) return undefined;
    const intervalId = window.setInterval(() => {
      if (!commandInFlightRef.current) {
        void run(t("refreshStatus"), quietCommand({ command: "status" }), 18000, { background: true }).catch(() => undefined);
      }
    }, 4000);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayedUpdateRunning, deviceUid, isControlUnavailable]);

  useEffect(() => () => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
  }, []);

  useEffect(() => {
    // if (!deviceUid || !shouldAutoRefreshStatusForSection(activeSection) || isDeviceOffline)
    if (!deviceUid || !shouldAutoRefreshStatusForSection(activeSection) || isControlUnavailable) {
      statusDrivenSectionAutoRefreshKeyRef.current = "";
      return;
    }
    const refreshKey = `${deviceUid}:${activeSection}`;
    if (statusDrivenSectionAutoRefreshKeyRef.current === refreshKey || busyCommand) return;
    statusDrivenSectionAutoRefreshKeyRef.current = refreshKey;
    void run(t("refreshStatus"), quietCommand({ command: "status" }), 18000).catch(() => undefined);
  }, [activeSection, busyCommand, deviceUid, isControlUnavailable, t]);

  useEffect(() => {
    if (activeSection !== "hardware" || !deviceUid || busyCommand || isControlUnavailable) return;
    if (analogPinsFromStatus && selectPinsFromStatus) return;
    if (pinStatusAutoRequestedRef.current[deviceUid]) return;
    pinStatusAutoRequestedRef.current[deviceUid] = true;
    void run(t("refreshStatus"), quietCommand({ command: "status" }), 18000).catch(() => undefined);
  }, [activeSection, analogPinsFromStatus, busyCommand, deviceUid, isControlUnavailable, selectPinsFromStatus, t]);

  function runIndicatorsStatusRefresh() {
    if (!deviceUid || isControlUnavailable) return;
    lastIndicatorsStatusAutoRefreshKeyRef.current = `${deviceUid}:hardware`;
    indicatorsStatusAutoRefreshPendingRef.current = false;
    void run(t("refreshStatus"), quietCommand({ command: "status" }), 18000).catch(() => undefined);
  }

  useEffect(() => {
    if (activeSection !== "hardware" || !deviceUid || isControlUnavailable) {
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
  }, [activeSection, busyCommand, deviceUid, isControlUnavailable]);

  function applyScanPreset(fps: number) {
    setScanDraftDirty(true);
    setTargetFps(fps);
    setSettleUs(fps > 60 ? 15 : 20);
    setSendEveryNFrames(1);
  }

  // Unlike the plain presets above, this one also has to guarantee the
  // reduced-bandwidth payload it promises -- lowering fps alone doesn't
  // shrink the frame if raw ADC streaming was left on, so this fires
  // set_raw_adc(false) immediately rather than waiting for the user to
  // notice and fix it in a separate card.
  async function applyDirectStabilityPreset() {
    applyScanPreset(DIRECT_STABILITY_FPS);
    setRawAdcEnabled(false);
    if (rawAdcEnabled) {
      await run(t("saveRawAdc"), { command: "set_raw_adc", enabled: false });
    }
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

  async function applyBatteryProfile() {
    if (batteryProfileDraftError) return;
    try {
      await run(t("saveBatteryProfile"), buildBatteryProfileCommand(batteryCapacityChoice, customBatteryCapacity, maxBatteryChargeCurrent));
    } catch (error) {
      void error;
    }
  }

  async function resyncBatteryGauge() {
    try {
      await run(t("resyncBatteryGauge"), buildBatteryGaugeResyncCommand());
    } catch (error) {
      void error;
    }
  }

  async function applyBatteryLedThreshold() {
    if (batteryLedThresholdDraftError) return;
    try {
      await run(t("saveBatteryLedWarning"), buildBatteryLedThresholdCommand(Number(lowBatteryThresholdPercent)));
    } catch (error) {
      void error;
    }
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

  async function applyRawAdc() {
    await run(t("saveRawAdc"), {
      command: "set_raw_adc",
      enabled: rawAdcEnabled,
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
    // With channels, an empty manifest_url is sent on purpose: it clears a
    // custom URL so the device follows its channel again.
    await run(t("saveUpdateSettings"), {
      command: "set_ota_config",
      auto_apply_on_boot: autoOtaOnBoot,
      manifest_url: otaChannelSupported ? manifestUrl.trim() : manifestUrl,
    });
  }

  // Switching channel saves straight away (beta only after confirming), so
  // the next Check always asks about the channel the selector shows.
  async function setUpdateChannel(channel: UpdateChannel) {
    await run(t("updateChannel"), { command: "set_ota_config", channel });
  }

  // check_update / apply_update: only name a manifest when there is one to
  // name. Without it the device checks its own channel (or custom URL).
  function updateCommand(command: "check_update" | "apply_update") {
    const url = manifestUrl.trim();
    return url ? { command, manifest_url: url } : { command };
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

  async function saveActionButtonSettings() {
    await run(t("saveActionButton"), buildActionButtonCommand(actionButtonShortPress, actionButtonLongPress));
  }

  // Streaming also carries the clock, shown under it. (Hardware renders the
  // v1.5.F Action Button itself, between power and the lights.)
  function renderActiveSection() {
    if (activeSection === "runtime") {
      return (
        <div className="settings-stack">
          {renderSection("runtime")}
          {renderSection("clock")}
        </div>
      );
    }
    return renderSection(activeSection);
  }

  function renderSection(section: SettingsSection) {
    if (section === "overview") {
      const connectionSummary = hubRelayed
        ? t("deviceViaHubLong")
        : device?.client_type === "gateway" || findme.gateway_id
          ? t("deviceViaGatewayLong")
          : t("offline");
      const relayId = hubRelayed ? device?.gateway_id : findme.gateway_id;
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_overview")}</h3>
            </div>
            <button className="button" type="button" disabled={isCommandBusy("status") || !deviceUid || isControlUnavailable} onClick={() => void run(t("refreshStatus"), { command: "status" })}>
              {isCommandBusy("status") ? t("running") : t("refreshStatus")}
            </button>
          </div>

          <div className="settings-hero">
            <div className="settings-hero-item">
              <div className="battery-overview-icon" aria-hidden={batteryIndicator ? undefined : true}>
                {batteryIndicator ? (
                  <BatteryStatusIndicator
                    fillPercent={batteryIndicator.fillPercent}
                    charging={batteryIndicator.charging}
                    ariaLabel={`${t("battery")}: ${batteryIndicator.label ?? t("batteryUnknown")}${batteryIndicator.charging ? `, ${t("batteryChargingOrMissing")}` : ""}`}
                  />
                ) : <Battery size={24} />}
              </div>
              <div>
                <strong>{battery.socPercent === null ? t("batteryUnknown") : `${Math.round(battery.socPercent)}%`}</strong>
                <span>
                  {batteryTimeEstimate.kind === "remaining" ? `${t("batteryEstimatedRemaining")} · ${durationLabel(batteryTimeEstimate.minutes)}` : null}
                  {batteryTimeEstimate.kind === "until_full" ? `${t("batteryEstimatedUntilFull")} · ${durationLabel(batteryTimeEstimate.minutes)}` : null}
                  {batteryTimeEstimate.kind === "full" ? t("batteryFull") : null}
                  {batteryTimeEstimate.kind === "unavailable" ? t("battery") : null}
                </span>
              </div>
            </div>
            <div className="settings-hero-item">
              <span className={`settings-status-dot${isControlUnavailable ? "" : " online"}`} aria-hidden="true" />
              <div>
                <strong>{connectionSummary}</strong>
                <span>{relayId ? `${relayId} · ` : ""}{t("lastSeen")}: {normalized?.lastSeen ?? "-"}</span>
              </div>
            </div>
          </div>

          <FactList
            items={[
              [t("hardwareModel"), normalized?.hardwareModel ? displayHardwareModel(normalized.hardwareModel) : "-"],
              [t("firmwareVersion"), normalized?.firmwareVersion ?? "-"],
              [t("matrixShape"), normalized?.matrixShape ?? "-"],
              [t("protocol"), normalized?.protocol ?? "-"],
              [t("deviceUid"), deviceUid],
            ]}
          />

          <div className="settings-card">
            <h4>{t("deviceGrouping")}</h4>
            <p>{t("deviceGroupingCopy")}</p>
            <div className="settings-inline-form">
              <input
                value={deviceGroupDraft}
                onChange={(event) => setDeviceGroupDraft(event.target.value)}
                placeholder={t("deviceCustomGroup")}
                aria-label={t("deviceCustomGroup")}
              />
              <button
                className="button primary"
                type="button"
                disabled={!deviceUid || deviceGroupSaving || deviceGroupDraft.trim() === String(device?.device_group ?? "")}
                onClick={() => void persistDeviceGroup(deviceGroupDraft)}
              >
                {deviceGroupSaving ? t("running") : t("saveDeviceGroup")}
              </button>
              {device?.device_group ? (
                <button className="button ghost" type="button" disabled={!deviceUid || deviceGroupSaving} onClick={() => void persistDeviceGroup("")}>
                  {t("clearDeviceGroup")}
                </button>
              ) : null}
            </div>
          </div>

          <div className="settings-card">
            {hubRelayed ? (
              // ESP-NOW devices do not use FindMe; the Hub link replaces it.
              <>
                <h4>{t("hubLinkTitle")}</h4>
                <p>{t("hubLinkCopy")}</p>
                <FactList
                  items={[
                    [t("hubLinkHub"), device?.gateway_id || "-"],
                    [t("hubLinkState"), isControlUnavailable ? t("offline") : t("hubOnline")],
                    [t("transport"), "ESP-NOW"],
                  ]}
                />
              </>
            ) : (
              <>
                <div className="settings-detail-header">
                  <div>
                    <h4>{t("gatewayTitle")}</h4>
                    <p>{t("gatewayCopy")}</p>
                  </div>
                  <button className="button" type="button" disabled={isCommandBusy("findme_discover") || !deviceUid || isControlUnavailable} onClick={() => void run("FindMe", { command: "findme_discover" }, 15000)}>
                    {isCommandBusy("findme_discover") ? t("running") : t("rediscoverGateway")}
                  </button>
                </div>
                <FactList
                  items={[
                    [t("gatewayId"), findme.gateway_id ?? "-"],
                    [t("gatewayHost"), findme.host ? `${stringValue(findme.host)}${findme.udp_port ? `:${stringValue(findme.udp_port)}` : ""}` : "-"],
                    [t("gatewaySource"), findme.state ?? "-"],
                  ]}
                />
                {findme.last_error ? <p className="notice error">{stringValue(findme.last_error)}</p> : null}
                <MoreDetails label={t("settingsDetails")}>
                  <FactList
                    items={[
                      [t("transport"), device?.transport_path ?? status.transport_path ?? "-"],
                      [t("heartbeat"), findme.last_heartbeat_at ?? device?.last_heartbeat_at ?? status.last_heartbeat_at ?? "-"],
                      [t("heartbeatInterval"), findme.heartbeat_interval_ms ?? "-"],
                      [t("gatewayLastSuccess"), findme.last_success_ms ?? "-"],
                    ]}
                  />
                </MoreDetails>
              </>
            )}
          </div>

          <div className="settings-card settings-danger-zone">
            <h4>{t("restartTitle")}</h4>
            <p>{t("restartCopy")}</p>
            <div className="actions compact">
              <button
                className="button"
                type="button"
                disabled={isCommandBusy("reboot") || !deviceUid}
                onClick={() => setPendingConfirm({
                  title: t("rebootConfirmTitle"),
                  message: t("rebootConfirmMessage"),
                  confirmLabel: t("rebootDevice"),
                  action: () => void run(t("rebootDevice"), { command: "reboot" }).catch(() => undefined),
                })}
              >
                {isCommandBusy("reboot") ? t("running") : t("rebootDevice")}
              </button>
              <button className="button" type="button" disabled={isCommandBusy("reboot_wifi_setup") || !deviceUid || isControlUnavailable} onClick={() => setShowWifiSetupRebootModal(true)}>
                {isCommandBusy("reboot_wifi_setup") ? t("running") : t("rebootWifiSetup")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (section === "hardware") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_hardware")}</h3>
            </div>
          </div>

          <div className="settings-card">
            <h4>{t("settingsSection_pins")}</h4>
            <p className="service-muted">{pinLayoutCopy}</p>
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
            <div className="actions compact">
              <button className="button primary" type="button" disabled={isCommandBusy("set_matrix_layout") || !deviceUid} onClick={() => void applyPinLayout()}>
                {isCommandBusy("set_matrix_layout") ? t("running") : t("applyPinLayout")}
              </button>
              <button className="button" type="button" onClick={() => setShowIoModal(true)}>
                {t("ioConfigOpen")}
              </button>
            </div>
          </div>

          {boardProfile.supportsChargeControl ? (
            <div className="settings-card">
              <h4>{t("batteryStatus")}</h4>
              <FactList
                items={[
                  [t("batterySoc"), batteryGaugeSyncing ? t("batteryGaugeSyncing") : batteryGaugeSyncFailed ? t("batteryGaugeSyncFailed") : battery.socPercent === null ? t("batteryUnknown") : `${battery.socPercent}%`],
                  [t("battery"), batteryStatus.state ?? t("batteryUnknown")],
                  [t("batteryVoltageMv"), battery.vbatMv ?? t("batteryUnknown")],
                  [t("chargerDetected"), boolString(batteryStatus.charger_detected ?? batteryStatus.detected)],
                ]}
              />
              <div className="settings-subsection">
                <div>
                  <h5>{t("chargeProfile")}</h5>
                  <p className="service-muted">{t("chargeProfileCopy")}</p>
                </div>
                <div className="settings-inline-form">
                  <Select value={chargeProfile} onChange={(event) => setChargeProfile(event.target.value)} aria-label={t("chargeProfile")}>
                    <option value="ultra_slow">{t("ultraSlowChargingMode")}</option>
                    <option value="slow">{t("slowChargingMode")}</option>
                    <option value="balanced">{t("balancedChargingMode")}</option>
                    <option value="fast">{t("fastChargingMode")}</option>
                    <option value="extreme">{t("extremeChargingMode")}</option>
                  </Select>
                  <button className="button primary" type="button" disabled={isCommandBusy("set_charge_profile") || !deviceUid || chargeProfile === batteryStatus.profile} onClick={() => void applyChargeProfile()}>
                    {isCommandBusy("set_charge_profile") ? t("running") : t("saveChargeProfile")}
                  </button>
                </div>
              </div>
                {boardProfile.supportsBatteryPercentageIndicator ? (
                  <div className="settings-subsection">
                    <div>
                      <h4>{t("batterySetup")}</h4>
                      <p className="service-muted">{t("batterySetupCopy")}</p>
                    </div>
                    {batteryProfileSetupRequired(batteryStatus) ? <p className="notice">{t("batteryProfileSetupNotice")}</p> : null}
                    <div className="field-grid">
                      <div className="field">
                        <label>{t("batteryCapacityMah")}</label>
                        <Select value={batteryCapacityChoice} onChange={(event) => setBatteryCapacityChoice(event.target.value as BatteryCapacityChoice)}>
                          {BATTERY_PRESETS.map((preset) => (
                            <option key={preset.capacityMah} value={preset.capacityMah}>
                              {preset.capacityMah}mAh · {preset.maxChargeCurrentMa}mA
                            </option>
                          ))}
                          <option value="custom">{t("batteryCapacityCustom")}</option>
                        </Select>
                      </div>
                      {batteryCapacityChoice === "custom" ? (
                        <>
                          <div className="field"><label>{t("batteryCapacityCustom")}</label><input type="number" min="1" value={customBatteryCapacity} onChange={(event) => setCustomBatteryCapacity(event.target.value)} /></div>
                          <div className="field"><label>{t("batteryMaxChargeCurrent")}</label><input type="number" min="100" max="350" step="10" value={maxBatteryChargeCurrent} onChange={(event) => setMaxBatteryChargeCurrent(event.target.value)} /></div>
                        </>
                      ) : (
                        <p className="service-muted">{t("batteryMaxChargeCurrent")}: {batteryPresetFor(batteryCapacityChoice)?.maxChargeCurrentMa} mA</p>
                      )}
                    </div>
                    {batteryProfileDraftError ? <p className="notice error">{t("batteryProfileInvalid")}</p> : null}
                    <div className="actions compact">
                      <button className="button primary" type="button" disabled={isCommandBusy("set_battery_profile") || !deviceUid || batteryProfileDraftError !== null} onClick={() => void applyBatteryProfile()}>{isCommandBusy("set_battery_profile") ? t("running") : t("saveBatteryProfile")}</button>
                    </div>
                  </div>
                ) : null}
                {batteryLedSupported ? (
                  <div className="settings-subsection">
                    <div>
                      <h4>{t("batteryLedWarning")}</h4>
                      <p className="service-muted">{t("batteryLedWarningCopy")}</p>
                    </div>
                    <div className="field-grid">
                      <div className="field">
                        <label>{t("batteryLedThreshold")}</label>
                        <input type="number" min="0" max="25" step="1" value={lowBatteryThresholdPercent} onChange={(event) => setLowBatteryThresholdPercent(event.target.value)} />
                      </div>
                    </div>
                    {batteryLedThresholdDraftError ? <p className="notice error">{t("batteryLedThresholdInvalid")}</p> : null}
                    <div className="actions compact">
                      <button className="button primary" type="button" disabled={isCommandBusy("set_indicators") || !deviceUid || batteryLedThresholdDraftError !== null} onClick={() => void applyBatteryLedThreshold()}>
                        {isCommandBusy("set_indicators") ? t("running") : t("saveBatteryLedWarning")}
                      </button>
                    </div>
                  </div>
                ) : null}
              {batteryGaugeSyncing ? <p className="notice">{t("batteryGaugeSyncing")}</p> : null}
              {batteryGaugeSyncFailed ? <p className="notice error">{t("batteryGaugeSyncFailed")}</p> : null}
              <MoreDetails label={t("settingsDetails")}>
                <FactList
                  items={[
                    [t("batteryRate"), battery.ratePercentPerHour === null ? t("batteryUnknown") : `${battery.ratePercentPerHour}%/h`],
                    [t("batteryPresent"), battery.batteryPresent === null ? t("batteryUnknown") : boolString(battery.batteryPresent)],
                    [t("batteryGaugeSyncState"), battery.syncState ?? t("batteryUnknown")],
                    ...(boardProfile.supportsBatteryPercentageIndicator
                      ? [
                        [t("batteryCapacityMah"), battery.profileResolved === false ? t("batteryNotSet") : battery.capacityMah ?? t("batteryUnknown")] as [string, unknown],
                        [t("batteryMaxChargeCurrent"), battery.maxChargeCurrentMa ?? t("batteryUnknown")] as [string, unknown],
                      ]
                      : []),
                    [t("batteryThermalBypass"), battery.thermalMonitoringBypassed === null ? t("batteryUnknown") : boolString(battery.thermalMonitoringBypassed)],
                    [t("chargeProfile"), batteryStatus.profile ?? "-"],
                    [t("chargeCurrentMa"), batteryStatus.charge_current_ma ?? "-"],
                    [t("inputLimitMa"), batteryStatus.input_limit_ma ?? "-"],
                    [t("vbatRegMv"), batteryStatus.vbat_reg_mv ?? "-"],
                    [t("safetyTimerHours"), batteryStatus.safety_timer_hours ?? "-"],
                    [t("configured"), boolString(batteryStatus.configured)],
                  ]}
                />
                {boardProfile.supportsBatteryPercentageIndicator ? (
                  <div className="actions compact">
                    <button className="button" type="button" disabled={batteryGaugeSyncing || isCommandBusy("resync_battery_gauge") || !deviceUid} onClick={() => void resyncBatteryGauge()}>
                      {batteryGaugeSyncing || isCommandBusy("resync_battery_gauge") ? t("batteryGaugeSyncing") : t("resyncBatteryGauge")}
                    </button>
                  </div>
                ) : null}
              </MoreDetails>
            </div>
          ) : null}

          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("powerStatus")}</h4>
                <p>{powerStatusCopy}</p>
              </div>
              <div className="actions compact">
                {powerStatus.state && powerStatus.state !== "normal" ? (
                  <button className="button" type="button" disabled={isCommandBusy("power_set_state") || !deviceUid} onClick={() => void applyPowerState("normal")}>
                    {isCommandBusy("power_set_state") ? t("running") : t("resumeNormalMode")}
                  </button>
                ) : null}
                <button className="button" type="button" disabled={isCommandBusy("power_set_state") || !deviceUid} onClick={() => void applyPowerState("soft_off_auto")}>
                  {isCommandBusy("power_set_state") ? t("running") : t("softOffAuto")}
                </button>
              </div>
            </div>
            <FactList
              items={[
                [t("powerState"), powerStatus.state ?? "-"],
                [t("wakeSource"), powerStatus.wake_source ?? "-"],
                [t("chargeState"), powerStatus.charge_state ?? batteryStatus.charge_state ?? "-"],
                [t("chargerPresent"), boolString(powerStatus.charger_present)],
                ...(powerStatus.soft_off_reason ? [[t("softOffReason"), powerStatus.soft_off_reason] as [string, unknown]] : []),
              ]}
            />
          </div>

          {boardProfile.supportsActionButtonSettings ? renderSection("action_button") : null}

          <div className="settings-card">
            <h4>{t("lightsAndDisplay")}</h4>
            <div className="settings-subsection">
              <div>
                <h5>{t("boardLedBrightnessLabel")}</h5>
                <p className="service-muted">{t("boardLedBrightnessCopy")}</p>
              </div>
              <div className="settings-inline-form">
                <Select value={String(boardLedBrightness)} onChange={(event) => setBoardLedBrightness(boardLedBrightnessValue(event.target.value))} aria-label={t("paramBrightness")}>
                  {BOARD_LED_BRIGHTNESS_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option === DEFAULT_BOARD_LED_BRIGHTNESS ? t("boardLedBrightnessDefault") : `${Math.round(option * 100)}%`}
                    </option>
                  ))}
                </Select>
                <button className="button primary" type="button" disabled={isCommandBusy("set_indicators") || !deviceUid} onClick={() => void run(t("saveBoardLedBrightness"), { command: "set_indicators", board_led: { brightness: boardLedBrightness } })}>
                  {isCommandBusy("set_indicators") ? t("running") : t("saveBoardLedBrightness")}
                </button>
              </div>
            </div>
            {boardProfile.supportsExternalLed ? (
              <div className="settings-subsection">
                <div>
                  <h5>{t("externalLedIndicators")}</h5>
                  <p className="service-muted">{t("externalLedIndicatorsCopy")}</p>
                </div>
                <div className="field-grid">
                  <div className="field">
                    <label>{t("externalLedMode")}</label>
                    <Select value={externalLedMode} onChange={(event) => setExternalLedMode(event.target.value)}>
                      <option value="off">{t("indicatorMode_off")}</option>
                      <option value="enabled">{t("indicatorMode_enabled")}</option>
                    </Select>
                  </div>
                  <div className="field">
                    <label>{t("externalLedPreset")}</label>
                    <Select value={externalPreset} onChange={(event) => setExternalPreset(event.target.value)}>
                      <option value="system_status">{t("indicatorPreset_system_status")}</option>
                      <option value="connectivity">{t("indicatorPreset_connectivity")}</option>
                      <option value="pressure_meter">{t("indicatorPreset_pressure_meter")}</option>
                      <option value="stream_heartbeat">{t("indicatorPreset_stream_heartbeat")}</option>
                      <option value="calibration_auto">{t("indicatorPreset_calibration_auto")}</option>
                      <option value="solid_marker">{t("indicatorPreset_solid_marker")}</option>
                      <option value="identify">{t("indicatorPreset_identify")}</option>
                      <option value="off">{t("indicatorPreset_off")}</option>
                    </Select>
                    <p className="service-muted">{t("externalLedAppPriority")}</p>
                  </div>
                  <div className="field">
                    <label>{t("paramBrightness")}</label>
                    <Select value={String(brightness)} onChange={(event) => setBrightness(Number(event.target.value) || DEFAULT_EXTERNAL_LED_BRIGHTNESS)}>
                      {EXTERNAL_LED_BRIGHTNESS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {externalPreset === "solid_marker" ? (
                    <div className="field">
                      <label>{t("externalLedColor")}</label>
                      <Select value={externalColor} onChange={(event) => setExternalColor(event.target.value)}>
                        <option value="teal">{t("indicatorColor_teal")}</option>
                        <option value="green">{t("indicatorColor_green")}</option>
                        <option value="blue">{t("indicatorColor_blue")}</option>
                        <option value="purple">{t("indicatorColor_purple")}</option>
                        <option value="amber">{t("indicatorColor_amber")}</option>
                        <option value="red">{t("indicatorColor_red")}</option>
                        <option value="white">{t("indicatorColor_white")}</option>
                      </Select>
                    </div>
                  ) : null}
                </div>
                {externalLed.active_preset === "app" ? <p className="notice">{t("externalLedAppActive")}</p> : null}
                {externalLed.last_error ? <p className="notice error">{stringValue(externalLed.last_error)}</p> : null}
                <div className="actions compact">
                  <button className="button primary" type="button" disabled={isCommandBusy("set_indicators") || !deviceUid} onClick={() => void run(t("saveExternalLed"), { command: "set_indicators", external_led: { mode: externalLedMode, preset: externalPreset, brightness, color: externalColor } })}>
                    {isCommandBusy("set_indicators") ? t("running") : t("saveExternalLed")}
                  </button>
                  <button className="button" type="button" disabled={isCommandBusy("set_indicators") || !deviceUid} onClick={() => void run(t("testExternalLed"), { command: "set_indicators", external_led: { mode: "enabled", preset: "identify", brightness } })}>
                    {isCommandBusy("set_indicators") ? t("running") : t("testExternalLed")}
                  </button>
                </div>
                <MoreDetails label={t("settingsDetails")}>
                  <FactList
                    items={[
                      [t("externalLedPin"), externalLed.pin ?? "-"],
                      [t("externalLedCount"), externalLed.count ?? "-"],
                      [t("externalLedInitialized"), boolString(externalLed.initialized)],
                      [t("activePreset"), externalLed.active_preset === "app" ? t("indicatorPreset_app") : externalLed.active_preset ?? "-"],
                      [t("externalLedLastShow"), externalLed.last_show_ms ?? "-"],
                    ]}
                  />
                </MoreDetails>
              </div>
            ) : null}
            {boardProfile.supportsOled ? (
              <div className="settings-subsection">
                <div>
                  <h5>{t("ssd1306Display")}</h5>
                  <p className="service-muted">
                    {oled.detected ? `${t("screenDetected")}${oled.addr ? ` · ${stringValue(oled.addr)}` : ""}` : t("noSsd1306Detected")}
                  </p>
                </div>
                {oled.last_error ? <p className="notice error">{stringValue(oled.last_error)}</p> : null}
                <div className="field-grid">
                  <div className="field">
                    <label>{t("paramOledMode")}</label>
                    <Select value={oledMode} onChange={(event) => setOledMode(event.target.value)}>
                      <option value="off">{t("indicatorMode_off")}</option>
                      <option value="auto">{t("indicatorMode_auto")}</option>
                      <option value="enabled">{t("indicatorMode_enabled")}</option>
                    </Select>
                  </div>
                  <div className="field">
                    <label>{t("oledPage")}</label>
                    <Select value={oledPage} onChange={(event) => setOledPage(event.target.value)}>
                      <option value="live_status">{t("oledPage_live_status")}</option>
                      <option value="sensor_snapshot">{t("oledPage_sensor_snapshot")}</option>
                      <option value="recording_status">{t("oledPage_recording_status")}</option>
                      <option value="app">{t("oledPage_app")}</option>
                    </Select>
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
                    <Select value={oledRotation} onChange={(event) => setOledRotation(Number(event.target.value))}>
                      <option value={0}>{t("oledRotation_0")}</option>
                      <option value={1}>{t("oledRotation_90")}</option>
                      <option value={2}>{t("oledRotation_180")}</option>
                      <option value={3}>{t("oledRotation_270")}</option>
                    </Select>
                  </div>
                </div>
                <div className="actions compact">
                  <button className="button primary" type="button" disabled={isCommandBusy("set_indicators") || !deviceUid} onClick={() => void run(t("saveScreen"), { command: "set_indicators", oled: { mode: oledMode, page: oledPage, update_hz: oledUpdateHz, contrast: oledContrast, rotation: oledRotation } })}>
                    {isCommandBusy("set_indicators") ? t("running") : t("saveScreen")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

        </div>
      );
    }

    if (section === "action_button") {
      const actionIcon = (action: ActionButtonAction) => {
        if (action === "soft_off") return <Power aria-hidden="true" size={20} />;
        if (action === "identify") return <Lightbulb aria-hidden="true" size={20} />;
        if (action === "toggle_external_led") return <CircleOff aria-hidden="true" size={20} />;
        return <span className="action-button-none-icon" aria-hidden="true">—</span>;
      };
      const actionLabel = (action: ActionButtonAction) => t(`actionButtonAction_${action}`);
      const actionCopy = (action: ActionButtonAction) => t(`actionButtonActionCopy_${action}`);
      const renderActionChoices = (gesture: ActionButtonGesture, value: ActionButtonAction, setValue: (next: ActionButtonAction) => void) => (
        <fieldset className="action-button-choice-group" disabled={!actionButton.supported || !deviceUid || isControlUnavailable || isCommandBusy("set_action_button")}>
          <legend>{gesture === "short" ? t("actionButtonShortPress") : t("actionButtonLongPress")}</legend>
          <div className="action-button-choice-grid">
            {actionButtonActionsForGesture(gesture).map((action) => (
              <label key={action} className={`action-button-choice ${value === action ? "selected" : ""}`}>
                <input
                  type="radio"
                  name={`action-button-${gesture}`}
                  value={action}
                  checked={value === action}
                  onChange={() => setValue(action)}
                />
                <span className="action-button-choice-icon">{actionIcon(action)}</span>
                <span className="action-button-choice-copy">
                  <strong>{actionLabel(action)}</strong>
                  <small>{actionCopy(action)}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      );

      return (
        <div className="settings-card action-button-settings">
          <div className="settings-detail-header">
            <div>
              <h4>{t("settingsSection_actionButton")}</h4>
              <p>{t("actionButtonPageCopy")}</p>
            </div>
          </div>
          <section className="action-button-hero" aria-label={t("settingsSection_actionButton")}>
            <div className="action-button-glyph" aria-hidden="true" />
            <div>
              <p className="action-button-eyebrow">{t("actionButtonConfiguredFor")}</p>
              <h4>{`${t("actionButtonShortPress")}: ${actionLabel(actionButtonShortPress)} · ${t("actionButtonLongPress")}: ${actionLabel(actionButtonLongPress)}`}</h4>
              <p>{t("actionButtonBootWifiFixed")}</p>
            </div>
          </section>
          {!actionButton.supported ? (
            <div className="notice action-button-unavailable">
              <strong>{t("actionButtonFirmwareUpdateRequired")}</strong>
              <p>{t("actionButtonFirmwareUpdateRequiredCopy")}</p>
            </div>
          ) : (
            <>
              <div className="action-button-panel">
                {renderActionChoices("short", actionButtonShortPress, (next) => {
                  setActionButtonDraftTouched(true);
                  setActionButtonShortPress(next);
                })}
                {renderActionChoices("long", actionButtonLongPress, (next) => {
                  setActionButtonDraftTouched(true);
                  setActionButtonLongPress(next);
                })}
              </div>
              {actionButtonDraftDirty ? (
                <div className="actions action-button-save">
                  <button className="button primary" type="button" disabled={isCommandBusy("set_action_button") || !deviceUid || isControlUnavailable} onClick={() => void saveActionButtonSettings()}>
                    {isCommandBusy("set_action_button") ? t("running") : t("saveActionButton")}
                  </button>
                </div>
              ) : null}
              <div className="metric-row">
                <Metric label={t("actionButtonLastAction")} value={actionButton.lastAction ?? "-"} />
                <Metric label={t("actionButtonLastResult")} value={actionButton.lastResult ?? "-"} />
              </div>
            </>
          )}
        </div>
      );
    }

    if (section === "runtime") {
      const deviceFps = numberValue(authoritativeScanTiming.target_fps ?? scanHealth.requested_target_fps, 0);
      const deviceSettle = numberValue(authoritativeScanTiming.settle_us ?? scanHealth.settle_us, 0);
      const deviceEvery = numberValue(authoritativeScanTiming.send_every_n_frames ?? scanHealth.send_every_n_frames, 0);
      const scanDraftDiffers = deviceFps > 0 && (deviceFps !== targetFps || deviceSettle !== settleUs || deviceEvery !== sendEveryNFrames);
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_runtime")}</h3>
              <p>{t("runtimeSettingsCopy")}</p>
            </div>
          </div>
          <div className="settings-card">
            <h4>{t("scanPerformance")}</h4>
            <p>{t("scanPerformanceCopy")}</p>
              <div className="segmented-control">
                <button className={targetFps === 60 ? "active" : ""} type="button" onClick={() => applyScanPreset(60)}>
                  {t("standardFps")}
                </button>
                <button className={targetFps === 90 ? "active" : ""} type="button" onClick={() => applyScanPreset(90)}>
                  {t("extendedFps")}
                </button>
                <button
                  className={`${targetFps === DIRECT_STABILITY_FPS ? "active" : ""}${isHubRelayed(device) ? " recommended" : ""}`}
                  type="button"
                  onClick={() => void applyDirectStabilityPreset()}
                >
                  {t("directStabilityMode")}
                  {isHubRelayed(device) ? <small>{t("directStabilityModeRecommended")}</small> : null}
                </button>
              </div>
            <p className="service-muted">
              {t("effectiveSendFps")}: ≈ {Math.round(targetFps / Math.max(1, sendEveryNFrames))} fps
              {scanDraftDiffers ? ` · ${t("scanDeviceUsing").replace("{fps}", String(deviceFps))}` : ""}
            </p>
            <MoreDetails label={t("settingsAdvanced")}>
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
              </div>
            </MoreDetails>
            <div className="actions compact">
              <button className="button primary" type="button" disabled={isCommandBusy("set_scan_timing") || !deviceUid || (deviceFps > 0 && !scanDraftDiffers)} onClick={() => void applyScanTiming()}>
                {isCommandBusy("set_scan_timing") ? t("running") : t("applyScanTiming")}
              </button>
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-row">
              <div>
                <h4>{t("imuDiagnostics")}</h4>
                <p className="service-muted">
                  {stringValue(imu.state ?? (imu.enabled === false ? "disabled" : "-"))}
                  {imu.sample_rate_hz ? ` · ${stringValue(imu.sample_rate_hz)} Hz` : ""}
                  {" · "}{t("imuSampleRateFollowsScan")}
                </p>
              </div>
              <div className="settings-row-controls">
                <label className="switch-row">
                  <input type="checkbox" checked={imuEnabled} onChange={(event) => setImuEnabled(event.target.checked)} />
                  <span>{t("paramEnabled")}</span>
                </label>
                <button className="button" type="button" disabled={isCommandBusy("set_imu") || !deviceUid} onClick={() => void run(t("saveImu"), { command: "set_imu", enabled: imuEnabled })}>
                  {isCommandBusy("set_imu") ? t("running") : t("saveImu")}
                </button>
              </div>
            </div>
            {imu.last_error ? <p className="notice error">{stringValue(imu.last_error)}</p> : null}
            <MoreDetails label={t("settingsDetails")}>
              <FactList
                items={[
                  [t("imuHeapDelta"), numberValue(imu.heap_after, 0) - numberValue(imu.heap_before, 0)],
                  [t("imuCacheAgeMs"), imu.cache_age_ms ?? "-"],
                  [t("imuLastReadUs"), imu.last_read_duration_us ?? "-"],
                ]}
              />
            </MoreDetails>
          </div>
          <div className="settings-card">
            <div className="settings-row">
              <div>
                <h4>{t("streamBufferDiagnostics")}</h4>
                <p className="service-muted">
                  {streamBuffer.mode ? stringValue(streamBuffer.mode) : "-"}
                  {streamBuffer.depth_frames !== undefined ? ` · ${t("streamBufferDepth")} ${stringValue(streamBuffer.depth_frames)}` : ""}
                  {scanHealth.queue_occupied_frames !== undefined ? ` · ${t("streamBufferQueueOccupied")} ${stringValue(scanHealth.queue_occupied_frames)}` : ""}
                </p>
              </div>
              <div className="settings-row-controls">
                <label className="switch-row">
                  <input type="checkbox" checked={streamBufferEnabled} onChange={(event) => setStreamBufferEnabled(event.target.checked)} />
                  <span>{t("paramEnabled")}</span>
                </label>
                <Select value={streamBufferMode} disabled={!streamBufferEnabled} onChange={(event) => setStreamBufferMode(event.target.value)} aria-label={t("streamBufferMode")}>
                  <option value="standard">{t("streamBufferStandardMode")}</option>
                  <option value="extended">{t("streamBufferExtendedMode")}</option>
                </Select>
                <button className="button" type="button" disabled={isCommandBusy("set_stream_buffer") || !deviceUid || isControlUnavailable} onClick={() => void applyStreamBuffer()}>
                  {isCommandBusy("set_stream_buffer") ? t("running") : t("saveStreamBuffer")}
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (section === "update") {
      const phase = stringValue(updateState.phase, "");
      const transfer = updateTransferProgress(updateState);
      const updateBusy = isCommandBusy("check_update") || isCommandBusy("apply_update") || phase === "downloading";
      const statusLine =
        phase === "ready" ? t("updateAvailable")
          : phase === "current" ? t("updateUpToDate")
            : phase === "manifest" ? t("updateChecking")
              : phase === "downloading" ? `${t("updateInstalling")}${transfer ? ` · ${transfer}` : ""}`
                : phase === "applied" ? t("updateApplied")
                  : phase === "error" ? t("updateFailed")
                    : t("updateNotChecked");
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_update")}</h3>
            </div>
          </div>
          <div className="settings-card update-hero" data-phase={phase || "idle"}>
            <div className="update-hero-versions">
              <span>{t("updateInstalledVersion")}</span>
              <strong>{normalized?.firmwareVersion ?? "-"}</strong>
              {phase === "ready" && updateState.version ? (
                <>
                  <span className="update-hero-arrow" aria-hidden="true">→</span>
                  <strong className="update-hero-next">{stringValue(updateState.version)}</strong>
                </>
              ) : null}
            </div>
            <p className="update-hero-status">{statusLine}</p>
            {phase === "error" && (updateState.last_error || updateState.error) ? (
              <p className="notice error">{stringValue(updateState.last_error ?? updateState.error)}</p>
            ) : null}
            <div className="actions compact">
              <button className={`button${phase === "ready" ? "" : " primary"}`} type="button" disabled={updateBusy || !deviceUid} onClick={() => void run(t("updateCheck"), updateCommand("check_update"), 30000)}>
                {isCommandBusy("check_update") ? t("running") : t("updateCheck")}
              </button>
              {phase === "ready" ? (
                <button className="button primary" type="button" disabled={updateBusy || !deviceUid} onClick={() => void run(t("updateInstall"), updateCommand("apply_update"), 90000)}>
                  {isCommandBusy("apply_update") ? t("running") : t("updateInstall")}
                </button>
              ) : null}
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
                {updateChangelogBody ? <Markdown source={updateChangelogBody} /> : null}
                {!updateChangelogLoading && !updateChangelogBody && !updateChangelogError ? <p className="service-muted">{t("changelogUnavailable")}</p> : null}
              </div>
            ) : null}
          </div>
          <div className="settings-card">
            {otaChannelSupported ? (
              <>
                <div className="field update-channel-field">
                  <label>{t("updateChannel")}</label>
                  <Select
                    value={deviceUpdateChannel}
                    disabled={isCommandBusy("set_ota_config") || !deviceUid}
                    onChange={(event) => {
                      const next = normalizeUpdateChannel(event.target.value);
                      if (next === "beta") setConfirmBetaChannel(true);
                      else void setUpdateChannel("stable");
                    }}
                  >
                    <option value="stable">{t("updateChannelStable")}</option>
                    <option value="beta">{t("updateChannelBeta")}</option>
                  </Select>
                </div>
                {waitingForStableToCatchUp(deviceUpdateChannel, normalized?.firmwareVersion) ? (
                  <p className="cal-hint">{t("updateChannelWaitingStable").replace("{version}", normalized?.firmwareVersion ?? "")}</p>
                ) : null}
                {deviceUpdateChannel === "beta" ? <p className="cal-hint">{t("updateChannelBetaActive")}</p> : null}
              </>
            ) : null}
            <MoreDetails label={t("settingsAdvanced")}>
              {otaChannelSupported ? (
                <>
                  <label className="switch-row">
                    <input type="checkbox" checked={showCustomManifest} onChange={(event) => setShowCustomManifest(event.target.checked)} />
                    <span>{t("updateCustomManifest")}</span>
                  </label>
                  {showCustomManifest ? (
                    <div className="field">
                      <label>Manifest URL</label>
                      <input
                        value={manifestUrl}
                        placeholder={stringValue(otaConfig.resolved_manifest_url, manifestUrlForHardwareModel(normalized?.hardwareModel, deviceUpdateChannel))}
                        onChange={(event) => setManifestUrl(event.target.value)}
                      />
                      <p className="service-muted">{t("updateCustomManifestHint")}</p>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="field">
                    <label>Manifest URL</label>
                    <input value={manifestUrl} onChange={(event) => setManifestUrl(event.target.value)} />
                  </div>
                  <p className="service-muted">{t("updateChannelNeedsFirmware")}</p>
                </>
              )}
              <div className="control-row">
                <label className="switch-row">
                  <input type="checkbox" checked={autoOtaOnBoot} onChange={(event) => setAutoOtaOnBoot(event.target.checked)} />
                  <span>{t("autoOtaOnBoot")}</span>
                </label>
                <button className="button" type="button" disabled={isCommandBusy("set_ota_config") || !deviceUid} onClick={() => void saveOtaConfig()}>
                  {isCommandBusy("set_ota_config") ? t("running") : t("saveUpdateSettings")}
                </button>
              </div>
              <FactList
                items={[
                  [t("updatePhase"), phase || "-"],
                  ["URL", updateState.url ?? "-"],
                ]}
              />
            </MoreDetails>
          </div>
        </div>
      );
    }

    if (section === "clock") {
      // Not a STATUS_DRIVEN section: the card polls the small clock_status
      // instead, since a full status is paged (slow) through a Hub.
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_clock")}</h3>
              <p>{t("clockSettingsCopy")}</p>
            </div>
          </div>
          <DeviceClockCard deviceUid={deviceUid} disabled={isControlUnavailable} run={run} />
        </div>
      );
    }

    if (section === "maintenance") {
      return (
        <div className="settings-stack">
          <CalibrationWorkbench
            t={t}
            deviceUid={deviceUid}
            isDeviceOffline={isControlUnavailable}
            matrixShape={recordValue(status.matrix_shape)}
            calibrationStatus={calibrationStatus}
            maintenanceMode={inMaintenanceMode}
            run={run}
            airPressurePanel={<PressureCalibrationPanel t={t} deviceUid={deviceUid} run={run} />}
          />
        </div>
      );
    }

    if (section === "diagnostics") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_diagnostics")}</h3>
              <p>{t("diagnosticsNotesCopy")}</p>
            </div>
          </div>
          <DeviceHealthCard deviceUid={deviceUid} disabled={isControlUnavailable} run={run} espNow={isHubRelayed(device)} />
          <ScanHealthCard
            scanHealth={scanHealth}
            wifi={wifi}
            analogPins={Array.isArray(matrixLayout.analog_pins ?? matrixLayout.active_rows)
              ? ((matrixLayout.analog_pins ?? matrixLayout.active_rows) as unknown[]).map(Number).filter(Number.isFinite)
              : []}
            analogPinSlots={boardProfile.analogPinSlots}
            busy={isCommandBusy("scan_health")}
            disabled={!deviceUid || isControlUnavailable}
            onRefresh={() => void run("Scan health", { command: "scan_health" })}
          />
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
                  <button className="button primary" type="button" disabled={isCommandBusy("memory_status") || !deviceUid || isControlUnavailable} onClick={() => setRamMonitorEnabled(true)}>
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
                  <Metric label={t("heapFree")} value={memory.heap_free ?? "-"} />
                  <Metric label={t("heapLargestBlock")} value={memory.heap_largest_free_block ?? "-"} />
                  <Metric label={t("heapMinFree")} value={memory.heap_min_free ?? "-"} />
                  <Metric label={t("ramRefreshState")} value={ramRefreshInFlight ? t("refreshing") : t("idle")} />
                  <Metric label={t("ramLastUpdated")} value={ramLastUpdated || "-"} />
                </div>
              </>
            ) : (
              <p className="service-muted">{t("ramMonitorClosedCopy")}</p>
            )}
          </div>
          <details className="terminal-json-details">
            <summary>{t("lastResponse")}</summary>
            <pre>{pretty(lastResult)}</pre>
          </details>
        </div>
      );
    }

    if (section === "apps") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_apps")}</h3>
              <p>{t("settingsAppsCopy")}</p>
            </div>
            <Link className="button" to={`/device/${encodeURIComponent(deviceUid)}/apps`}>
              {t("deviceApps")}
            </Link>
          </div>
          <DeviceAppsPanel
            // This page owns a single-flight mutex over run(); the panel must
            // share it rather than opening a second pipeline to the device.
            // waitForLock: the live preview holds the same mutex between
            // polls, and an operator's click must wait it out, not be dropped.
            runner={(payload, timeoutMs) =>
              run(String(payload.command ?? "app"), payload, timeoutMs, { waitForLock: true })}
            poll={(payload, timeoutMs) =>
              run(String(payload.command ?? "app_view"), payload, timeoutMs, { background: true })}
            maintenanceMode={inMaintenanceMode}
            supportsRegistry={supportsAppRegistry}
            busy={Boolean(busyCommand)}
            compact
          />
        </div>
      );
    }

    if (section === "files") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("settingsSection_files")}</h3>
              <p>{t("flashDiagnosticsCopy")}</p>
            </div>
            <div className="actions compact">
              <button className="button" type="button" disabled={isCommandBusy("storage_status") || !deviceUid || isControlUnavailable} onClick={() => void run(t("refreshFlashUsage"), { command: "storage_status" })}>
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
            <div className="settings-row">
              <div>
                <h4>{t("logSettings")}</h4>
                <p className="service-muted">
                  {logging.bytes !== undefined ? bytesLabel(logging.bytes) : "-"}
                  {logging.effective_total_bytes ? ` / ${bytesLabel(logging.effective_total_bytes)}` : ""}
                </p>
              </div>
              <div className="settings-row-controls">
                <label className="switch-row">
                  <input type="checkbox" checked={logEnabled} onChange={(event) => setLogEnabled(event.target.checked)} />
                  <span>{t("paramEnabled")}</span>
                </label>
                <Select value={logLevel} onChange={(event) => setLogLevel(event.target.value)} aria-label={t("logLevel")}>
                  <option value="error">error</option>
                  <option value="warn">warn</option>
                  <option value="info">info</option>
                  <option value="debug">debug</option>
                </Select>
                <Select value={logMode} onChange={(event) => setLogMode(event.target.value)} aria-label={t("logMode")}>
                  <option value="standard">{t("logModeStandard")}</option>
                  <option value="extended">{t("logModeExtended")}</option>
                </Select>
                <button className="button primary" type="button" disabled={isCommandBusy("set_log") || !deviceUid} onClick={() => void saveLogSettings()}>
                  {isCommandBusy("set_log") ? t("running") : t("saveLogSettings")}
                </button>
              </div>
            </div>
            <div className="actions compact">
              <button
                className="button"
                type="button"
                disabled={isCommandBusy("log_clear") || !deviceUid}
                onClick={() => setPendingConfirm({
                  title: t("clearLogsConfirmTitle"),
                  message: t("clearLogsConfirmMessage"),
                  confirmLabel: t("clearLogs"),
                  action: () => void run(t("clearLogs"), { command: "log_clear" }).catch(() => undefined),
                })}
              >
                {isCommandBusy("log_clear") ? t("running") : t("clearLogs")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (section === "experimental") {
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
                <Select value={filterMedian} disabled={!filterEnabled} onChange={(event) => setFilterMedian(Number(event.target.value))}>
                  <option value={1}>1 ({t("filterMedianOff")})</option>
                  <option value={3}>3</option>
                  <option value={5}>5</option>
                </Select>
              </div>
              <div className="field">
                <label>{t("filterAlpha")}</label>
                <input type="number" min={0.05} max={0.6} step={0.05} value={filterAlpha}
                  disabled={!filterEnabled} onChange={(event) => setFilterAlpha(Number(event.target.value))} />
              </div>
            </div>
            <p className="service-muted">
              {t("onDevice")}: {filter.enabled === true ? `${t("filterEnabled")} · ${t("filterMedian")} ${stringValue(filter.median)} · ${t("filterAlpha")} ${stringValue(filter.alpha)}` : boolString(filter.enabled)}
            </p>
            <div className="actions compact">
              <button className="button primary" type="button"
                disabled={isCommandBusy("set_filter") || !deviceUid || isControlUnavailable}
                onClick={() => void applyFilter()}>
                {isCommandBusy("set_filter") ? t("running") : t("saveFilter")}
              </button>
            </div>
          </div>
          <div className="settings-card">
            <h4>{t("rawAdcDiagnostics")}</h4>
            <p>{t("rawAdcDiagnosticsCopy")}</p>
            <div className="field-grid">
              <label className="switch-row">
                <input type="checkbox" checked={rawAdcEnabled} onChange={(event) => setRawAdcEnabled(event.target.checked)} />
                <span>{t("rawAdcEnabled")}</span>
              </label>
            </div>
            <p className="service-muted">{t("onDevice")}: {boolString(streamRawAdcEnabled)}</p>
            <div className="actions compact">
              <button className="button primary" type="button"
                disabled={isCommandBusy("set_raw_adc") || !deviceUid || isControlUnavailable}
                onClick={() => void applyRawAdc()}>
                {isCommandBusy("set_raw_adc") ? t("running") : t("saveRawAdc")}
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
      <section className="device-settings-head">
        <div className="device-settings-title">
          <h2>{normalized?.displayName ?? deviceUid}</h2>
          <p>
            <span className={`settings-status-dot${isControlUnavailable ? "" : " online"}`} aria-hidden="true" />
            <span>{normalized?.connectionState === "online" ? t("hubOnline") : connectionLabel}</span>
            {normalized?.hardwareModel ? <span>{displayHardwareModel(normalized.hardwareModel)}</span> : null}
            {normalized?.firmwareVersion ? <span>{normalized.firmwareVersion}</span> : null}
            <span>{hubRelayed ? "Hub" : "Gateway"}{(hubRelayed ? device?.gateway_id : findme.gateway_id) ? ` ${stringValue(hubRelayed ? device?.gateway_id : findme.gateway_id)}` : ""}</span>
          </p>
        </div>
        <div className="device-settings-mode">
          <span>{t("mode")}</span>
          {isControlUnavailable || !currentMode ? (
            <strong>{connectionLabel}</strong>
          ) : (
            <Select
              aria-label={t("mode")}
              value={modeDraft}
              disabled={busyCommand !== ""}
              onChange={(event) => setModeDraft(event.target.value)}
            >
              <option value="normal">{t("modeOption_normal")}</option>
              <option value="maintenance">{t("modeOption_maintenance")}</option>
              {/* Entered by the firmware itself after repeated crashes, never chosen. */}
              {currentMode === "safe_maintenance" ? (
                <option value="safe_maintenance" disabled>{t("modeOption_safe_maintenance")}</option>
              ) : null}
              {!["normal", "maintenance", "safe_maintenance"].includes(currentMode) ? (
                <option value={currentMode} disabled>{currentMode}</option>
              ) : null}
            </Select>
          )}
          {!isControlUnavailable && currentMode && modeDraft !== currentMode ? (
            <button
              className="button compact primary"
              type="button"
              disabled={busyCommand !== "" || !deviceUid}
              onClick={() =>
                void run(
                  modeDraft === "maintenance" ? t("enterMaintenance") : t("exitMaintenance"),
                  modeDraft === "maintenance"
                    ? { command: "enter_maintenance", reason: "manual" }
                    : { command: "exit_maintenance" },
                ).catch(() => setModeDraft(currentMode))
              }
            >
              {busyCommand === "enter_maintenance" || busyCommand === "exit_maintenance" ? t("running") : t("modeApply")}
            </button>
          ) : null}
        </div>
      </section>

      {errorMessage ? <p className="notice error">{errorMessage}</p> : null}

      {confirmBetaChannel ? (
        <ConfirmModal
          title={t("updateChannelBetaConfirmTitle")}
          message={t("updateChannelBetaConfirmMessage")}
          confirmLabel={t("updateChannelSwitchToBeta")}
          cancelLabel={t("cancel")}
          onConfirm={() => {
            setConfirmBetaChannel(false);
            void setUpdateChannel("beta").catch(() => undefined);
          }}
          onCancel={() => setConfirmBetaChannel(false)}
        />
      ) : null}

      {pendingConfirm ? (
        <ConfirmModal
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          cancelLabel={t("cancel")}
          destructive
          onConfirm={() => {
            const { action } = pendingConfirm;
            setPendingConfirm(null);
            action();
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      ) : null}

      {showWifiSetupRebootModal ? (
        <ConfirmModal
          title={t("rebootWifiSetupConfirmTitle")}
          message={t("rebootWifiSetupConfirmMessage")}
          confirmLabel={t("rebootWifiSetup")}
          cancelLabel={t("cancel")}
          destructive
          onConfirm={() => {
            setShowWifiSetupRebootModal(false);
            void run(t("rebootWifiSetup"), { command: "reboot_wifi_setup" }).catch(() => undefined);
          }}
          onCancel={() => setShowWifiSetupRebootModal(false)}
        />
      ) : null}

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
          {renderActiveSection()}
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
        <div
          key={operationToast.id}
          className="operation-toast"
          data-state={operationToast.ok ? "success" : "error"}
          role="status"
          style={{ "--toast-ms": `${TOAST_MS}ms` } as CSSProperties}
        >
          <span className="operation-toast-icon" aria-hidden="true">
            {operationToast.ok ? <Check size={15} strokeWidth={2.4} /> : <X size={15} strokeWidth={2.4} />}
          </span>
          <div className="operation-toast-text">
            <strong>{operationToast.label}</strong>
            <span>{toastDetail(operationToast, t)}</span>
          </div>
          <button className="operation-toast-close" type="button" aria-label={t("closeToast")} onClick={dismissOperationToast}>
            <X size={14} />
          </button>
          <span className="operation-toast-timer" aria-hidden="true" />
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
