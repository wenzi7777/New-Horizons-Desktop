import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { api, type DeviceEntry, type PressureCalReadings } from "../lib/api";

const PRESETS: Record<string, number[]> = {
  quick:    [0, 20, 45],
  standard: [0, 10, 20, 35, 45],
  detailed: [0, 5, 10, 20, 30, 40, 45],
  fine:     [0, 5, 10, 15, 20, 25, 30, 38, 45],
};
const MAX_KPA = 45;

type CalPhase =
  | "idle"
  | "starting_session"
  | "setting_pressure"
  | "stabilizing"
  | "capturing"
  | "stopping_pressure"
  | "committing"
  | "done"
  | "error"
  | "aborting";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function PressureCalibrationPage() {
  const { t } = useI18n();

  // --- State ---
  const [phase, setPhase] = useState<CalPhase>("idle");
  const [pointIndex, setPointIndex] = useState(0);
  const [points, setPoints] = useState<number[]>(PRESETS.standard);
  const [currentKpa, setCurrentKpa] = useState<number | null>(null);
  const [currentImada, setCurrentImada] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [selectedDeviceUid, setSelectedDeviceUid] = useState("");
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [settings, setSettings] = useState<{ url: string; token: string; configured: boolean }>({
    url: "",
    token: "",
    configured: false,
  });
  const [settingsUrl, setSettingsUrl] = useState("");
  const [settingsToken, setSettingsToken] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [presetKey, setPresetKey] = useState("standard");
  const [newPointInput, setNewPointInput] = useState("");

  // --- Refs ---
  const abortRef = useRef(false);
  const stableCountRef = useRef(0);

  // --- Derived ---
  const isRunning = phase !== "idle" && phase !== "done" && phase !== "error";

  const phaseLabel: string = (() => {
    switch (phase) {
      case "idle":             return t("pressureCalStateIdle");
      case "starting_session": return t("pressureCalStateStartingSession");
      case "setting_pressure": return t("pressureCalStateSettingPressure");
      case "stabilizing":      return t("pressureCalStateStabilizing");
      case "capturing":        return t("pressureCalStateCapturing");
      case "stopping_pressure":return t("pressureCalStateStoppingPressure");
      case "committing":       return t("pressureCalStateCommitting");
      case "done":             return t("pressureCalStateDone");
      case "aborting":         return t("pressureCalStateAborting");
      case "error":            return t("pressureCalStateError");
      default:                 return phase;
    }
  })();

  // --- Helpers ---
  const addLog = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
  }, []);

  // --- useEffect: fetch settings on mount ---
  useEffect(() => {
    api.pressureCalSettings().then((s) => {
      setSettings({ url: s.url, token: "", configured: s.configured });
      setSettingsUrl(s.url);
    }).catch(() => {});
  }, []);

  // --- useEffect: fetch devices on mount ---
  useEffect(() => {
    api.devices().then((r) => setDevices(r.items)).catch(() => {});
  }, []);

  // --- useEffect: abort on unmount ---
  useEffect(() => {
    return () => { abortRef.current = true; };
  }, []);

  // --- useEffect: idle polling ---
  useEffect(() => {
    if (phase !== "idle" || !settings.configured) return;
    const id = setInterval(async () => {
      try {
        const r = await api.pressureCalReadings();
        setCurrentKpa(r.uno.pressure_kpa);
        setCurrentImada(r.imada.value);
      } catch {
        // ignore
      }
    }, 2000);
    return () => clearInterval(id);
  }, [phase, settings.configured]);

  // --- Save settings ---
  async function handleSaveSettings() {
    setSettingsSaving(true);
    setSettingsError("");
    try {
      await api.savePressureCalSettings(settingsUrl, settingsToken);
      const s = await api.pressureCalSettings();
      setSettings({ url: s.url, token: "", configured: s.configured });
      setSettingsUrl(s.url);
      setSettingsToken("");
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  }

  // --- Preset change ---
  function handlePresetChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const key = e.target.value;
    setPresetKey(key);
    if (key in PRESETS) {
      setPoints(PRESETS[key]);
    }
  }

  // --- Add point ---
  function handleAddPoint() {
    const val = parseFloat(newPointInput);
    if (Number.isNaN(val) || val < 0 || val > MAX_KPA) return;
    setPoints((prev) => {
      if (prev.includes(val)) return prev;
      return [...prev, val].sort((a, b) => a - b);
    });
    setPresetKey("custom");
    setNewPointInput("");
  }

  // --- Remove point ---
  function removePoint(index: number) {
    setPoints((prev) => prev.filter((_, i) => i !== index));
    setPresetKey("custom");
  }

  // --- Wait for stable ---
  async function waitForStable(targetKpa: number): Promise<number> {
    let lastImada = 0;
    while (true) {
      if (abortRef.current) return lastImada;
      let readings: PressureCalReadings;
      try {
        readings = await api.pressureCalReadings();
      } catch {
        await sleep(500);
        continue;
      }
      setCurrentKpa(readings.uno.pressure_kpa);
      setCurrentImada(readings.imada.value);
      lastImada = readings.imada.value;
      if (Math.abs(readings.uno.pressure_kpa - targetKpa) < 0.5) {
        stableCountRef.current++;
        if (stableCountRef.current >= 5) return lastImada;
      } else {
        stableCountRef.current = 0;
      }
      await sleep(500);
    }
  }

  // --- Run calibration ---
  async function runCalibration() {
    abortRef.current = false;
    setLog([]);
    setError("");
    setPointIndex(0);
    const sortedPoints = [...points].sort((a, b) => a - b);

    try {
      // 1. Begin session
      setPhase("starting_session");
      addLog("Starting calibration session...");
      await api.queueDeviceCommand(selectedDeviceUid, { command: "calibration_session_begin" });
      await sleep(1000);

      // 2. For each point
      for (let i = 0; i < sortedPoints.length; i++) {
        if (abortRef.current) break;
        const targetKpa = sortedPoints[i];
        setPointIndex(i);

        // 2a. Set pressure
        setPhase("setting_pressure");
        addLog(`Setting pressure to ${targetKpa} kPa...`);
        await api.pressureCalSetTarget(targetKpa);
        stableCountRef.current = 0;

        // 2b. Wait for stable
        setPhase("stabilizing");
        addLog(`Waiting for pressure to stabilize at ${targetKpa} kPa...`);
        const imadaValue = await waitForStable(targetKpa);
        if (abortRef.current) break;

        // 2c. Capture
        setPhase("capturing");
        addLog(`Capturing sensors at IMADA=${imadaValue.toFixed(3)} N...`);
        await api.queueDeviceCommand(selectedDeviceUid, {
          command: "calibration_capture_all",
          level: imadaValue,
          duration_ms: 3000,
        });
        await sleep(4000);
        if (abortRef.current) break;

        addLog(`Point ${i + 1}/${sortedPoints.length} complete.`);
      }

      if (abortRef.current) {
        // Emergency stop path
        setPhase("aborting");
        addLog("Aborting: stopping pressure...");
        try { await api.pressureCalStop(); } catch { /* ignore */ }
        try {
          await api.queueDeviceCommand(selectedDeviceUid, { command: "calibration_session_abort" });
        } catch { /* ignore */ }
        addLog("Calibration aborted.");
        setPhase("idle");
        return;
      }

      // 3. Stop pressure
      setPhase("stopping_pressure");
      addLog("Stopping pressure...");
      await api.pressureCalStop();

      // 4. Commit
      setPhase("committing");
      addLog("Committing calibration session...");
      await api.queueDeviceCommand(selectedDeviceUid, {
        command: "calibration_session_commit",
        auto_enable: true,
      });
      await sleep(1000);

      addLog("Calibration complete!");
      setPhase("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase("error");
      addLog(`Error: ${msg}`);
      try { await api.pressureCalStop(); } catch { /* ignore */ }
    }
  }

  // --- Handlers ---
  function handleStart() {
    void runCalibration();
  }

  function handleEmergencyStop() {
    abortRef.current = true;
  }

  return (
    <>
      <section className="page-header">
        <h2>{t("pressureCalibration")}</h2>
      </section>

      {/* Settings Panel */}
      <section className="panel">
        <h3>{t("pressureCalApiSettings")}</h3>
        <div className="field-row">
          <label>{t("pressureCalApiUrl")}</label>
          <input
            type="url"
            value={settingsUrl}
            onChange={(e) => setSettingsUrl(e.target.value)}
          />
        </div>
        <div className="field-row">
          <label>{t("pressureCalApiToken")}</label>
          <input
            type="password"
            value={settingsToken}
            onChange={(e) => setSettingsToken(e.target.value)}
          />
        </div>
        <button onClick={handleSaveSettings} disabled={settingsSaving}>
          {t("pressureCalApiSave")}
        </button>
        {settingsError && <p className="notice error">{settingsError}</p>}
        {!settings.configured && !settingsError && (
          <p className="notice">{t("pressureCalApiNotConfigured")}</p>
        )}
      </section>

      {/* Live Readings */}
      {settings.configured && (
        <section className="panel">
          <h3>{t("pressureCalCurrentReadings")}</h3>
          <div className="fact-row">
            <span>{t("pressureCalUnoKpa")}</span>
            <strong>{currentKpa !== null ? `${currentKpa.toFixed(3)} kPa` : "-"}</strong>
          </div>
          <div className="fact-row">
            <span>{t("pressureCalImadaN")}</span>
            <strong>{currentImada !== null ? `${currentImada.toFixed(3)} N` : "-"}</strong>
          </div>
        </section>
      )}

      {/* Calibration Points */}
      <section className="panel">
        <h3>{t("pressureCalPoints")}</h3>
        <div className="field-row">
          <label>{t("pressureCalPointsPreset")}</label>
          <select value={presetKey} onChange={handlePresetChange} disabled={isRunning}>
            {Object.keys(PRESETS).map((key) => (
              <option key={key} value={key}>
                {t(`pressureCalPreset${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
              </option>
            ))}
            <option value="custom">{t("pressureCalPresetCustom")}</option>
          </select>
        </div>
        <ul>
          {points.map((p, i) => (
            <li key={i}>
              {p} {t("pressureCalPointUnit")}
              {!isRunning && (
                <button onClick={() => removePoint(i)}>{t("pressureCalRemovePoint")}</button>
              )}
            </li>
          ))}
        </ul>
        {!isRunning && (
          <div className="field-row">
            <input
              type="number"
              min={0}
              max={MAX_KPA}
              value={newPointInput}
              onChange={(e) => setNewPointInput(e.target.value)}
              placeholder="kPa"
            />
            <button onClick={handleAddPoint}>{t("pressureCalAddPoint")}</button>
          </div>
        )}
        <small className="notice">{t("pressureCalSafetyLimit")}</small>
      </section>

      {/* Device Select */}
      <section className="panel">
        <label>{t("pressureCalDeviceSelect")}</label>
        <select
          value={selectedDeviceUid}
          onChange={(e) => setSelectedDeviceUid(e.target.value)}
          disabled={isRunning}
        >
          <option value="">{t("pressureCalNoDevice")}</option>
          {devices.map((d) => (
            <option key={d.device_uid} value={d.device_uid}>
              {d.display_name || d.device_uid}
            </option>
          ))}
        </select>
      </section>

      {/* Progress */}
      {phase !== "idle" && (
        <section className="panel">
          <h3>{t("pressureCalProgress")}</h3>
          <p>{phaseLabel}</p>
          {phase !== "done" && phase !== "error" && (
            <progress value={pointIndex} max={points.length} />
          )}
          <ul className="operation-log">
            {log.slice(-10).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          {phase === "error" && <p className="notice error">{error}</p>}
        </section>
      )}

      {/* Controls */}
      <section className="panel">
        <button
          className="button"
          onClick={handleStart}
          disabled={isRunning || !settings.configured || !selectedDeviceUid || points.length === 0}
        >
          {t("pressureCalStart")}
        </button>
        {isRunning && (
          <button className="button danger" onClick={handleEmergencyStop}>
            {t("pressureCalEmergencyStop")}
          </button>
        )}
      </section>
    </>
  );
}
