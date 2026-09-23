import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FolderOpen, Pause, Play, Radio, RotateCcw, SkipBack, Square } from "lucide-react";

import { useI18n } from "../../i18n";
import { api, type CsvExplorerEntry } from "../../lib/api";
import { useDeviceCommand } from "../../lib/deviceCommand";
import type { NormalizedDevice } from "../../lib/device";
import type { ReadoutPackage } from "../../lib/readout";
import {
  RecordingCursor,
  SeqGapTracker,
  frameFromSample,
  isSidecar,
  linesForEvents,
  peakOf,
  sidecarPathFor,
  simulateAll,
} from "../../lib/sdkEmulator";
import type { MatrixTarget } from "../../lib/sdkProject";
import { addVisualizationListener, subscribeVisualization, unsubscribeVisualization } from "../../lib/wsClient";
import {
  PRESSURE_FULL_SCALE,
  Simulator,
  canonicalText,
  compareEvents,
  formatEventsCsv,
  parseEventsCsv,
  parseSamplesCsv,
  type Analysis,
  type Frame,
  type NodeValue,
  type SimEvent,
} from "../../sdk/lib/index.mjs";
import { ReadoutView } from "../ReadoutView";
import { EmulatorHeatmap } from "./EmulatorHeatmap";
import { downloadFile } from "../../lib/sdkProject";

type Props = {
  analysis: Analysis;
  target: MatrixTarget;
  devices: NormalizedDevice[];
  /** Source lines whose statements emitted on the frame being shown. */
  onMarkLines: (lines: Set<number>) => void;
};

type Source = "recording" | "live";
const SPEEDS = [0.25, 1, 4, 16] as const;
const MAX_EVENTS_SHOWN = 200;
/** Nodes with an effect but no value of their own. */
const OUTPUT_OPS = new Set(["emit", "emit_value", "led"]);

function shapeOf(device: NormalizedDevice | undefined): { rows: number; cols: number } | null {
  const raw = device?.raw as Record<string, any> | undefined;
  const shape = raw?.matrix_shape ?? raw?.last_status?.matrix_shape ?? raw?.system_summary?.matrix_shape;
  const rows = Number(shape?.rows);
  const cols = Number(shape?.cols);
  return rows > 0 && cols > 0 ? { rows, cols } : null;
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(api.downloadCsvUrl(path), { credentials: "same-origin" });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.text();
}

