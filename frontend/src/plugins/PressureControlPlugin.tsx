import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { PressureCalImadaReading, PressureCalServerPreset } from "../lib/api";
import { useI18n } from "../i18n";
import { ConfirmModal } from "../components/ConfirmModal";
import { TriangleAlert } from "lucide-react";

const PRESSURE_MAX_KPA = 45;
const PRESSURE_BASELINE_KPA = 3.5;
const PRESSURE_RESIDUAL_TEST_KPA = 10;
const PRESSURE_RESIDUAL_TEST_TIMEOUT_MS = 15000;
const STABLE_TOLERANCE_KPA = 0.5;
const STABLE_CONFIRM_SAMPLES = 5;
const POLL_INTERVAL_MS = 500;

type PressurePhase =
  | "idle" | "pressurizing" | "stabilizing" | "stable"
  | "stopping" | "awaiting_compressor_off" | "testing_residual"
  | "residual_unsafe" | "safe_done";

export function PressureControlPlugin() {
  const { t } = useI18n();

  // API settings state
  const [serverPresets, setServerPresets] = useState<PressureCalServerPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState("lab_pi");
  const [customUrl, setCustomUrl] = useState("");
  const [customToken, setCustomToken] = useState("");
  const [configured, setConfigured] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Control state
  const [targetInput, setTargetInput] = useState("10");
  const [isRunning, setIsRunning] = useState(false);
  const [phase, setPhase] = useState<PressurePhase>("idle");
  const [currentKpa, setCurrentKpa] = useState<number | null>(null);
  const [imadaReading, setImadaReading] = useState<PressureCalImadaReading | null>(null);
  const [showCompressorOffBanner, setShowCompressorOffBanner] = useState(false);
  const [showCompressorOnModal, setShowCompressorOnModal] = useState(false);
  const [showCompressorOffModal, setShowCompressorOffModal] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stableCountRef = useRef(0);
  const abortShutdownRef = useRef(false);
  // Keep a ref to targetInput so the polling closure always reads the latest value
  const targetInputRef = useRef(targetInput);
  useEffect(() => { targetInputRef.current = targetInput; }, [targetInput]);

  useEffect(() => {
    api.pressureCalSettings().then((s) => {
      setConfigured(s.configured);
      setServerPresets(s.presets ?? []);
      setSelectedPreset(s.preset ?? "lab_pi");
      if (s.url) setCustomUrl(s.url);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (isRunning) {
      pollRef.current = setInterval(() => { void pollReadings(); }, POLL_INTERVAL_MS);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
      stableCountRef.current = 0;
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  async function pollReadings() {
    try {
      const r = await api.pressureCalReadings();
      const kpa = r.uno.pressure_kpa;
      setCurrentKpa(kpa);
      setImadaReading(r.imada);
      if (r.uno.safety_latched) setPhase("pressurizing"); // safety recovery: UNO retargeted to baseline

      const target = parseFloat(targetInputRef.current);
      if (isNaN(target)) return;

      if (Math.abs(kpa - target) <= STABLE_TOLERANCE_KPA) {
        stableCountRef.current += 1;
        setPhase(stableCountRef.current >= STABLE_CONFIRM_SAMPLES ? "stable" : "stabilizing");
      } else {
        stableCountRef.current = 0;
        setPhase("pressurizing");
      }
    } catch { /* ignore transient errors */ }
  }

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
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  }

  function handleStart() {
    const kpa = parseFloat(targetInput);
    if (isNaN(kpa) || kpa < 0 || kpa > PRESSURE_MAX_KPA) return;
    setShowCompressorOnModal(true);
  }

  async function handleStartConfirmed() {
    setShowCompressorOnModal(false);
    setShowCompressorOffBanner(false);
    const kpa = parseFloat(targetInput);
    try {
      await api.pressureCalSetTarget(kpa);
      stableCountRef.current = 0;
      setCurrentKpa(null);
      setPhase("pressurizing");
      setIsRunning(true);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStop() {
    // Stop the live polling loop; residual test does its own manual polling.
    setIsRunning(false);
    abortShutdownRef.current = false;
    setPhase("stopping");
    // Hold at baseline so the intake valve stops feeding air before we ask the
    // user to turn off the compressor.
    try { await api.pressureCalSetTarget(PRESSURE_BASELINE_KPA); } catch { /* ignore */ }
    setPhase("awaiting_compressor_off");
    setShowCompressorOffModal(true);
  }

  async function waitForResidualOrTimeout(targetKpa: number, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    let stable = 0;
    while (Date.now() - startedAt < timeoutMs) {
      if (abortShutdownRef.current) return false;
      try {
        const r = await api.pressureCalReadings();
        setCurrentKpa(r.uno.pressure_kpa);
        setImadaReading(r.imada);
        if (Math.abs(r.uno.pressure_kpa - targetKpa) < STABLE_TOLERANCE_KPA) {
          stable++;
          if (stable >= STABLE_CONFIRM_SAMPLES) return true;
        } else {
          stable = 0;
        }
      } catch { /* ignore */ }
      await new Promise<void>((res) => setTimeout(res, POLL_INTERVAL_MS));
    }
    return false;
  }

  async function runResidualSafetyTest() {
    setShowCompressorOffModal(false);
    abortShutdownRef.current = false;
    try {
      setPhase("testing_residual");
      await api.pressureCalSetTarget(PRESSURE_RESIDUAL_TEST_KPA);
      const reached = await waitForResidualOrTimeout(PRESSURE_RESIDUAL_TEST_KPA, PRESSURE_RESIDUAL_TEST_TIMEOUT_MS);
      if (abortShutdownRef.current) {
        try { await api.pressureCalStop(); } catch { /* ignore */ }
        setPhase("idle");
        setCurrentKpa(null);
        setImadaReading(null);
        return;
      }
      if (reached) {
        // Residual still high — not safe to disable. Return to baseline and wait.
        try { await api.pressureCalSetTarget(PRESSURE_BASELINE_KPA); } catch { /* ignore */ }
        setPhase("residual_unsafe");
      } else {
        // Residual depleted — safe to disable.
        await api.pressureCalStop();
        setPhase("safe_done");
      }
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
      try { await api.pressureCalStop(); } catch { /* ignore */ }
      setPhase("idle");
      setCurrentKpa(null);
      setImadaReading(null);
    }
  }

  const isShuttingDown = phase === "stopping" || phase === "awaiting_compressor_off"
    || phase === "testing_residual" || phase === "residual_unsafe";

  const phaseLabel = (() => {
    switch (phase) {
      case "pressurizing":          return t("pluginPressureControlPressurizing");
      case "stabilizing":           return t("pluginPressureControlStabilizing");
      case "stable":                return t("pluginPressureControlStable");
      case "stopping":              return t("pressureCalStateStoppingPressure");
      case "awaiting_compressor_off": return t("pressureCalStateAwaitingCompressorOff");
      case "testing_residual":      return t("pressureCalStateTestingResidual");
      case "residual_unsafe":       return t("pressureCalStateResidualUnsafe");
      case "safe_done":             return t("pressureCalStateSafeDone");
      default:                      return t("pluginPressureControlIdle");
    }
  })();

  const pressureFillPercent = Math.max(0, Math.min(100, ((currentKpa ?? 0) / PRESSURE_MAX_KPA) * 100));
  const targetKpa = parseFloat(targetInput);
  const targetValid = !isNaN(targetKpa) && targetKpa >= 0 && targetKpa <= PRESSURE_MAX_KPA;

  return (
    <div className="pressure-control-plugin">
      {showCompressorOffBanner && (
        <div className="compressor-safety-banner">
          <span className="banner-icon"><TriangleAlert size={22} strokeWidth={1.8} /></span>
          <span className="banner-text">{t("compressorOffBanner")}</span>
          <button className="banner-dismiss" type="button" onClick={() => setShowCompressorOffBanner(false)}>
            {t("compressorOffDismiss")}
          </button>
        </div>
      )}
      {phase === "awaiting_compressor_off" && !showCompressorOffModal && (
        <div className="actions compact">
          <button className="button primary" type="button" onClick={() => setShowCompressorOffModal(true)}>
            {t("compressorOffConfirmOk")}
          </button>
        </div>
      )}
      {/* API Settings */}
      <div className="settings-card">
        <div className="settings-detail-header">
          <h4>{t("pluginPressureControlApiSettings")}</h4>
          <button
            className="button primary"
            type="button"
            disabled={settingsSaving || isRunning}
            onClick={() => void handleSaveSettings()}
          >
            {settingsSaving ? "…" : t("pressureCalApiSave")}
          </button>
        </div>
        <div className="field-grid">
          <div className="field">
            <label>{t("pressureCalServer")}</label>
            <select
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
              disabled={isRunning}
            >
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
              <input
                type="url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                disabled={isRunning}
              />
            </div>
            <div className="field">
              <label>{t("pressureCalApiToken")}</label>
              <input
                type="password"
                value={customToken}
                onChange={(e) => setCustomToken(e.target.value)}
                placeholder={configured ? "••••••••" : ""}
                disabled={isRunning}
              />
            </div>
          </div>
        )}
        {settingsError && <p className="notice error">{settingsError}</p>}
        {settingsSaved && !settingsError && <p className="notice success">Saved.</p>}
        {!configured && !settingsError && (
          <p className="notice">{t("pluginPressureControlNotConfigured")}</p>
        )}
      </div>

      {/* Control + Live reading */}
      <div className="pressure-control-layout">
        {/* Left: Manual control */}
        <div className="settings-card pressure-control-main">
          <h4>{t("pluginPressureControlName")}</h4>

          <div className="field">
            <label>{t("pluginPressureControlTarget")}</label>
            <div className="pressure-input-row">
              <input
                type="number"
                min={0}
                max={PRESSURE_MAX_KPA}
                step={0.5}
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                disabled={isRunning}
              />
              <span>kPa</span>
            </div>
            <small className="field-hint">{t("pluginPressureControlSafetyLimit")}</small>
          </div>

          <div className="pressure-control-buttons">
            <button
              className="button primary"
              type="button"
              onClick={handleStart}
              disabled={isRunning || isShuttingDown || phase === "safe_done" || !configured || !targetValid}
            >
              {t("pluginPressureControlStart")}
            </button>
            <button
              className="button danger"
              type="button"
              onClick={() => void handleStop()}
              disabled={!isRunning || isShuttingDown}
            >
              {t("pluginPressureControlStop")}
            </button>
          </div>

          {(isRunning || isShuttingDown || phase === "safe_done") && (
            <div className={`pressure-phase-badge phase-${phase}`}>
              {phaseLabel}
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

          {phase === "safe_done" && (
            <p className="notice success">{t("residualSafeMessage")}</p>
          )}
        </div>

        {/* Right: Live reading (shown while running, shutting down, or after first reading) */}
        {(isRunning || isShuttingDown || currentKpa !== null) && (
          <div className="settings-card pressure-live-panel">
            <h4>{t("pluginPressureControlLiveReading")}</h4>
            <div
              className="pressure-live-bar-track"
              aria-label={t("pluginPressureControlLiveReading")}
            >
              <div
                className="pressure-live-bar-fill"
                style={{ width: `${pressureFillPercent}%` }}
              />
            </div>
            <div className="pressure-live-values">
              <span>
                {t("pluginPressureControlCurrentKpa")}:{" "}
                <strong>{currentKpa !== null ? `${currentKpa.toFixed(2)} kPa` : "—"}</strong>
              </span>
              {isRunning && (
                <span>
                  {t("pluginPressureControlTargetKpa")}:{" "}
                  <strong>{targetValid ? `${targetKpa.toFixed(2)} kPa` : "—"}</strong>
                </span>
              )}
              <span>
                {t("pluginPressureControlRefSensor")}:{" "}
                {imadaReading !== null ? (
                  <strong>{`${imadaReading.value.toFixed(2)} ${imadaReading.unit}`}</strong>
                ) : (
                  <strong className="ref-not-connected">{t("pressureCalRefNotConnected")}</strong>
                )}
              </span>
            </div>
          </div>
        )}
      </div>

      {showCompressorOnModal && (
        <ConfirmModal
          title={t("compressorOnConfirmTitle")}
          message={t("compressorOnConfirm")}
          confirmLabel={t("compressorOnConfirmOk")}
          cancelLabel={t("cancel")}
          onConfirm={() => void handleStartConfirmed()}
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
