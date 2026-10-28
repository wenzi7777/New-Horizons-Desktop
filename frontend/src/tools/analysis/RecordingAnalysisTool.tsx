import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, FolderOpen, Pause, Play, RotateCcw, ZoomOut } from "lucide-react";
import { RecordingMetaSummary } from "../../components/RecordingMetaSummary";
import { useI18n } from "../../i18n";
import { api, type CsvDeviceEntry, type CsvExplorerEntry } from "../../lib/api";
import {
  IMU_GROUPS,
  defaultGridColumns,
  formatDuration,
  formatInstant,
  indexAtTime,
  intervalHistogram,
  isEventsSidecar,
  isMetaFile,
  isSamplesCsv,
  metaGridColumns,
  metaNameFor,
  nearestIndex,
  parseEventsCsv,
  parseRecordingMetaText,
  placeEvents,
  recordingBase,
  recordingEnd,
  sensorFrame,
  sensorStats,
  sidecarNameFor,
  sliceEventsText,
  sliceRecordingText,
  summarizeRecording,
  type ImuGroup,
  type IntervalHistogram,
  type PlacedEvent,
  type Recording,
  type RecordingEvent,
  type RecordingIssue,
  type RecordingMeta,
  type SensorStat,
} from "../../lib/recordingAnalysis";
import type { WorkerReply, WorkerRequest } from "./recordingWorker";
import { SensorHeatmap } from "./SensorHeatmap";
import { TimelineChart, type ChartMarker, type ChartSeries } from "./TimelineChart";
import { TimestampConverter } from "./TimestampConverter";
import { Select } from "../../components/Select";

// A recording's files: the samples, and its events and meta when it has them.
type Source =
  | { kind: "server"; name: string; path: string; eventsPath: string | null; metaPath: string | null }
  | { kind: "local"; name: string; file: File; eventsFile: File | null; metaFile: File | null };

type Metric = "total" | "peak" | "contact" | "sensors";
type HeatmapMode = "frame" | "mean" | "peak";
type SortKey = "sensor" | "mean" | "peak" | "std" | "activeShare";

const METRIC_COLORS: Record<Exclude<Metric, "sensors">, string> = { total: "#1f6b54", peak: "#d9480f", contact: "#2f6fdb" };
const SENSOR_COLORS = ["#1f6b54", "#2f6fdb", "#d9480f", "#9c36b5", "#c2255c", "#0c8599", "#e67700", "#5c7cfa"];
const AXIS_COLORS = ["#d9480f", "#2b8a3e", "#2f6fdb"];
const EVENT_COLORS = ["#c2255c", "#7048e8", "#e67700", "#0c8599", "#2b8a3e", "#d9480f"];
// A setting that changed during the recording (the meta's `changes`).
const CHANGE_COLOR = "#495057";
const MAX_SELECTED = SENSOR_COLORS.length;
const PLAY_SPEEDS = [0.5, 1, 2, 4];
// How much of the recording a click on a gap or an event zooms to.
const FOCUS_SPAN_MS = 4000;
const IMU_KEYS: Record<ImuGroup, string> = { acc: "analysisImuAcc", gyro: "analysisImuGyro", mag: "analysisImuMag" };
const IMU_UNITS: Record<ImuGroup, string> = { acc: "g", gyro: "°/s", mag: "µT" };

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return value.toFixed(0);
  if (magnitude >= 100) return value.toFixed(1);
  if (magnitude >= 1) return value.toFixed(2);
  return value === 0 ? "0" : value.toFixed(3);
}

const formatCount = (value: number) => (Number.isFinite(value) ? value.toFixed(0) : "—");

function serverUrl(path: string) {
  return new URL(api.downloadCsvUrl(path), window.location.href).href;
}

