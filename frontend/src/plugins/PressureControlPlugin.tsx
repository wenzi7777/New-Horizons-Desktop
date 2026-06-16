import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { PressureCalServerPreset } from "../lib/api";
import { useI18n } from "../i18n";

const PRESSURE_MAX_KPA = 45;
const STABLE_TOLERANCE_KPA = 0.5;
const STABLE_CONFIRM_SAMPLES = 5;
const POLL_INTERVAL_MS = 500;

type PressurePhase = "idle" | "pressurizing" | "stabilizing" | "stable";

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

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stableCountRef = useRef(0);
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

  async function handleStart() {
    const kpa = parseFloat(targetInput);
    if (isNaN(kpa) || kpa < 0 || kpa > PRESSURE_MAX_KPA) return;
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
    setIsRunning(false);
    setPhase("idle");
    try {
      await api.pressureCalStop();
    } catch { /* ignore */ }
    setCurrentKpa(null);
  }

  const phaseLabel = (() => {
    switch (phase) {
      case "pressurizing": return t("pluginPressureControlPressurizing");
      case "stabilizing":  return t("pluginPressureControlStabilizing");
      case "stable":       return t("pluginPressureControlStable");
      default:             return t("pluginPressureControlIdle");
    }
  })();

  const pressureFillPercent = Math.max(0, Math.min(100, ((currentKpa ?? 0) / PRESSURE_MAX_KPA) * 100));
  const targetKpa = parseFloat(targetInput);
  const targetValid = !isNaN(targetKpa) && targetKpa >= 0 && targetKpa <= PRESSURE_MAX_KPA;

  return (
    <div className="pressure-control-plugin">
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
              onClick={() => void handleStart()}
              disabled={isRunning || !configured || !targetValid}
            >
              {t("pluginPressureControlStart")}
            </button>
            <button
              className="button danger"
              type="button"
              onClick={() => void handleStop()}
              disabled={!isRunning}
            >
              {t("pluginPressureControlStop")}
            </button>
          </div>

          {isRunning && (
            <div className={`pressure-phase-badge phase-${phase}`}>
              {phaseLabel}
            </div>
          )}
        </div>

        {/* Right: Live reading (shown while running or after first reading) */}
        {(isRunning || currentKpa !== null) && (
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
