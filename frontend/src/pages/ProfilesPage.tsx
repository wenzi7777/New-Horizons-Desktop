import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";

import { useI18n } from "../i18n";
import { api, type ProfileListEntry, type VisualizationEntry } from "../lib/api";
import { fitProfileRect } from "../lib/profileLayout";
import { valueToCsv } from "../lib/valueFormat";
import { useWsState } from "../lib/wsClient";

type ProfileDisplayMode = "2d" | "3d";
type ProfileTool = "add" | "select" | "move" | "delete";

type ProfileSensor = {
  id: number;
  index: number;
  x: number;
  y: number;
  label: string;
  enabled: boolean;
};

type ProfileDraft = {
  version: number;
  name: string;
  deviceType: string;
  matrix: {
    rows: number;
    cols: number;
  };
  activeRows: number[];
  activeCols: number[];
  background: {
    imageData: string;
    aspectRatio: number;
  };
  sensors: ProfileSensor[];
  display: {
    mode: ProfileDisplayMode;
    pressureMin: number;
    pressureMax: number;
    dotSize: number;
  };
  notes: string;
};

type StageSize = {
  width: number;
  height: number;
};

const EMPTY_PROFILE: ProfileDraft = {
  version: 1,
  name: "",
  deviceType: "custom",
  matrix: { rows: 10, cols: 21 },
  activeRows: [],
  activeCols: [],
  background: { imageData: "", aspectRatio: 1 },
  sensors: [],
  display: { mode: "3d", pressureMin: 300, pressureMax: 1000, dotSize: 1 },
  notes: "",
};

function normalizeUid(value: unknown) {
  return String(value ?? "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}

function clampZoom(value: number) {
  return clamp(value, 0.2, 12);
}

function numberOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsvInts(value: string): number[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value));
}

function formatCsv(values: unknown): string {
  return Array.isArray(values) ? values.join(",") : "";
}

function sensorColor(sensor: ProfileSensor, total: number) {
  const ratio = total > 1 ? sensor.id / Math.max(total, 1) : 0;
  const hue = 154 - ratio * 112;
  return `hsl(${hue}deg 68% 54%)`;
}

function normalizeProfile(data: Record<string, unknown>): ProfileDraft {
  const matrix = data.matrix && typeof data.matrix === "object" ? (data.matrix as Record<string, unknown>) : {};
  const background =
    data.background && typeof data.background === "object" ? (data.background as Record<string, unknown>) : {};
  const display = data.display && typeof data.display === "object" ? (data.display as Record<string, unknown>) : {};
  const sensors = Array.isArray(data.sensors) ? data.sensors : [];
  const normalizedSensors = sensors.map((rawSensor, index) => {
    const sensor = rawSensor && typeof rawSensor === "object" ? (rawSensor as Record<string, unknown>) : {};
    return {
      id: index + 1,
      index: Math.max(0, Math.floor(numberOr(sensor.index, index))),
      x: clamp01(numberOr(sensor.x, 0.5)),
      y: clamp01(numberOr(sensor.y, 0.5)),
      label: String(sensor.label ?? `P${index}`),
      enabled: sensor.enabled !== false,
    };
  });
  const pressureMin = numberOr(display.pressureMin ?? display.pressure_min, EMPTY_PROFILE.display.pressureMin);
  const pressureMax = numberOr(display.pressureMax ?? display.pressure_max, EMPTY_PROFILE.display.pressureMax);
  const dotSize = clamp(numberOr(display.dotSize ?? display.dot_size, EMPTY_PROFILE.display.dotSize), 0.5, 4);
  return {
    version: Math.max(1, Math.floor(numberOr(data.version, 1))),
    name: String(data.name ?? ""),
    deviceType: String(data.deviceType ?? "custom"),
    matrix: {
      rows: Math.max(1, Math.floor(numberOr(matrix.rows, EMPTY_PROFILE.matrix.rows))),
      cols: Math.max(1, Math.floor(numberOr(matrix.cols, EMPTY_PROFILE.matrix.cols))),
    },
    activeRows: Array.isArray(data.activeRows) ? data.activeRows.map(Number).filter(Number.isFinite) : [],
    activeCols: Array.isArray(data.activeCols) ? data.activeCols.map(Number).filter(Number.isFinite) : [],
    background: {
      imageData: String(background.imageData ?? ""),
      aspectRatio: Math.max(0.01, numberOr(background.aspectRatio, 1)),
    },
    sensors: normalizedSensors,
    display: {
      mode: display.mode === "2d" ? "2d" : "3d",
      pressureMin,
      pressureMax: Math.max(pressureMax, pressureMin + 1),
      dotSize,
    },
    notes: String(data.notes ?? ""),
  };
}