async function fetchText(url: string) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText || "request_failed"}`);
  return response.text();
}

function saveText(name: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// One parser worker for the page's lifetime; each load gets an id so a
// slow file finishing late cannot replace the one picked after it.
function useRecordingLoader() {
  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(0);
  const [phase, setPhase] = useState<"" | "reading" | "parsing">("");

  useEffect(() => () => workerRef.current?.terminate(), []);

  const load = useCallback((name: string, source: string | Blob) => {
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL("./recordingWorker.ts", import.meta.url), { type: "module" });
    }
    const worker = workerRef.current;
    const id = ++nextId.current;
    return new Promise<Recording>((resolve, reject) => {
      const listener = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data;
        if (reply.id !== id) return;
        if ("phase" in reply) {
          setPhase(reply.phase);
          return;
        }
        worker.removeEventListener("message", listener);
        setPhase("");
        if ("error" in reply) reject(new Error(reply.error));
        else resolve(reply.recording);
      };
      worker.addEventListener("message", listener);
      const request: WorkerRequest = { id, name, source };
      worker.postMessage(request);
    }).catch((error) => {
      if (id !== nextId.current) throw new Error("superseded");
      throw error;
    });
  }, []);

  return { load, phase };
}

/** The day folder's recordings: folders (v0.27.0+) and flat sample CSVs
 * from before, newest first. */
function recordingEntries(items: CsvExplorerEntry[]) {
  return items
    .filter((item) => item.kind === "recording" || (!item.is_dir && isSamplesCsv(item.name)))
    .sort((a, b) => b.name.localeCompare(a.name));
}

export default function RecordingAnalysisTool() {
  const { t, locale } = useI18n();
  const { load, phase } = useRecordingLoader();
  const [searchParams] = useSearchParams();

  // ── Where the recording comes from ──
  // `?device=&path=` (the CSV export page's Analyze) picks and opens one:
  // path is a recording folder, a file inside one, or a flat sample CSV.
  const pendingRef = useRef<{ device: string; path: string } | null>(
    searchParams.get("device") && searchParams.get("path")
      ? { device: searchParams.get("device") ?? "", path: (searchParams.get("path") ?? "").replace(/^\/+/, "") }
      : null,
  );
  const [devices, setDevices] = useState<CsvDeviceEntry[]>([]);
  const [deviceUid, setDeviceUid] = useState(pendingRef.current?.device ?? "");
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [files, setFiles] = useState<CsvExplorerEntry[]>([]);
  const [filePath, setFilePath] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [source, setSource] = useState<Source | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [eventsText, setEventsText] = useState<string | null>(null);
  const [events, setEvents] = useState<RecordingEvent[]>([]);
  const [meta, setMeta] = useState<RecordingMeta | null>(null);
  const [error, setError] = useState("");

  // ── What is on screen ──
  const [view, setView] = useState({ start: 0, end: 0 });
  const [cursor, setCursor] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [metric, setMetric] = useState<Metric>("total");
  const [selected, setSelected] = useState<number[]>([]);
  const [imuGroup, setImuGroup] = useState<ImuGroup | "none">("acc");
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>("frame");
  const [gridColumns, setGridColumns] = useState(5);
  const [showEvents, setShowEvents] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "sensor", descending: false });
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    api.csvDevices()
      .then((response) => {
        setDevices(response.items);
        setDeviceUid((current) => current || response.items[0]?.device_uid || "");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "request_failed"));
  }, []);

  useEffect(() => {
    setDates([]);
    setDate("");
    if (!deviceUid) return;
    let cancelled = false;
    api.csvDirectory(deviceUid, "")
      .then((response) => {
        if (cancelled) return;
        const names = response.items.filter((item) => item.is_dir && item.kind !== "recording").map((item) => item.name).sort().reverse();
        setDates(names);
        const pendingDate = pendingRef.current?.device === deviceUid ? pendingRef.current.path.split("/")[1] : "";
        setDate(pendingDate && names.includes(pendingDate) ? pendingDate : names[0] ?? "");
      })
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : "request_failed"));
    return () => {
      cancelled = true;
    };
  }, [deviceUid]);

  useEffect(() => {
    setFiles([]);
    setFilePath("");
    if (!deviceUid || !date) return;
    let cancelled = false;
    api.csvDirectory(deviceUid, date)
      .then((response) => {
        if (cancelled) return;
        setFiles(response.items);
        const choices = recordingEntries(response.items);
        const pending = pendingRef.current;
        const wanted = pending?.device === deviceUid
          ? choices.find((item) => item.path === pending.path || pending.path.startsWith(`${item.path}/`))
          : undefined;
        setFilePath((wanted ?? choices[0])?.path ?? "");
        if (wanted) {
          pendingRef.current = null;
          void openServer(wanted, response.items);
        }
      })
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : "request_failed"));
    return () => {
      cancelled = true;
    };
  }, [deviceUid, date]);

  const recordings = recordingEntries(files);

  async function open(next: Source) {
    setError("");
    setPlaying(false);
    try {
      const rec = await load(next.name, next.kind === "server" ? serverUrl(next.path) : next.file);
      // The samples are what was asked for; a sidecar that fails to load
      // only leaves the events (or the device details) out.
      const readOptional = async (path: string | null, file: File | null) => {
        try {
          if (next.kind === "server" && path) return await fetchText(serverUrl(path));
          if (next.kind === "local" && file) return await file.text();
        } catch {
          return null;
        }
        return null;
      };
      const sidecar = await readOptional(
        next.kind === "server" ? next.eventsPath : null,
        next.kind === "local" ? next.eventsFile : null,
      );
      const metaText = await readOptional(
        next.kind === "server" ? next.metaPath : null,
        next.kind === "local" ? next.metaFile : null,
      );
      const nextMeta = metaText ? parseRecordingMetaText(metaText) : null;
      setSource(next);
      setRecording(rec);
      setEventsText(sidecar);
      setEvents(sidecar ? parseEventsCsv(sidecar) : []);
      setMeta(nextMeta);
      setView({ start: 0, end: rec.rowCount });
      setCursor(rec.rowCount ? 0 : null);
      setHover(null);
      setSelected([]);
      setMetric("total");
      setGridColumns(metaGridColumns(nextMeta, rec.sensorCount) ?? defaultGridColumns(rec.sensorCount));
      const groups = (Object.keys(IMU_GROUPS) as ImuGroup[]).filter((group) => IMU_GROUPS[group].some((axis) => rec.imu[axis]));
      setImuGroup(groups[0] ?? "none");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "load_failed";
      if (message !== "superseded") setError(message);
    }
  }

  async function openServer(entry: CsvExplorerEntry | undefined, dayItems: CsvExplorerEntry[] = files) {
    if (!entry) return;
    setError("");
    try {
      // A recording folder: its files (listed with it by v0.27.0+ backends,
      // else asked for). A flat CSV: its siblings by name.
      const siblings = entry.kind === "recording"
        ? entry.children ?? (await api.csvDirectory(deviceUid, `${date || entry.path.split("/")[1]}/${entry.name}`)).items
        : dayItems;
      const data = entry.kind === "recording" ? siblings.find((item) => isSamplesCsv(item.name)) : entry;
      if (!data) {
        setError(t("analysisNoSamples"));
        return;
      }
      const sidecar = siblings.find((item) => item.name === sidecarNameFor(data.name));
      const metaEntry = siblings.find((item) => item.name === metaNameFor(data.name));
      await open({
        kind: "server", name: data.name, path: data.path,
        eventsPath: sidecar?.path ?? null, metaPath: metaEntry?.path ?? null,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "request_failed");
    }
  }

  function openLocal(list: FileList | File[] | null) {
    const picked = Array.from(list ?? []);
    const sample = picked.find((file) => isSamplesCsv(file.name));
    if (!sample) {
      setError(t("analysisPickCsv"));
      return;
    }
    const pick = (match: (name: string) => boolean, exact: string) =>
      picked.find((file) => file.name === exact) ?? picked.find((file) => match(file.name)) ?? null;
    void open({
      kind: "local", name: sample.name, file: sample,
      eventsFile: pick(isEventsSidecar, sidecarNameFor(sample.name)),
      metaFile: pick(isMetaFile, metaNameFor(sample.name)),
    });
  }

  // ── Derived data ──
  const summary = useMemo(() => (recording ? summarizeRecording(recording) : null), [recording]);
  const histogram = useMemo(
    () => (recording && summary ? intervalHistogram(recording, summary) : null),
    [recording, summary],
  );
  const placed = useMemo(() => (recording ? placeEvents(recording, events) : []), [recording, events]);
  const eventColor = useMemo(() => {
    const kinds = Array.from(new Set(placed.map((event) => `${event.app}/${event.event}`)));
    return new Map(kinds.map((kind, index) => [kind, EVENT_COLORS[index % EVENT_COLORS.length]]));
  }, [placed]);
  // Settings that changed mid-recording (a tare, say), on their frame.
  const changeMarkers = useMemo<ChartMarker[]>(() => {
    if (!recording?.frameSeq || !meta?.changes.length) return [];
    const rowOfFrame = new Map<number, number>();
    recording.frameSeq.forEach((frame, row) => rowOfFrame.set(frame, row));
    return meta.changes.flatMap((change) => {
      const index = change.frameSeq !== null ? rowOfFrame.get(change.frameSeq) : undefined;
      return index === undefined ? [] : [{ index, color: CHANGE_COLOR, label: `${change.field}: ${String(change.from)} → ${String(change.to)}` }];
    });
  }, [recording, meta]);
  const markers = useMemo<ChartMarker[]>(
    () => [
      ...(showEvents
        ? placed.map((event) => ({
          index: event.index,
          color: eventColor.get(`${event.app}/${event.event}`) ?? EVENT_COLORS[0],
          label: [event.app, event.event, event.edge].filter(Boolean).join(" · "),
        }))
        : []),
      ...changeMarkers,
    ],
    [placed, eventColor, showEvents, changeMarkers],
  );

  const stats = useMemo(
    () => (recording ? sensorStats(recording, view.start, view.end) : []),
    [recording, view.start, view.end],
  );
  const sortedStats = useMemo(() => {
    const rows = [...stats];
    rows.sort((a, b) => {
      const delta = sort.key === "sensor" ? a.sensor - b.sensor : (a[sort.key] as number) - (b[sort.key] as number);
      return sort.descending ? -delta : delta;
    });
    return rows;
  }, [stats, sort]);

  const pressureSeries = useMemo<ChartSeries[]>(() => {
    if (!recording) return [];
    if (metric === "sensors") {
      return selected.map((sensor, index) => ({
        key: `s${sensor}`,
        label: recording.sensorNames[sensor],
        color: SENSOR_COLORS[index % SENSOR_COLORS.length],
        value: (row: number) => recording.pressure[row * recording.sensorCount + sensor],
      }));
    }
    const values = metric === "total" ? recording.total : metric === "peak" ? recording.peak : recording.active;
    const labelKey = metric === "total" ? "analysisMetricTotal" : metric === "peak" ? "analysisMetricPeak" : "analysisMetricContact";
    return [{ key: metric, label: t(labelKey), color: METRIC_COLORS[metric], value: (row: number) => values[row] }];
  }, [recording, metric, selected, t]);

  const imuSeries = useMemo<ChartSeries[]>(() => {
    if (!recording || imuGroup === "none") return [];
    return IMU_GROUPS[imuGroup].flatMap((axis, index) => {
      const values = recording.imu[axis];
      if (!values) return [];
      return [{ key: axis, label: axis, color: AXIS_COLORS[index], value: (row: number) => values[row] }];
    });
  }, [recording, imuGroup]);
  const imuGroups = recording
    ? (Object.keys(IMU_GROUPS) as ImuGroup[]).filter((group) => IMU_GROUPS[group].some((axis) => recording.imu[axis]))
    : [];

  const heatRow = hover ?? cursor ?? view.start;
  const heatValues = useMemo(() => {
    if (!recording) return new Float32Array(0);
    return heatmapMode === "frame" ? sensorFrame(recording, "frame", heatRow, heatRow + 1) : sensorFrame(recording, heatmapMode, view.start, view.end);
  }, [recording, heatmapMode, heatRow, view.start, view.end]);
  const heatScale = useMemo(() => {
    if (!recording) return 1;
    if (heatmapMode === "frame") return recording.maxValue;
    let high = 0;
    for (const value of heatValues) if (value > high) high = value;
    return high;
  }, [recording, heatmapMode, heatValues]);

  // ── Playback: the cursor walks the view in real time ──
  const playRef = useRef<{ wall: number; ms: number } | null>(null);
  useEffect(() => {
    if (!playing || !recording) return undefined;
    let frame = 0;
    const startRow = cursor === null || cursor >= view.end - 1 || cursor < view.start ? view.start : cursor;
    playRef.current = { wall: performance.now(), ms: recording.time[startRow] };
    const step = (now: number) => {
      const anchor = playRef.current;
      if (!anchor) return;
      const target = anchor.ms + (now - anchor.wall) * speed;
      const row = Math.min(view.end - 1, nearestIndex(recording.time, target, recording.rowCount));
      setCursor(row);
      if (row >= view.end - 1) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // cursor is read once, where playback starts; it is not a dependency.
  }, [playing, recording, speed, view.start, view.end]);

  // ── Actions ──
  const pick = useCallback((row: number) => {
    setPlaying(false);
    setCursor(row);
  }, []);
  const select = useCallback((start: number, end: number) => setView({ start, end }), []);
  const resetView = useCallback(() => {
    if (recording) setView({ start: 0, end: recording.rowCount });
  }, [recording]);

  function zoomOut() {
    if (!recording || recording.rowCount === 0) return;
    const t0 = recording.time[view.start];
    const t1 = recording.time[Math.max(view.start, view.end - 1)];
    const center = (t0 + t1) / 2;
    const half = Math.max(1, t1 - t0);
    setView({
      start: indexAtTime(recording.time, center - half, recording.rowCount),
      end: Math.min(recording.rowCount, indexAtTime(recording.time, center + half, recording.rowCount) + 1),
    });
  }

  /** Puts the cursor on `row`, zooming to a few seconds around it when
   * asked to or when it is outside the view. */
  function focusRow(row: number, zoom: boolean) {
    if (!recording) return;
    setPlaying(false);
    setCursor(row);
    if (!zoom && row >= view.start && row < view.end) return;
    const at = recording.time[row];
    setView({
      start: indexAtTime(recording.time, at - FOCUS_SPAN_MS / 2, recording.rowCount),
      end: Math.min(recording.rowCount, indexAtTime(recording.time, at + FOCUS_SPAN_MS / 2, recording.rowCount) + 1),
    });
  }

  function toggleSensor(sensor: number) {
    setSelected((current) => {
      if (current.includes(sensor)) return current.filter((item) => item !== sensor);
      const next = [...current, sensor];
      return next.length > MAX_SELECTED ? next.slice(next.length - MAX_SELECTED) : next;
    });
    setMetric("sensors");
  }

  function sortBy(key: SortKey) {
    setSort((current) => (current.key === key ? { key, descending: !current.descending } : { key, descending: key !== "sensor" }));
  }

  async function exportRange() {
    if (!recording || !source) return;
    setExporting(true);
    try {
      const text = source.kind === "server" ? await fetchText(serverUrl(source.path)) : await source.file.text();
      const origin = recording.time[0];
      const from = Math.round((recording.time[view.start] - origin) / 1000);
      const to = Math.round((recording.time[Math.max(view.start, view.end - 1)] - origin) / 1000);
      // Named like a recording's own files, so the export opens here again
      // (and in anything that reads recordings) as one.
      const name = `${recordingBase(source.name)}_${from}s-${to}s`;
      saveText(`${name}.data.csv`, sliceRecordingText(text, recording, view.start, view.end - 1));
      if (eventsText) {
        const sidecar = sliceEventsText(eventsText, placed, view.start, view.end - 1);
        if (sidecar) saveText(`${name}.events.csv`, sidecar);
      }
      if (meta) {
        const raw = meta.raw as Record<string, unknown>;
        const original = raw.recording && typeof raw.recording === "object" ? raw.recording as Record<string, unknown> : {};
        const exported = {
          ...raw,
          recording: {
            ...original,
            exported_range: {
              from_source: source.name,
              first_row: view.start,
              last_row: view.end - 1,
              first_timestamp_ms: recording.time[view.start],
              last_timestamp_ms: recording.time[Math.max(view.start, view.end - 1)],
            },
          },
        };
        saveText(`${name}.meta.json`, JSON.stringify(exported, null, 2) + "\n", "application/json");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "export_failed");
    } finally {
      setExporting(false);
    }
  }

  const loading = phase !== "";
  const origin = recording?.rowCount ? recording.time[0] : 0;
  const viewFrom = recording?.rowCount ? recording.time[view.start] - origin : 0;
  const viewTo = recording?.rowCount ? recording.time[Math.max(view.start, view.end - 1)] - origin : 0;
  const zoomed = Boolean(recording && (view.start > 0 || view.end < recording.rowCount));

  return (
    <div className="analysis-tool">
      <section
        className={`analysis-panel analysis-source${dragOver ? " drag-over" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          openLocal(event.dataTransfer.files);
        }}
      >
        <div className="analysis-source-row">
          <label className="analysis-field">
            <span>{t("analysisDevice")}</span>
            <Select value={deviceUid} onChange={(event) => setDeviceUid(event.target.value)} disabled={devices.length === 0}>
              {devices.length === 0 ? <option value="">{t("noDevicesDiscovered")}</option> : null}
              {devices.map((item) => (
                <option key={item.device_uid} value={item.device_uid}>
                  {item.display_name && item.display_name !== item.device_uid ? `${item.display_name} (${item.device_uid})` : item.device_uid}
                </option>
              ))}
            </Select>
          </label>
          <label className="analysis-field">
            <span>{t("analysisDate")}</span>
            <Select value={date} onChange={(event) => setDate(event.target.value)} disabled={dates.length === 0}>
              {dates.map((item) => <option key={item} value={item}>{item}</option>)}
            </Select>
          </label>
          <label className="analysis-field grow">
            <span>{t("analysisRecording")}</span>
            <Select value={filePath} onChange={(event) => setFilePath(event.target.value)} disabled={recordings.length === 0}>
              {recordings.length === 0 ? <option value="">{t("emptyFolder")}</option> : null}
              {recordings.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.name} · {formatFileSize(item.size)}
                  {item.kind !== "recording" ? ` · ${t("analysisLegacyFile")}` : ""}
                </option>
              ))}
            </Select>
          </label>
          <button
            type="button"
            className="button primary"
            disabled={!filePath || loading}
            onClick={() => void openServer(recordings.find((item) => item.path === filePath))}
          >
            {t("analysisLoad")}
          </button>
          <span className="analysis-source-or">{t("analysisOr")}</span>
          <button type="button" className="button" disabled={loading} onClick={() => fileInputRef.current?.click()}>
            <FolderOpen size={15} strokeWidth={2} aria-hidden="true" />
            {t("analysisOpenLocal")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            multiple
            hidden
            onChange={(event) => {
              openLocal(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
        <p className="analysis-note">{t("analysisSourceHint")}</p>
        {loading ? <p className="analysis-loading">{t(phase === "reading" ? "analysisReading" : "analysisParsing")}</p> : null}
        {error ? <p className="notice error">{error}</p> : null}
      </section>

      {recording && summary ? (
        <>
          <OverviewCards recording={recording} summary={summary} eventCount={placed.length} source={source} meta={meta} />

          <section className="analysis-panel">
            <div className="analysis-panel-head">
              <h3>{t("analysisTimeline")}</h3>
              <div className="analysis-toolbar">
                <Segmented
                  value={metric}
                  options={[
                    ["total", t("analysisMetricTotal")],
                    ["peak", t("analysisMetricPeak")],
                    ["contact", t("analysisMetricContact")],
                    ["sensors", `${t("analysisMetricSensors")}${selected.length ? ` (${selected.length})` : ""}`],
                  ]}
                  onChange={(value) => setMetric(value as Metric)}
                />
                {placed.length ? (
                  <label className="analysis-check">
                    <input type="checkbox" checked={showEvents} onChange={(event) => setShowEvents(event.target.checked)} />
                    {t("analysisShowEvents")}
                  </label>
                ) : null}
              </div>
            </div>
            <div className="analysis-range-bar">
              <button
                type="button"
                className="button compact"
                onClick={() => setPlaying((current) => !current)}
                aria-label={playing ? t("analysisPause") : t("analysisPlay")}
              >
                {playing ? <Pause size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} />}
                {playing ? t("analysisPause") : t("analysisPlay")}
              </button>
              <Select className="analysis-speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label={t("analysisSpeed")}>
                {PLAY_SPEEDS.map((item) => <option key={item} value={item}>{item}×</option>)}
              </Select>
              <span className="analysis-range-text">
                {t("analysisRange")} <strong>{formatDuration(viewFrom)} – {formatDuration(viewTo)}</strong>
                {" "}({formatDuration(viewTo - viewFrom)} · {(view.end - view.start).toLocaleString(locale)} {t("analysisRows")})
                {cursor !== null ? <> · {t("analysisCursor")} <strong>{formatDuration(recording.time[cursor] - origin)}</strong></> : null}
              </span>
              <span className="analysis-range-actions">
                <button type="button" className="button compact" onClick={zoomOut} disabled={!zoomed}>
                  <ZoomOut size={14} strokeWidth={2} aria-hidden="true" />
                  {t("analysisZoomOut")}
                </button>
                <button type="button" className="button compact" onClick={resetView} disabled={!zoomed}>
                  <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                  {t("analysisShowAll")}
                </button>
                <button type="button" className="button compact" onClick={() => void exportRange()} disabled={exporting}>
                  <Download size={14} strokeWidth={2} aria-hidden="true" />
                  {t(zoomed ? "analysisExportRange" : "analysisExportAll")}
                </button>
              </span>
            </div>
            {metric === "sensors" && selected.length === 0 ? (
              <p className="analysis-note">{t("analysisPickSensorsHint")}</p>
            ) : null}
            <TimelineChart
              time={recording.time}
              start={view.start}
              end={view.end}
              series={pressureSeries}
              markers={markers}
              cursor={cursor}
              hover={hover}
              height={260}
              zeroBased
              formatValue={metric === "contact" ? formatCount : formatNumber}
              ariaLabel={t("analysisTimeline")}
              onHover={setHover}
              onPick={pick}
              onSelect={select}
              onReset={resetView}
            />
            {imuGroups.length ? (
              <>
                <div className="analysis-subhead">
                  <span>{t("analysisImu")}{imuGroup !== "none" ? ` (${IMU_UNITS[imuGroup]})` : ""}</span>
                  <Segmented
                    value={imuGroup}
                    options={[...imuGroups.map((group) => [group, t(IMU_KEYS[group])] as [string, string]), ["none", t("analysisHide")]]}
                    onChange={(value) => setImuGroup(value as ImuGroup | "none")}
                  />
                </div>
                {imuGroup !== "none" ? (
                  <TimelineChart
                    time={recording.time}
                    start={view.start}
                    end={view.end}
                    series={imuSeries}
                    markers={markers}
                    cursor={cursor}
                    hover={hover}
                    height={150}
                    formatValue={formatNumber}
                    ariaLabel={t("analysisImu")}
                    onHover={setHover}
                    onPick={pick}
                    onSelect={select}
                    onReset={resetView}
                  />
                ) : null}
              </>
            ) : null}
            <p className="analysis-note">{t("analysisChartHint")}</p>
          </section>

          <div className="analysis-grid-2">
            <section className="analysis-panel">
              <div className="analysis-panel-head">
                <h3>{t("analysisHeatmap")}</h3>
                <div className="analysis-toolbar">
                  <Segmented
                    value={heatmapMode}
                    options={[
                      ["frame", t("analysisHeatFrame")],
                      ["mean", t("analysisHeatMean")],
                      ["peak", t("analysisHeatPeak")],
                    ]}
                    onChange={(value) => setHeatmapMode(value as HeatmapMode)}
                  />
                  <label className="analysis-field inline">
                    <span>{t("analysisColumns")}</span>
                    <input
                      type="number"
                      min={1}
                      max={Math.max(1, recording.sensorCount)}
                      value={gridColumns}
                      onChange={(event) => setGridColumns(Math.max(1, Math.min(recording.sensorCount || 1, Number(event.target.value) || 1)))}
                    />
                  </label>
                </div>
              </div>
              <p className="analysis-note">
                {heatmapMode === "frame"
                  ? `${t("analysisHeatAt")} ${formatDuration(recording.time[Math.min(heatRow, recording.rowCount - 1)] - origin)}`
                  : `${t("analysisHeatOver")} ${formatDuration(viewFrom)} – ${formatDuration(viewTo)}`}
              </p>
              {recording.sensorCount ? (
                <SensorHeatmap
                  names={recording.sensorNames}
                  values={heatValues}
                  columns={gridColumns}
                  scaleMax={heatScale}
                  selected={selected}
                  formatValue={formatNumber}
                  onToggle={toggleSensor}
                />
              ) : <p className="analysis-note">{t("analysisNoSensors")}</p>}
            </section>

            <section className="analysis-panel">
              <div className="analysis-panel-head">
                <h3>{t("analysisSensorStats")}</h3>
                <span className="analysis-note">{t("analysisStatsScope")}</span>
              </div>
              <SensorTable rows={sortedStats} selected={selected} sort={sort} onSort={sortBy} onToggle={toggleSensor} threshold={recording.activeThreshold} />
            </section>
          </div>

          <div className="analysis-grid-2">
            <QualityPanel recording={recording} summary={summary} histogram={histogram} onFocus={(row) => focusRow(row, true)} />
            <EventsPanel events={placed} colors={eventColor} hasSidecar={eventsText !== null} onFocus={(row) => focusRow(row, false)} />
          </div>
        </>
      ) : null}

      <section className="analysis-panel">
        <div className="analysis-panel-head">
          <h3>{t("analysisConverter")}</h3>
        </div>
        <TimestampConverter recordingRange={summary ? { startMs: summary.startMs, endMs: summary.endMs } : null} />
      </section>
    </div>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return (
    <div className="analysis-segmented" role="radiogroup">
      {options.map(([key, label]) => (
        <button key={key} type="button" role="radio" aria-checked={value === key} className={value === key ? "active" : ""} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function OverviewCards({ recording, summary, eventCount, source, meta }: {
  recording: Recording;
  summary: ReturnType<typeof summarizeRecording>;
  eventCount: number;
  source: Source | null;
  meta: RecordingMeta | null;
}) {
  const { t, locale } = useI18n();
  const clean = summary.lostFrames === 0 && summary.timeGaps === 0 && summary.restarts === 0 && summary.backwardsSteps === 0;
  const refTotal = summary.timeRefCounts.device + summary.timeRefCounts.received + summary.timeRefCounts.other;
  const deviceShare = refTotal ? summary.timeRefCounts.device / refTotal : 0;
  return (
    <section className="analysis-panel">
      <div className="analysis-panel-head">
        <h3>{source?.name ?? recording.name}</h3>
        <span className="analysis-note">{source?.kind === "local" ? t("analysisLocalFile") : source?.path}</span>
      </div>
      <div className="analysis-cards">
        <div className="analysis-card wide">
          <span className="label">{t("analysisDuration")}</span>
          <span className="value">{formatDuration(summary.durationMs)}</span>
          <span className="sub">{(summary.durationMs / 1000).toFixed(3)} s</span>
        </div>
        <div className="analysis-card wide">
          <span className="label">{t("analysisStart")}</span>
          <span className="value small">{formatInstant(summary.startMs, locale)}</span>
          <span className="sub mono">timestamp_ms {summary.startMs}</span>
        </div>
        <div className="analysis-card wide">
          <span className="label">{t("analysisEnd")}</span>
          <span className="value small">{formatInstant(summary.endMs, locale)}</span>
          <span className="sub mono">timestamp_ms {summary.endMs}</span>
        </div>
        <div className="analysis-card">
          <span className="label">{t("analysisSamples")}</span>
          <span className="value">{summary.rowCount.toLocaleString(locale)}</span>
          <span className="sub">{recording.sensorCount} {t("analysisSensors")}</span>
        </div>
        <div className="analysis-card">
          <span className="label">{t("analysisRate")}</span>
          <span className="value">{summary.rateHz.toFixed(1)} Hz</span>
          <span className="sub">{t("analysisMedianInterval")} {summary.intervalMs.median.toFixed(0)} ms</span>
        </div>
        <div className={`analysis-card ${clean ? "good" : "warn"}`}>
          <span className="label">{t("analysisContinuity")}</span>
          <span className="value">{clean ? t("analysisContinuous") : t("analysisHasGaps")}</span>
          <span className="sub">
            {t("analysisLostFrames")} {summary.lostFrames} · {t("analysisGaps")} {summary.timeGaps}
            {summary.restarts ? ` · ${t("analysisRestarts")} ${summary.restarts}` : ""}
          </span>
        </div>
        <div className={`analysis-card ${deviceShare === 1 ? "" : "warn"}`}>
          <span className="label">{t("analysisClock")}</span>
          <span className="value">{refTotal ? `${Math.round(deviceShare * 100)}%` : "—"}</span>
          <span className="sub">{refTotal ? t("analysisClockDevice") : t("analysisClockUnknown")}</span>
        </div>
        <div className="analysis-card">
          <span className="label">{t("analysisEvents")}</span>
          <span className="value">{eventCount}</span>
          <span className="sub">{recording.maxValue ? `${t("analysisMaxValue")} ${formatNumber(recording.maxValue)}` : ""}</span>
        </div>
      </div>
      {meta ? (
        <div className="analysis-device">
          <h4>{t("analysisDeviceInfo")}</h4>
          <RecordingMetaSummary meta={meta} className="analysis-kv analysis-device-kv" />
        </div>
      ) : (
        <p className="analysis-note">{t("analysisNoMeta")}</p>
      )}
      {meta && recordingEnd(meta) === "cut_off" ? <p className="notice warning">{t("analysisCutOff")}</p> : null}
      {recording.skippedLines ? <p className="notice warning">{t("analysisSkipped").replace("{count}", String(recording.skippedLines))}</p> : null}
      {summary.backwardsSteps ? <p className="notice warning">{t("analysisBackwards").replace("{count}", String(summary.backwardsSteps))}</p> : null}
    </section>
  );
}

function SensorTable({ rows, selected, sort, threshold, onSort, onToggle }: {
  rows: SensorStat[];
  selected: number[];
  sort: { key: SortKey; descending: boolean };
  threshold: number;
  onSort: (key: SortKey) => void;
  onToggle: (sensor: number) => void;
}) {
  const { t } = useI18n();
  const columns: [SortKey, string, string?][] = [
    ["sensor", t("analysisSensor")],
    ["mean", t("analysisMean")],
    ["peak", t("analysisPeak")],
    ["std", t("analysisStd")],
    ["activeShare", t("analysisActive"), t("analysisActiveHint").replace("{value}", formatNumber(threshold))],
  ];
  return (
    <div className="analysis-table-wrap">
      <table className="analysis-table">
        <thead>
          <tr>
            {columns.map(([key, label, title]) => (
              <th key={key} title={title} aria-sort={sort.key === key ? (sort.descending ? "descending" : "ascending") : "none"}>
                <button type="button" onClick={() => onSort(key)}>
                  {label}{sort.key === key ? (sort.descending ? " ↓" : " ↑") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const order = selected.indexOf(row.sensor);
            return (
              <tr key={row.sensor} className={order >= 0 ? "selected" : ""} onClick={() => onToggle(row.sensor)}>
                <td>
                  {order >= 0 ? <i className="analysis-swatch" style={{ background: SENSOR_COLORS[order % SENSOR_COLORS.length] }} /> : null}
                  {row.name}
                  {row.peak === 0 ? <span className="analysis-flag">{t("analysisNoSignal")}</span> : null}
                </td>
                <td>{formatNumber(row.mean)}</td>
                <td>{formatNumber(row.peak)}</td>
                <td>{formatNumber(row.std)}</td>
                <td>{(row.activeShare * 100).toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QualityPanel({ recording, summary, histogram, onFocus }: {
  recording: Recording;
  summary: ReturnType<typeof summarizeRecording>;
  histogram: IntervalHistogram | null;
  onFocus: (row: number) => void;
}) {
  const { t } = useI18n();
  const origin = recording.rowCount ? recording.time[0] : 0;
  const issueText = (issue: RecordingIssue) => {
    if (issue.kind === "lost_frames") return t("analysisIssueLost").replace("{count}", String(issue.amount));
    if (issue.kind === "time_gap") return t("analysisIssueGap").replace("{ms}", issue.amount.toFixed(0));
    if (issue.kind === "restart") return t("analysisIssueRestart");
    return t("analysisIssueBackwards").replace("{ms}", Math.abs(issue.amount).toFixed(0));
  };
  return (
    <section className="analysis-panel">
      <div className="analysis-panel-head">
        <h3>{t("analysisQuality")}</h3>
      </div>
      {histogram ? <Histogram histogram={histogram} /> : null}
      <dl className="analysis-kv">
        <dt>{t("analysisMedianInterval")}</dt>
        <dd>{summary.intervalMs.median.toFixed(1)} ms</dd>
        <dt>P95 / P99</dt>
        <dd>{summary.intervalMs.p95.toFixed(1)} / {summary.intervalMs.p99.toFixed(1)} ms</dd>
        <dt>{t("analysisLongestInterval")}</dt>
        <dd>{summary.intervalMs.max.toFixed(0)} ms</dd>
        {!recording.frameSeq ? (
          <>
            <dt>frame_seq</dt>
            <dd>{t("analysisNoFrameSeq")}</dd>
          </>
        ) : null}
      </dl>
      {summary.issues.length === 0 ? (
        <p className="analysis-good">{t("analysisNoIssues")}</p>
      ) : (
        <ul className="analysis-list">
          {summary.issues.map((issue, index) => (
            <li key={`${issue.index}-${issue.kind}-${index}`}>
              <button type="button" onClick={() => onFocus(issue.index)}>
                <span className="mono">{formatDuration(recording.time[issue.index] - origin)}</span>
                <span className={`analysis-issue ${issue.kind}`}>{issueText(issue)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Histogram({ histogram }: { histogram: IntervalHistogram }) {
  const { t } = useI18n();
  const bars = [...histogram.counts, histogram.overflow];
  const high = Math.max(1, ...bars);
  const width = 100 / bars.length;
  const total = bars.reduce((sum, value) => sum + value, 0);
  return (
    <figure className="analysis-histogram">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={t("analysisIntervalHistogram")}>
        {bars.map((count, index) => {
          const height = (count / high) * 38;
          const from = index * histogram.binWidthMs;
          const label = index === histogram.counts.length
            ? `≥ ${histogram.limitMs} ms: ${count}`
            : `${from}–${from + histogram.binWidthMs} ms: ${count} (${total ? ((count / total) * 100).toFixed(1) : 0}%)`;
          return (
            <rect
              key={index}
              x={index * width + width * 0.1}
              y={40 - height}
              width={width * 0.8}
              height={height}
              className={index === histogram.counts.length ? "overflow" : ""}
            >
              <title>{label}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption>
        <span>0 ms</span>
        <span>{t("analysisIntervalHistogram")}</span>
        <span>≥ {histogram.limitMs} ms</span>
      </figcaption>
    </figure>
  );
}

function EventsPanel({ events, colors, hasSidecar, onFocus }: {
  events: PlacedEvent[];
  colors: Map<string, string>;
  hasSidecar: boolean;
  onFocus: (row: number) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="analysis-panel">
      <div className="analysis-panel-head">
        <h3>{t("analysisEvents")}</h3>
        <span className="analysis-note">{events.length}</span>
      </div>
      {events.length === 0 ? (
        <p className="analysis-note">{hasSidecar ? t("analysisNoEventsPlaced") : t("analysisNoEvents")}</p>
      ) : (
        <div className="analysis-table-wrap">
          <table className="analysis-table">
            <thead>
              <tr>
                <th>{t("analysisTime")}</th>
                <th>{t("analysisEventApp")}</th>
                <th>{t("analysisEventName")}</th>
                <th>{t("analysisEventEdge")}</th>
                <th>{t("analysisEventValue")}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={`${event.seq}-${event.index}`} onClick={() => onFocus(event.index)}>
                  <td className="mono">
                    <i className="analysis-swatch" style={{ background: colors.get(`${event.app}/${event.event}`) }} />
                    {formatDuration(event.atMs)}
                  </td>
                  <td>{event.app}</td>
                  <td>{event.event}</td>
                  <td>{event.edge}</td>
                  <td>{event.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