/** Every node's value, labelled with the signal or event it is, if any. */
function NodeTrace({ values, labels }: { values: NodeValue[]; labels: Map<number, string> }) {
  const { t } = useI18n();
  return (
    <table className="sdk-table sdk-trace">
      <thead>
        <tr><th>#</th><th>{t("sdkOp")}</th><th>{t("sdkEmuName")}</th><th className="num">{t("sdkEmuValue")}</th></tr>
      </thead>
      <tbody>
        {values.map((value, index) => (
          <tr key={index} className={value.skipped ? "skipped" : value.bool ? "on" : undefined}>
            <td className="sdk-mono">{index}</td>
            <td className="sdk-mono">{value.op}</td>
            <td className="sdk-mono">{labels.get(index) ?? ""}</td>
            <td className="num sdk-mono">
              {value.skipped
                ? t("sdkEmuSkipped")
                : ["threshold", "debounce", "gate"].includes(value.op)
                  ? (value.bool ? "true" : "false")
                  : OUTPUT_OPS.has(value.op) ? "" : value.result.toFixed(3)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EventList({ events, onPick }: { events: readonly SimEvent[]; onPick?: (event: SimEvent) => void }) {
  const { t } = useI18n();
  if (!events.length) return <p className="sdk-hint">{t("sdkEmuNoEvents")}</p>;
  const shown = events.slice(-MAX_EVENTS_SHOWN).reverse();
  return (
    <ol className="sdk-events">
      {shown.map((event) => (
        <li key={`${event.seq}-${event.frameSeq}`}>
          <button type="button" disabled={!onPick} onClick={() => onPick?.(event)}>
            <span className="sdk-mono sdk-event-frame">f{event.frameSeq}</span>
            <span className={`sdk-event-name${event.event === "degraded" ? " degraded" : ""}`}>{event.event}</span>
            <span className={`sdk-event-detail ${event.detail}`}>{event.detail}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function BudgetControls({ load, grace, onChange }: { load: number; grace: number; onChange: (load: number, grace: number) => void }) {
  const { t } = useI18n();
  return (
    <details className="sdk-budget">
      <summary>{t("sdkEmuBudget")}</summary>
      <p className="sdk-hint">{t("sdkEmuBudgetHint")}</p>
      <label>
        <span>budget_load() <strong className="sdk-mono">{load.toFixed(2)}</strong></span>
        <input type="range" min={0} max={2} step={0.05} value={load} onChange={(event) => onChange(Number(event.target.value), grace)} />
      </label>
      <label>
        <span>grace_left() <strong className="sdk-mono">{grace}</strong></span>
        <input type="range" min={0} max={5} step={1} value={grace} onChange={(event) => onChange(load, Number(event.target.value))} />
      </label>
    </details>
  );
}

function LedDot({ rgb }: { rgb: readonly [number, number, number] }) {
  const { t } = useI18n();
  const lit = rgb.some((channel) => channel > 0);
  return (
    <span className="sdk-led" title={t("sdkEmuLed")}>
      <i style={{ background: lit ? `rgb(${rgb.join(",")})` : undefined }} className={lit ? "lit" : undefined} />
      LED
    </span>
  );
}

/**
 * The compiled package, kept as the same object while its content is the same.
 * Editing a comment or re-analysing for any other reason must not restart a
 * simulation that is replaying or listening to a device.
 */
function useStablePackage(analysis: Analysis): Record<string, any> | null {
  const pkg = analysis.package;
  const key = pkg ? canonicalText(pkg) : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => pkg, [key]);
}

const NO_REGIONS: Record<string, never> = {};

/** How often the live view redraws; every frame is still evaluated. */
const LIVE_PAINT_MS = 50;

function useLabels(analysis: Analysis) {
  return useMemo(() => {
    const labels = new Map<number, string>();
    const report = analysis.report;
    if (!report) return labels;
    for (const [name, index] of Object.entries(report.signals)) labels.set(index, name);
    for (const [name, index] of Object.entries(report.events)) if (!labels.has(index)) labels.set(index, name);
    (analysis.package?.nodes ?? []).forEach((node: { op: string; event?: string }, index: number) => {
      if (node.event && !labels.has(index)) labels.set(index, `→ ${node.event}`);
    });
    return labels;
  }, [analysis]);
}

// --- recordings ---------------------------------------------------------------

function RecordingEmulator({ analysis, target, devices, onMarkLines }: Props) {
  const { t } = useI18n();
  const pkg = useStablePackage(analysis);
  const labels = useLabels(analysis);
  const [deviceUid, setDeviceUid] = useState(devices[0]?.uid ?? "");
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<CsvExplorerEntry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [recorded, setRecorded] = useState<SimEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [budget, setBudget] = useState({ load: 0, grace: 0 });

  const device = devices.find((item) => item.uid === deviceUid);
  const shape = shapeOf(device) ?? { rows: target.rows, cols: target.cols };

  useEffect(() => {
    if (!deviceUid && devices[0]) setDeviceUid(devices[0].uid);
  }, [deviceUid, devices]);

  useEffect(() => {
    if (!deviceUid) return;
    let cancelled = false;
    setListError(null);
    api.csvDirectory(deviceUid, dir)
      .then((response) => { if (!cancelled) setEntries(response.items); })
      .catch((error: unknown) => { if (!cancelled) setListError(error instanceof Error ? error.message : "request_failed"); });
    return () => { cancelled = true; };
  }, [deviceUid, dir]);

  const load = async (entry: CsvExplorerEntry) => {
    setLoadError(null);
    setPlaying(false);
    try {
      const text = await fetchText(entry.path);
      const parsed = parseSamplesCsv(text, shape);
      setFrames(parsed);
      setFile(entry.path);
      setIndex(0);
      const sidecar = entries.find((item) => item.path === sidecarPathFor(entry.path));
      setRecorded(sidecar ? parseEventsCsv(await fetchText(sidecar.path)) : null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "request_failed");
    }
  };

  // The whole run, for the timeline and the comparison; a fresh cursor for
  // stepping. Both follow every edit of the source.
  const allEvents = useMemo(() => (pkg && frames.length ? simulateAll(pkg, frames) : []), [pkg, frames]);
  const cursor = useMemo(() => (pkg && frames.length ? new RecordingCursor(pkg, frames) : null), [pkg, frames]);
  const [shown, setShown] = useState<{ values: NodeValue[]; frameEvents: SimEvent[]; led: readonly [number, number, number] } | null>(null);

  useEffect(() => {
    if (!cursor) {
      setShown(null);
      return;
    }
    cursor.setBudget(budget.load, budget.grace);
    const frameEvents = cursor.seek(index);
    setShown({ values: cursor.simulator.nodeValues(), frameEvents, led: cursor.simulator.led });
    onMarkLines(pkg && analysis.report ? linesForEvents(pkg, analysis.report.nodeLines, frameEvents) : new Set());
  }, [cursor, index, budget, pkg, analysis.report, onMarkLines]);

  useEffect(() => () => onMarkLines(new Set()), [onMarkLines]);

  // Playback in recorded time, scaled; a frame at a time when the recording
  // has no usable timestamps.
  useEffect(() => {
    if (!playing || !frames.length) return undefined;
    let raf = 0;
    let last = performance.now();
    let position = index;
    let carry = 0;
    const tick = (now: number) => {
      carry += (now - last) * speed;
      last = now;
      while (position < frames.length - 1) {
        const gap = frames[position + 1].timestampMs - frames[position].timestampMs;
        const step = gap > 0 && gap < 1000 ? gap : 16;
        if (carry < step) break;
        carry -= step;
        position += 1;
      }
      setIndex(position);
      if (position >= frames.length - 1) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // index is read once at start; the loop owns it while playing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, frames]);

  const comparison = useMemo(() => {
    if (!recorded || !pkg) return null;
    const names = new Set<string>(["degraded"]);
    for (const node of pkg.nodes as { event?: string }[]) if (node.event) names.add(node.event);
    return compareEvents(allEvents, recorded, { events: names, toleranceFrames: 1 });
  }, [allEvents, recorded, pkg]);

  const range = useMemo(() => ({ min: 0, max: Math.max(peakOf(frames), 1) || PRESSURE_FULL_SCALE }), [frames]);
  const frame = frames[index] ?? null;
  const visibleEntries = entries.filter((entry) => entry.is_dir || !isSidecar(entry.name));
  const jumpTo = (event: SimEvent) => {
    const at = frames.findIndex((f) => f.seq === event.frameSeq);
    if (at >= 0) {
      setPlaying(false);
      setIndex(at);
    }
  };

  return (
    <>
      <section className="sdk-section sdk-picker">
        <div className="sdk-picker-row">
          <label className="sdk-field">
            <span>{t("sdkEmuDevice")}</span>
            <select value={deviceUid} onChange={(event) => { setDeviceUid(event.target.value); setDir(""); }}>
              {devices.map((item) => <option key={item.uid} value={item.uid}>{item.displayName}</option>)}
            </select>
          </label>
          {dir ? (
            <button type="button" className="button compact" onClick={() => setDir(dir.split("/").slice(0, -1).join("/"))}>
              <ChevronLeft size={14} strokeWidth={2} />{dir.split("/").pop()}
            </button>
          ) : null}
        </div>
        {listError ? <p className="notice error">{listError}</p> : null}
        <div className="sdk-file-list">
          {visibleEntries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={`sdk-file${entry.path === file ? " active" : ""}`}
              onClick={() => (entry.is_dir ? setDir(entry.path.split("/").slice(1).join("/") || entry.name) : void load(entry))}
            >
              {entry.is_dir ? <FolderOpen size={13} strokeWidth={2} /> : null}
              <span className="sdk-mono">{entry.name}</span>
              {!entry.is_dir && entries.some((item) => item.path === sidecarPathFor(entry.path)) ? <span className="sdk-chip">{t("sdkEmuHasEvents")}</span> : null}
            </button>
          ))}
          {!visibleEntries.length && !listError ? <p className="sdk-hint">{t("sdkEmuNoRecordings")}</p> : null}
        </div>
        {loadError ? <p className="notice error">{loadError}</p> : null}
      </section>

      {frames.length && pkg ? (
        <>
          <div className="sdk-transport">
            <button type="button" className="button compact icon-button" onClick={() => { setPlaying(false); setIndex(0); }} aria-label={t("sdkEmuRewind")}><SkipBack size={14} /></button>
            <button type="button" className="button compact icon-button" onClick={() => setIndex(Math.max(0, index - 1))} aria-label={t("sdkEmuPrev")}><ChevronLeft size={14} /></button>
            <button type="button" className="button compact primary icon-button" onClick={() => setPlaying(!playing)} aria-label={playing ? t("sdkEmuPause") : t("sdkEmuPlay")}>
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button type="button" className="button compact icon-button" onClick={() => setIndex(Math.min(frames.length - 1, index + 1))} aria-label={t("sdkEmuNext")}><ChevronRight size={14} /></button>
            <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label={t("sdkEmuSpeed")}>
              {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
            </select>
            <span className="sdk-hint sdk-mono">{index + 1} / {frames.length} · f{frame?.seq}</span>
            <LedDot rgb={shown?.led ?? [0, 0, 0]} />
          </div>
          <div className="sdk-scrubber">
            <input type="range" min={0} max={frames.length - 1} value={index} onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value)); }} aria-label={t("sdkEmuTimeline")} />
            <div className="sdk-scrubber-marks" aria-hidden="true">
              {allEvents.filter((event) => event.detail !== "fall").slice(0, 400).map((event) => {
                const at = frames.findIndex((f) => f.seq === event.frameSeq);
                return at < 0 ? null : <i key={`${event.seq}`} className={event.event === "degraded" ? "degraded" : undefined} style={{ left: `${(at / Math.max(frames.length - 1, 1)) * 100}%` }} />;
              })}
            </div>
          </div>

          <EmulatorHeatmap frame={frame} rows={frame?.rows ?? shape.rows} cols={frame?.cols ?? shape.cols} range={range} regions={analysis.report?.regions ?? NO_REGIONS} ariaLabel={t("sdkEmuHeatmap")} />
          {frame && frame.rows * frame.cols !== target.rows * target.cols ? (
            <p className="notice warning">{t("sdkEmuShapeMismatch").replace("{rec}", `${frame.rows} × ${frame.cols}`).replace("{target}", `${target.rows} × ${target.cols}`)}</p>
          ) : null}

          <BudgetControls load={budget.load} grace={budget.grace} onChange={(load, grace) => setBudget({ load, grace })} />

          <section className="sdk-section">
            <h3>{t("sdkEmuNodes")}</h3>
            {shown ? <NodeTrace values={shown.values} labels={labels} /> : null}
          </section>

          {comparison ? (
            <section className="sdk-section">
              <h3>{t("sdkEmuCompare")}</h3>
              <p className={`notice ${comparison.onlySimulated.length || comparison.onlyRecorded.length ? "warning" : "success"}`}>
                {t("sdkEmuCompareSummary")
                  .replace("{matched}", String(comparison.matched.length))
                  .replace("{sim}", String(comparison.onlySimulated.length))
                  .replace("{rec}", String(comparison.onlyRecorded.length))}
              </p>
              {comparison.onlySimulated.length ? (<><h4 className="sdk-subhead">{t("sdkEmuOnlySimulated")}</h4><EventList events={comparison.onlySimulated} onPick={jumpTo} /></>) : null}
              {comparison.onlyRecorded.length ? (<><h4 className="sdk-subhead">{t("sdkEmuOnlyRecorded")}</h4><EventList events={comparison.onlyRecorded} onPick={jumpTo} /></>) : null}
            </section>
          ) : null}

          <section className="sdk-section">
            <div className="sdk-section-head">
              <h3>{t("sdkEmuEvents").replace("{count}", String(allEvents.length))}</h3>
              {allEvents.length ? (
                <button type="button" className="button compact" onClick={() => downloadFile({ filename: `${(file ?? "run").split("/").pop()?.replace(/\.csv$/, "")}.simulated.events.csv`, mime: "text/csv", content: formatEventsCsv(allEvents) })}>
                  {t("sdkEmuDownloadEvents")}
                </button>
              ) : null}
            </div>
            <EventList events={allEvents} onPick={jumpTo} />
          </section>
        </>
      ) : null}
    </>
  );
}

// --- live ---------------------------------------------------------------------

function LiveEmulator({ analysis, target, devices, onMarkLines }: Props) {
  const { t } = useI18n();
  const pkg = useStablePackage(analysis);
  // Read by the stream listener, which is subscribed once per start/stop.
  const pkgRef = useRef(pkg);
  pkgRef.current = pkg;
  const reportRef = useRef(analysis.report);
  reportRef.current = analysis.report;
  const onMarkLinesRef = useRef(onMarkLines);
  onMarkLinesRef.current = onMarkLines;
  const labels = useLabels(analysis);
  const online = devices.filter((device) => device.connectionState === "online");
  const [deviceUid, setDeviceUid] = useState(online[0]?.uid ?? devices[0]?.uid ?? "");
  const [running, setRunning] = useState(false);
  const [budget, setBudget] = useState({ load: 0, grace: 0 });
  const [view, setView] = useState<{ frame: Frame | null; values: NodeValue[]; events: SimEvent[]; led: readonly [number, number, number]; coverage: number; missed: number; received: number } | null>(null);
  const simRef = useRef<Simulator | null>(null);
  const gapsRef = useRef(new SeqGapTracker());
  const fallbackSeq = useRef(0);
  const pending = useRef<{ frame: Frame; events: SimEvent[] } | null>(null);

  const device = devices.find((item) => item.uid === deviceUid);
  const shape = shapeOf(device) ?? { rows: target.rows, cols: target.cols };
  const shapeRef = useRef(shape);
  shapeRef.current = shape;

  const reset = useCallback(() => {
    simRef.current = pkg ? new Simulator(pkg) : null;
    simRef.current?.setBudget(budget.load, budget.grace);
    gapsRef.current.reset();
    setView(null);
    // A new graph, or a fresh start: state from before is not this graph's.
  }, [pkg, budget.load, budget.grace]);

  useEffect(() => { reset(); }, [pkg]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { simRef.current?.setBudget(budget.load, budget.grace); }, [budget]);

  useEffect(() => {
    if (!running || !deviceUid) return undefined;
    subscribeVisualization(deviceUid);
    const uid = deviceUid.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    const off = addVisualizationListener((item) => {
      if (String(item.dn ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase() !== uid) return;
      const sim = simRef.current;
      if (!sim) return;
      fallbackSeq.current += 1;
      const frame = frameFromSample(item, shapeRef.current, fallbackSeq.current);
      if (!frame) return;
      gapsRef.current.observe(frame.seq);
      // Every frame is evaluated; only the drawing is throttled to the screen.
      const events = sim.step(frame);
      pending.current = { frame, events: [...(pending.current?.events ?? []), ...events] };
    });
    // Redrawn on a timer rather than per frame: a React render of the whole
    // panel 60 times a second is what made it flicker.
    const timer = window.setInterval(() => {
      const sim = simRef.current;
      const latest = pending.current;
      if (!sim || !latest) return;
      pending.current = null;
      const gaps = gapsRef.current;
      setView({ frame: latest.frame, values: sim.nodeValues(), events: sim.events.slice(-MAX_EVENTS_SHOWN), led: sim.led, coverage: gaps.coverage, missed: gaps.missed, received: gaps.received });
      const report = reportRef.current;
      const currentPkg = pkgRef.current;
      if (currentPkg && report && latest.events.length) onMarkLinesRef.current(linesForEvents(currentPkg, report.nodeLines, latest.events));
    }, LIVE_PAINT_MS);
    return () => {
      off();
      window.clearInterval(timer);
      unsubscribeVisualization(deviceUid);
      onMarkLinesRef.current(new Set());
    };
  }, [running, deviceUid]);

  const range = useMemo(() => ({ min: 0, max: PRESSURE_FULL_SCALE }), []);

  return (
    <>
      <section className="sdk-section sdk-picker">
        <div className="sdk-picker-row">
          <label className="sdk-field">
            <span>{t("sdkEmuDevice")}</span>
            <select value={deviceUid} disabled={running} onChange={(event) => setDeviceUid(event.target.value)}>
              {devices.map((item) => (
                <option key={item.uid} value={item.uid}>{item.displayName}{item.connectionState === "online" ? "" : ` (${item.connectionState})`}</option>
              ))}
            </select>
          </label>
          <button type="button" className={`button compact${running ? "" : " primary"}`} disabled={!deviceUid || !pkg} onClick={() => setRunning(!running)}>
            {running ? <Square size={13} /> : <Radio size={13} />}
            {running ? t("sdkEmuStop") : t("sdkEmuStart")}
          </button>
          <button type="button" className="button compact" onClick={reset} disabled={!pkg}>
            <RotateCcw size={13} />{t("sdkEmuReset")}
          </button>
          {view ? <LedDot rgb={view.led} /> : null}
        </div>
        <p className="sdk-hint">{t("sdkEmuLiveHint")}</p>
      </section>

      {running && !view ? <p className="sdk-hint">{t("sdkEmuWaiting")}</p> : null}
      {view && view.missed > 0 ? (
        <p className="notice warning">
          {t("sdkEmuGaps").replace("{pct}", (100 * (1 - view.coverage)).toFixed(1)).replace("{missed}", String(view.missed))}
        </p>
      ) : null}

      {view ? (
        <>
          <EmulatorHeatmap frame={view.frame} rows={view.frame?.rows ?? shape.rows} cols={view.frame?.cols ?? shape.cols} range={range} regions={analysis.report?.regions ?? NO_REGIONS} ariaLabel={t("sdkEmuHeatmap")} />
          <p className="sdk-hint sdk-mono">{t("sdkEmuReceived").replace("{n}", String(view.received))} · f{view.frame?.seq}</p>
          <BudgetControls load={budget.load} grace={budget.grace} onChange={(load, grace) => setBudget({ load, grace })} />
          <section className="sdk-section">
            <h3>{t("sdkEmuNodes")}</h3>
            <NodeTrace values={view.values} labels={labels} />
          </section>
          <section className="sdk-section">
            <h3>{t("sdkEmuEvents").replace("{count}", String(view.events.length))}</h3>
            <EventList events={view.events} />
          </section>
        </>
      ) : null}
    </>
  );
}

// --- readouts -----------------------------------------------------------------

function ReadoutPreview({ analysis, devices }: Props) {
  const { t } = useI18n();
  const online = devices.filter((device) => device.connectionState === "online");
  const [deviceUid, setDeviceUid] = useState(online[0]?.uid ?? devices[0]?.uid ?? "");
  const { queue } = useDeviceCommand(deviceUid);
  // The preview only runs a package the validator accepted: it polls a real
  // device, and an allowlist is only a guarantee once it has been checked.
  const pkg = analysis.ok ? (analysis.package as unknown as ReadoutPackage) : null;

  return (
    <>
      <section className="sdk-section sdk-picker">
        <label className="sdk-field">
          <span>{t("sdkEmuDevice")}</span>
          <select value={deviceUid} onChange={(event) => setDeviceUid(event.target.value)}>
            {devices.map((item) => <option key={item.uid} value={item.uid}>{item.displayName}</option>)}
          </select>
        </label>
        <p className="sdk-hint">{t("sdkEmuReadoutHint")}</p>
      </section>
      {!pkg ? <p className="notice warning">{t("sdkEmuFixFirst")}</p> : null}
      {pkg && deviceUid ? <ReadoutView key={`${deviceUid}-${analysis.validation?.size}`} pkg={pkg} runner={queue} /> : null}
    </>
  );
}

// --- panel --------------------------------------------------------------------

export function EmulatorPanel(props: Props) {
  const { t } = useI18n();
  const [source, setSource] = useState<Source>("recording");

  if (props.analysis.kind === "readout") {
    return <div className="sdk-panel-body"><ReadoutPreview {...props} /></div>;
  }
  if (!props.analysis.package) {
    return <div className="sdk-panel-body"><p className="notice warning">{t("sdkEmuFixFirst")}</p></div>;
  }
  return (
    <div className="sdk-panel-body">
      <div className="segmented-control sdk-source" role="tablist" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <button type="button" role="tab" aria-selected={source === "recording"} className={source === "recording" ? "active" : undefined} onClick={() => setSource("recording")}>
          {t("sdkEmuRecording")}
        </button>
        <button type="button" role="tab" aria-selected={source === "live"} className={source === "live" ? "active" : undefined} onClick={() => setSource("live")}>
          {t("sdkEmuLive")}
        </button>
      </div>
      {!props.analysis.ok ? <p className="notice warning">{t("sdkEmuRunsAnyway")}</p> : null}
      {source === "recording" ? <RecordingEmulator {...props} /> : <LiveEmulator {...props} />}
    </div>
  );
}