function serializeProfile(draft: ProfileDraft) {
  return {
    version: draft.version,
    name: draft.name,
    deviceType: draft.deviceType,
    matrix: {
      rows: draft.matrix.rows,
      cols: draft.matrix.cols,
    },
    activeRows: draft.activeRows,
    activeCols: draft.activeCols,
    background: {
      imageData: draft.background.imageData,
      aspectRatio: draft.background.aspectRatio,
    },
    sensors: draft.sensors.map((sensor) => ({
      index: sensor.index,
      x: Number(sensor.x.toFixed(6)),
      y: Number(sensor.y.toFixed(6)),
      label: sensor.label,
      enabled: sensor.enabled,
    })),
    display: {
      mode: draft.display.mode,
      pressureMin: draft.display.pressureMin,
      pressureMax: draft.display.pressureMax,
      dotSize: Number(draft.display.dotSize.toFixed(2)),
    },
    notes: draft.notes,
  };
}

function jsonCsvForDraft(draft: ProfileDraft) {
  return valueToCsv(serializeProfile(draft));
}

function rawJsonForDraft(draft: ProfileDraft) {
  return JSON.stringify(serializeProfile(draft), null, 2);
}

function profileKeyFromName(value: string) {
  return (value || "new_profile").trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_-]/g, "_");
}

function nearestSensor(sensors: ProfileSensor[], x: number, y: number): ProfileSensor | null {
  let nearest: ProfileSensor | null = null;
  let bestDistance = Infinity;
  for (const sensor of sensors) {
    const dx = sensor.x - x;
    const dy = sensor.y - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < bestDistance) {
      nearest = sensor;
      bestDistance = distance;
    }
  }
  return bestDistance <= 0.045 ? nearest : null;
}

function displayNameForProfile(item: ProfileListEntry) {
  return item.displayName || item.name;
}

function monitorValuesForDevice(items: VisualizationEntry[], deviceUid: string) {
  const normalized = normalizeUid(deviceUid);
  return items.find((item) => normalizeUid(item.dn) === normalized)?.p ?? [];
}

export function ProfilesPage() {
  const { t } = useI18n();
  const { devices, visualizations, status: wsStatus, subscribeVisualization, unsubscribeVisualization } = useWsState();
  const [profiles, setProfiles] = useState<ProfileListEntry[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE);
  const [showRawJson, setShowRawJson] = useState(false);
  const [statusMessage, setStatusMessage] = useState(t("profileStart"));
  const [errorMessage, setErrorMessage] = useState("");
  const [tool, setTool] = useState<ProfileTool>("add");
  const [selectedSensorId, setSelectedSensorId] = useState<number | null>(null);
  const [dragSensorId, setDragSensorId] = useState<number | null>(null);
  const [panMode, setPanMode] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [cursorPosition, setCursorPosition] = useState<{ x: number; y: number } | null>(null);
  const [stageSize, setStageSize] = useState<StageSize>({ width: 0, height: 0 });
  const [monitorDeviceUid, setMonitorDeviceUid] = useState("");
  const stageViewportRef = useRef<HTMLDivElement | null>(null);
  const stageSceneRef = useRef<HTMLDivElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLInputElement | null>(null);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });

  const selectedSensor = useMemo(
    () => draft.sensors.find((sensor) => sensor.id === selectedSensorId) ?? null,
    [draft.sensors, selectedSensorId],
  );
  const jsonCsvText = useMemo(() => jsonCsvForDraft(draft), [draft]);
  const rawJsonText = useMemo(() => rawJsonForDraft(draft), [draft]);
  const stageAspectRatio = useMemo(() => Math.max(0.01, draft.background.aspectRatio || 1), [draft.background.aspectRatio]);
  const sceneRect = useMemo(
    () => fitProfileRect(stageSize.width, stageSize.height, stageAspectRatio),
    [stageAspectRatio, stageSize.height, stageSize.width],
  );
  const markerSize = useMemo(() => {
    const shortSide = Math.min(sceneRect.drawWidth || 0, sceneRect.drawHeight || 0);
    const baseSize = shortSide > 0 ? shortSide * 0.028 * draft.display.dotSize : 18;
    return clamp(baseSize, 18, 40);
  }, [draft.display.dotSize, sceneRect.drawHeight, sceneRect.drawWidth]);
  const markerFontSize = useMemo(() => clamp(markerSize * 0.28, 7, 11), [markerSize]);
  const zoomInfo = `${Math.round(zoom * 100)}%`;
  const cursorInfo = cursorPosition ? `${cursorPosition.x.toFixed(3)}, ${cursorPosition.y.toFixed(3)}` : "-";

  const monitorValues = useMemo(() => monitorValuesForDevice(visualizations, monitorDeviceUid), [monitorDeviceUid, visualizations]);
  const monitorMax = useMemo(() => Math.max(1, ...monitorValues.map((value) => Number(value) || 0)), [monitorValues]);

  function setDraftProfile(next: ProfileDraft) {
    setDraft(next);
  }

  function updateDraft(updater: (current: ProfileDraft) => ProfileDraft) {
    setDraft((current) => updater(current));
  }

  function resetStageView() {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPanX(0);
    setPanY(0);
    setPanMode(false);
    setIsPanning(false);
    setDragSensorId(null);
    setCursorPosition(null);
  }

  function applyPan(nextPanX: number, nextPanY: number) {
    panRef.current = { x: nextPanX, y: nextPanY };
    setPanX(nextPanX);
    setPanY(nextPanY);
  }

  function applyZoom(nextZoom: number) {
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
  }

  async function loadProfiles(preferredName?: string) {
    const response = await api.profiles();
    setProfiles(response.items);
    const nextName = preferredName ?? selectedName;
    if (nextName && response.items.some((item) => item.name === nextName)) {
      setSelectedName(nextName);
      const data = await api.profile(nextName);
      setDraftProfile(normalizeProfile(data));
    }
  }

  useEffect(() => {
    void loadProfiles().catch((error: Error) => setErrorMessage(error.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!monitorDeviceUid && devices[0]?.device_uid) {
      setMonitorDeviceUid(normalizeUid(devices[0].device_uid));
    }
  }, [devices, monitorDeviceUid]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = { x: panX, y: panY };
  }, [panX, panY]);

  useEffect(() => {
    if (!monitorDeviceUid) return undefined;
    subscribeVisualization(monitorDeviceUid);
    return () => unsubscribeVisualization(monitorDeviceUid);
  }, [monitorDeviceUid, subscribeVisualization, unsubscribeVisualization]);

  useEffect(() => {
    const viewport = stageViewportRef.current;
    if (!viewport) return undefined;
    const update = () => {
      setStageSize({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  function scenePoint(event: Pick<PointerEvent<Element>, "clientX" | "clientY"> | Pick<WheelEvent<Element>, "clientX" | "clientY">) {
    const scene = stageSceneRef.current;
    if (!scene) return null;
    const rect = scene.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  }

  function beginPanning(event: PointerEvent<HTMLDivElement>) {
    panStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function zoomAt(clientX: number, clientY: number, factor: number) {
    const viewport = stageViewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const currentZoom = zoomRef.current;
    const nextZoom = clampZoom(currentZoom * factor);
    const appliedFactor = nextZoom / currentZoom;
    applyPan(
      cx - (cx - panRef.current.x) * appliedFactor,
      cy - (cy - panRef.current.y) * appliedFactor,
    );
    applyZoom(nextZoom);
  }

  function zoomFromCenter(factor: number) {
    const viewport = stageViewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  function fitStageContent() {
    resetStageView();
  }

  function addSensorAt(x: number, y: number) {
    let nextId = 1;
    let nextIndex = 0;
    updateDraft((current) => {
      nextId = current.sensors.reduce((maxId, sensor) => Math.max(maxId, sensor.id), 0) + 1;
      nextIndex = current.sensors.length;
      return {
        ...current,
        sensors: [
          ...current.sensors,
          {
            id: nextId,
            index: nextIndex,
            x,
            y,
            label: `P${nextIndex}`,
            enabled: true,
          },
        ],
      };
    });
    setSelectedSensorId(nextId);
  }

  function updateSensor(id: number, patch: Partial<ProfileSensor>) {
    updateDraft((current) => ({
      ...current,
      sensors: current.sensors.map((sensor) => (sensor.id === id ? { ...sensor, ...patch } : sensor)),
    }));
  }

  function removeSensor(id: number) {
    updateDraft((current) => ({
      ...current,
      sensors: current.sensors.filter((sensor) => sensor.id !== id),
    }));
    if (selectedSensorId === id) setSelectedSensorId(null);
  }

  function handleStagePointerDown(event: PointerEvent<HTMLDivElement>) {
    const point = scenePoint(event);
    if (!point) return;
    const hit = nearestSensor(draft.sensors, point.x, point.y);
    if (panMode || event.button === 1 || (tool === "select" && !hit)) {
      beginPanning(event);
      return;
    }
    if (tool === "delete") {
      if (hit) removeSensor(hit.id);
      return;
    }
    if (hit) {
      setSelectedSensorId(hit.id);
      if (tool === "move" || tool === "select" || tool === "add") {
        setDragSensorId(hit.id);
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (tool === "add") {
      addSensorAt(point.x, point.y);
    }
  }

  function handleStagePointerMove(event: PointerEvent<HTMLDivElement>) {
    const point = scenePoint(event);
    setCursorPosition(point);
    if (isPanning) {
      applyPan(
        panStartRef.current.panX + (event.clientX - panStartRef.current.x),
        panStartRef.current.panY + (event.clientY - panStartRef.current.y),
      );
      return;
    }
    if (dragSensorId === null || !point) return;
    updateSensor(dragSensorId, point);
  }

  function handleStagePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (isPanning) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
    }
    if (dragSensorId !== null) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
    }
    setIsPanning(false);
    setDragSensorId(null);
  }

  function handleStageWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(event.clientX, event.clientY, factor);
  }

  async function handleSelect(name: string) {
    setSelectedName(name);
    setErrorMessage("");
    if (!name) {
      setDraftProfile(EMPTY_PROFILE);
      setSelectedSensorId(null);
      resetStageView();
      return;
    }
    try {
      const data = await api.profile(name);
      setDraftProfile(normalizeProfile(data));
      setSelectedSensorId(null);
      resetStageView();
      setStatusMessage(t("profileLoaded"));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "profile_load_failed");
    }
  }

  async function handleSave() {
    setErrorMessage("");
    try {
      const targetName = profileKeyFromName(selectedName || draft.name || "new_profile");
      const payload = { ...draft, name: targetName };
      await api.saveProfile(targetName, serializeProfile(payload));
      setSelectedName(targetName);
      await loadProfiles(targetName);
      setStatusMessage(t("profileSaved"));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "profile_save_failed");
    }
  }

  async function handleDelete() {
    if (!selectedName) return;
    setErrorMessage("");
    try {
      await api.deleteProfile(selectedName);
      setSelectedName("");
      setDraftProfile(EMPTY_PROFILE);
      setSelectedSensorId(null);
      await loadProfiles();
      setStatusMessage(t("profileDeleted"));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "profile_delete_failed");
    }
  }

  function handleImport(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const decoded = JSON.parse(String(reader.result ?? ""));
        const parsed = normalizeProfile(decoded as Record<string, unknown>);
        setSelectedName(profileKeyFromName(parsed.name || file.name.replace(/\.json$/i, "")));
        setDraftProfile(parsed);
        setSelectedSensorId(null);
        resetStageView();
        setStatusMessage(t("profileImported"));
      } catch {
        setErrorMessage(t("invalidJson"));
      }
    };
    reader.readAsText(file);
  }

  function handleExport() {
    const blob = new Blob([JSON.stringify(serializeProfile(draft), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${profileKeyFromName(selectedName || draft.name || "profile")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function handleImageUpload(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        updateDraft((current) => ({
          ...current,
          background: {
            imageData: String(reader.result ?? ""),
            aspectRatio: image.naturalWidth / Math.max(image.naturalHeight, 1),
          },
        }));
        resetStageView();
      };
      image.src = String(reader.result ?? "");
    };
    reader.readAsDataURL(file);
  }

  function assignSelectedSensorIndex(index: number) {
    if (!selectedSensor) {
      setErrorMessage(t("selectSensorFirst"));
      return;
    }
    setErrorMessage("");
    updateSensor(selectedSensor.id, { index });
  }

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("profileTitle")}</h2>
          <p className="page-copy">{t("profileEditorCopy")}</p>
        </div>
      </section>

      <section className="profile-workspace">
        <aside className="panel profile-sidebar profile-sidebar-primary">
          <div className="profile-sidebar-section">
            <h3>{t("profiles")}</h3>
            <select value={selectedName} onChange={(event) => void handleSelect(event.target.value)}>
              <option value="">{t("profileStart")}</option>
              {profiles.map((item) => (
                <option key={item.name} value={item.name}>
                  {displayNameForProfile(item)}
                </option>
              ))}
            </select>
            <div className="inline-actions">
              <button className="button" type="button" onClick={() => void loadProfiles(selectedName)}>
                {t("refresh")}
              </button>
              <button className="button danger" type="button" disabled={!selectedName} onClick={() => void handleDelete()}>
                {t("delete")}
              </button>
            </div>
          </div>

          <div className="profile-sidebar-section">
            <h3>{t("profileActions")}</h3>
            <button className="button primary" type="button" onClick={() => void handleSave()}>
              {t("save")}
            </button>
            <button className="button" type="button" onClick={handleExport}>
              {t("exportJson")}
            </button>
            <button className="button" type="button" onClick={() => importRef.current?.click()}>
              {t("importJson")}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                setSelectedName("");
                setDraftProfile(EMPTY_PROFILE);
                setSelectedSensorId(null);
                resetStageView();
              }}
            >
              {t("newProfile")}
            </button>
            <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={(event) => handleImport(event.target.files?.[0])} />
          </div>

          <div className="profile-sidebar-section">
            <h3>{t("backgroundImage")}</h3>
            <button className="button" type="button" onClick={() => imageRef.current?.click()}>
              {t("uploadBackground")}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                updateDraft((current) => ({ ...current, background: { imageData: "", aspectRatio: 1 } }));
                resetStageView();
              }}
            >
              {t("clearBackground")}
            </button>
            <p className="field-note">
              {draft.background.imageData ? `AR ${draft.background.aspectRatio.toFixed(3)}` : t("noBackground")}
            </p>
            <input ref={imageRef} hidden type="file" accept="image/*" onChange={(event) => handleImageUpload(event.target.files?.[0])} />
          </div>

          <div className="profile-sidebar-section">
            <h3>{t("profileTools")}</h3>
            <div className="profile-tool-grid">
              {(["add", "select", "move", "delete"] as const).map((item) => (
                <button
                  key={item}
                  className={`button ${tool === item ? "primary" : ""}`}
                  type="button"
                  onClick={() => setTool(item)}
                >
                  {t(`profileTool_${item}`)}
                </button>
              ))}
            </div>
            <div className="profile-stage-controls">
              <button className="button small" type="button" onClick={() => zoomFromCenter(1.25)}>+</button>
              <button className="button small" type="button" onClick={() => zoomFromCenter(1 / 1.25)}>-</button>
              <button className="button small" type="button" onClick={fitStageContent}>Fit</button>
              <button className={`button small ${panMode ? "primary" : ""}`} type="button" onClick={() => setPanMode((value) => !value)}>Pan</button>
            </div>
            <p className="field-note">{t(`profileToolHint_${tool}`)}</p>
            <button
              className="button danger"
              type="button"
              onClick={() => {
                setDraftProfile({ ...draft, sensors: [] });
                setSelectedSensorId(null);
              }}
            >
              {t("clearSensors")}
            </button>
          </div>
        </aside>

        <article className="panel profile-main profile-canvas-panel">
          <div className="profile-form-grid">
            <div className="field">
              <label>{t("profileName")}</label>
              <input
                value={selectedName}
                onChange={(event) => {
                  const nextName = profileKeyFromName(event.target.value);
                  setSelectedName(nextName);
                  updateDraft((current) => ({ ...current, name: nextName }));
                }}
                placeholder="profile_name"
              />
            </div>
            <div className="field">
              <label>{t("profileDisplayMode")}</label>
              <div className="segmented-control">
                <button
                  className={draft.display.mode === "3d" ? "active" : ""}
                  type="button"
                  onClick={() => updateDraft((current) => ({ ...current, display: { ...current.display, mode: "3d" } }))}
                >
                  {t("surface3d")}
                </button>
                <button
                  className={draft.display.mode === "2d" ? "active" : ""}
                  type="button"
                  onClick={() => updateDraft((current) => ({ ...current, display: { ...current.display, mode: "2d" } }))}
                >
                  {t("heatmap2d")}
                </button>
              </div>
            </div>
            <div className="field">
              <label>{t("pressureMin")}</label>
              <input
                type="number"
                value={draft.display.pressureMin}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    display: { ...current.display, pressureMin: Number(event.target.value) || 0 },
                  }))
                }
              />
            </div>
            <div className="field">
              <label>{t("pressureMax")}</label>
              <input
                type="number"
                value={draft.display.pressureMax}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    display: { ...current.display, pressureMax: Math.max(Number(event.target.value) || 1, current.display.pressureMin + 1) },
                  }))
                }
              />
            </div>
            <div className="field">
              <label>{t("dotSize")}: {draft.display.dotSize.toFixed(2)}x</label>
              <input
                type="range"
                min="0.5"
                max="4"
                step="0.25"
                value={draft.display.dotSize}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    display: { ...current.display, dotSize: clamp(Number(event.target.value) || 1, 0.5, 4) },
                  }))
                }
              />
            </div>
          </div>

          <div
            ref={stageViewportRef}
            className={`profile-stage profile-stage-viewport tool-${tool}`}
            onPointerDown={handleStagePointerDown}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
            onPointerCancel={handleStagePointerUp}
            onWheel={handleStageWheel}
          >
            <div className="profile-stage-grid" />
            <div className="profile-stage-center">
              <div
                ref={stageSceneRef}
                className="profile-stage-scene"
                style={{
                  width: `${sceneRect.drawWidth}px`,
                  height: `${sceneRect.drawHeight}px`,
                  transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
                  "--profile-marker-size": `${markerSize}px`,
                  "--profile-marker-font-size": `${markerFontSize}px`,
                } as CSSProperties}
              >
                {draft.background.imageData ? (
                  <img className="profile-stage-image" src={draft.background.imageData} alt="" draggable={false} />
                ) : (
                  <div className="profile-stage-placeholder">{t("profileStagePlaceholder")}</div>
                )}
                {draft.sensors.map((sensor) => (
                  <button
                    key={sensor.id}
                    type="button"
                    className={`profile-marker ${sensor.enabled ? "" : "disabled"} ${selectedSensorId === sensor.id ? "selected" : ""}`}
                    style={{
                      left: `${sensor.x * 100}%`,
                      top: `${sensor.y * 100}%`,
                      background: sensorColor(sensor, draft.sensors.length),
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      if (tool === "delete") {
                        removeSensor(sensor.id);
                        return;
                      }
                      setSelectedSensorId(sensor.id);
                      if (tool === "move" || tool === "select" || tool === "add") {
                        setDragSensorId(sensor.id);
                        stageViewportRef.current?.setPointerCapture(event.pointerId);
                      }
                    }}
                  >
                    <span>{sensor.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="profile-editor-footer">
            <span>{t("sensorCount")}: {draft.sensors.length}</span>
            <span>{t("wsStatus")}: {wsStatus}</span>
            <span>Zoom: {zoomInfo}</span>
            <span>Cursor: {cursorInfo}</span>
            <span>{selectedSensor ? `${t("selectedSensor")}: ${selectedSensor.label}` : t("selectSensorFirst")}</span>
          </div>
        </article>

        <aside className="panel profile-inspector profile-sidebar-secondary">
          <section>
            <h3>{t("sectionSensors")}</h3>
            <div className="profile-sensor-table">
              {draft.sensors.length === 0 ? <p className="field-note">{t("noSensors")}</p> : null}
              {draft.sensors.map((sensor) => (
                <div key={sensor.id} className={`profile-sensor-row ${selectedSensorId === sensor.id ? "selected" : ""}`}>
                  <button type="button" className="profile-sensor-select" onClick={() => setSelectedSensorId(sensor.id)}>
                    #{sensor.id}
                  </button>
                  <input value={sensor.label} onChange={(event) => updateSensor(sensor.id, { label: event.target.value })} />
                  <input
                    type="number"
                    min={0}
                    value={sensor.index}
                    onChange={(event) => updateSensor(sensor.id, { index: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
                  />
                  <label className="switch-row">
                    <input type="checkbox" checked={sensor.enabled} onChange={(event) => updateSensor(sensor.id, { enabled: event.target.checked })} />
                  </label>
                  <button className="button danger" type="button" onClick={() => removeSensor(sensor.id)}>
                    ×
                  </button>
                  <span className="profile-position">{sensor.x.toFixed(3)}, {sensor.y.toFixed(3)}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3>{t("liveChannelMonitor")}</h3>
            <div className="field">
              <label>{t("deviceName")}</label>
              <select value={monitorDeviceUid} onChange={(event) => setMonitorDeviceUid(event.target.value)}>
                <option value="">{t("noDevicesDiscovered")}</option>
                {devices.map((device) => {
                  const deviceUid = normalizeUid(device.device_uid);
                  return (
                    <option key={deviceUid} value={deviceUid}>
                      {device.display_name || device.device_name || deviceUid}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="profile-channel-list">
              {monitorValues.length === 0 ? <p className="field-note">{t("noData")}</p> : null}
              {monitorValues.map((value, index) => {
                const numeric = Number(value) || 0;
                const pct = clamp((numeric / monitorMax) * 100, 0, 100);
                const assigned = draft.sensors.some((sensor) => sensor.index === index);
                return (
                  <button key={index} className={`profile-channel-row ${assigned ? "assigned" : ""}`} type="button" onClick={() => assignSelectedSensorIndex(index)}>
                    <span>CH {index}</span>
                    <span className="profile-channel-bar">
                      <span style={{ width: `${pct}%` }} />
                    </span>
                    <strong>{numeric.toFixed(1)}</strong>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <div className="section-heading-row">
              <h3>{t("jsonPreview")}</h3>
              <button className="button small" type="button" onClick={() => setShowRawJson((value) => !value)}>
                {showRawJson ? t("decodedCsv") : t("rawJson")}
              </button>
            </div>
            <textarea className="profile-json-preview" readOnly value={showRawJson ? rawJsonText : jsonCsvText} />
          </section>

          {statusMessage ? <p className="notice success">{statusMessage}</p> : null}
          {errorMessage ? <p className="notice error">{errorMessage}</p> : null}
        </aside>
      </section>
    </>
  );
}
