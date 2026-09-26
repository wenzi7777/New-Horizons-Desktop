import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleDot, FolderOpen, Pause, Play, Radio, RotateCcw, SkipBack, Square, Upload } from "lucide-react";

import { useI18n } from "../../i18n";
import { api, type CsvExplorerEntry } from "../../lib/api";
import { useDeviceCommand } from "../../lib/deviceCommand";
import type { NormalizedDevice } from "../../lib/device";
import type { ReadoutPackage } from "../../lib/readout";
import {
  RecordingCursor,
  SYNTH_FPS,
  SeqGapTracker,
  SyntheticFeed,
  emulatorSimulator,
  frameFromSample,
  isSidecar,
  linesForEvents,
  peakOf,
  sidecarPathFor,
  simulateAll,
} from "../../lib/sdkEmulator";
import {
  BOARDS,
  SYNTH_PATTERNS,
  VIRTUAL_TARGET_KEY,
  boardById,
  clampShape,
  downloadFile,
  type BoardSpec,
  type MatrixTarget,
  type SynthPattern,
  type VirtualDevice,
} from "../../lib/sdkProject";
import { addVisualizationListener, subscribeVisualization, unsubscribeVisualization } from "../../lib/wsClient";
import {
  MAX_EXT_LEDS,
  OLED_ROWS,
  OLED_ROW_PX,
  OLED_WIDTH_PX,
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
  type OledRow,
  type SimEvent,
} from "../../sdk/lib/index.mjs";
import { ReadoutView } from "../ReadoutView";
import { EmulatorHeatmap } from "./EmulatorHeatmap";

type Props = {
  analysis: Analysis;
  /** The device the app runs on here, and the Build tab judges it against. */
  target: MatrixTarget;
  /** Real devices with a known matrix, to pick from. */
  targets: MatrixTarget[];
  devices: NormalizedDevice[];
  virtual: VirtualDevice;
  onVirtualChange: (device: VirtualDevice) => void;
  onSelectTarget: (key: string) => void;
  /** Source lines whose statements emitted on the frame being shown. */
  onMarkLines: (lines: Set<number>) => void;
};

/** What each way of running an app needs from the panel. */
type RunProps = Pick<Props, "analysis" | "target" | "devices" | "onMarkLines">;

type DeviceSource = "live" | "recording";
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

/**
 * A recording's frames in the first shape that holds all its cells. A CSV
 * carries only P1..Pn, so its rows and columns come from the device that
 * made it, or the board it is played on; failing both, a square or a row.
 */
function reshape(frames: Frame[], candidates: ({ rows: number; cols: number } | null | undefined)[]): Frame[] {
  const count = frames[0]?.values.length ?? 0;
  const fit = candidates.find((shape) => shape && shape.rows * shape.cols === count);
  return fit ? frames.map((frame) => ({ ...frame, rows: fit.rows, cols: fit.cols })) : frames;
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
                : ["threshold", "debounce", "gate", "button"].includes(value.op)
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

const GLYPH_PX = 6;

/**
 * The OLED as the device's "app" page draws it. Rows come from the SDK's
 * oled.mjs, which mirrors the firmware to the character and the pixel; only
 * the glyphs here are the browser's font rather than the panel's.
 */
function OledPanel({ rows }: { rows: readonly (OledRow | null)[] }) {
  const { t } = useI18n();
  return (
    <div className="sdk-oled-panel">
      <svg viewBox={`0 0 ${OLED_WIDTH_PX} ${OLED_ROWS * OLED_ROW_PX}`} role="img" aria-label={t("sdkEmuOled")}>
        {rows.map((row, index) => {
          if (!row) return null;
          const y = index * OLED_ROW_PX;
          const text = row.kind === "text" ? row.text ?? "" : row.label;
          return (
            <g key={index}>
              {text ? (
                <text x={0} y={y + 7} fontSize={8} fill="currentColor" textLength={text.length * GLYPH_PX} lengthAdjust="spacingAndGlyphs" style={{ whiteSpace: "pre" }}>
                  {text}
                </text>
              ) : null}
              {row.kind === "bar" && row.bar ? (
                <>
                  <rect x={row.bar.x0 + 0.5} y={y + 0.5} width={row.bar.width - 1} height={OLED_ROW_PX - 2} fill="none" stroke="currentColor" strokeWidth={1} />
                  {row.bar.fillPx > 0 ? <rect x={row.bar.x0 + 1} y={y + 1} width={row.bar.fillPx} height={OLED_ROW_PX - 3} fill="currentColor" /> : null}
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * The OLED and the action button, for a package that uses either -- and only
 * as far as the board has them: a board without an OLED draws nothing.
 */
function OledSection({ sim, board, rows, onPress, pressDisabled, extra }: {
  sim: Simulator | null;
  board: BoardSpec | undefined;
  rows: readonly (OledRow | null)[];
  onPress: () => void;
  pressDisabled?: boolean;
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const display = Boolean(sim?.canDisplay && (board?.oled ?? true));
  const button = Boolean(sim?.hearsButton && (board?.button ?? true));
  if (!display && !button) return null;
  return (
    <section className="sdk-section sdk-oled">
      <h3>{t("sdkEmuOled")}</h3>
      {display ? <OledPanel rows={rows} /> : null}
      {display ? <p className="sdk-hint">{t("sdkEmuOledHint")}</p> : null}
      {button ? (
        <div className="sdk-oled-row">
          <button type="button" className="button compact" onClick={onPress} disabled={pressDisabled} title={t("sdkEmuPressHint")}>
            <CircleDot size={13} strokeWidth={2} />{t("sdkEmuPress")}
          </button>
          {extra}
        </div>
      ) : null}
    </section>
  );
}

/** Pixels to preview: the board's own, or every pixel an app may address. */
function stripLength(board: BoardSpec | undefined): number {
  return board ? board.externalLeds : MAX_EXT_LEDS;
}

/**
 * The external LED strip as the board shows it, for a package that drives it.
 * Nothing on a board without one; BoardFit says why.
 */
function ExtLedStrip({ sim, board, pixels }: { sim: Simulator | null; board: BoardSpec | undefined; pixels: readonly (readonly number[])[] | null }) {
  const { t } = useI18n();
  if (!sim?.canDriveExtLed || stripLength(board) === 0) return null;
  const shown = pixels ?? Array.from({ length: stripLength(board) }, () => [0, 0, 0]);
  return (
    <section className="sdk-section sdk-ext-strip">
      <h3>{t("sdkEmuExtLed")}</h3>
      <div className="sdk-strip" role="img" aria-label={t("sdkEmuExtLed")}>
        {shown.map((rgb, index) => {
          const lit = rgb.some((channel) => channel > 0);
          return (
            <span key={index} className={`sdk-strip-pixel${lit ? " lit" : ""}`} title={`${index}`} style={lit ? { background: `rgb(${rgb.join(",")})`, color: `rgb(${rgb.join(",")})` } : undefined}>
              <small>{index}</small>
            </span>
          );
        })}
      </div>
      <p className="sdk-hint">{t("sdkEmuExtLedHint")}</p>
    </section>
  );
}

const NO_ROWS: readonly (OledRow | null)[] = [];

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
    (analysis.package?.nodes ?? []).forEach((node: { op: string; event?: string; row?: number; label?: string }, index: number) => {
      if (node.event && !labels.has(index)) labels.set(index, `→ ${node.event}`);
      if (node.row !== undefined && !labels.has(index)) labels.set(index, `▭ ${node.row} "${node.label ?? ""}"`);
    });
    return labels;
  }, [analysis]);
}

// --- recordings ---------------------------------------------------------------

function RecordingEmulator({ analysis, target, devices, onMarkLines, deviceUid: fixedUid, onShape }: RunProps & {
  /** Only this device's recordings; otherwise any device's, or a local file. */
  deviceUid?: string;
  /** The loaded recording's shape, for a virtual device to take on. */
  onShape?: (rows: number, cols: number) => void;
}) {
  const { t } = useI18n();
  const pkg = useStablePackage(analysis);
  const labels = useLabels(analysis);
  const [browseUid, setBrowseUid] = useState(devices[0]?.uid ?? "");
  const deviceUid = fixedUid ?? browseUid;
  const upload = useRef<HTMLInputElement | null>(null);
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
  // Frame indices a press is delivered before, so they replay with the run.
  const [presses, setPresses] = useState<ReadonlySet<number>>(() => new Set());

  const device = devices.find((item) => item.uid === deviceUid);
  const shape = shapeOf(device) ?? { rows: target.rows, cols: target.cols };

  useEffect(() => {
    if (!browseUid && devices[0]) setBrowseUid(devices[0].uid);
  }, [browseUid, devices]);

  useEffect(() => {
    if (!deviceUid) return;
    let cancelled = false;
    setListError(null);
    api.csvDirectory(deviceUid, dir)
      .then((response) => { if (!cancelled) setEntries(response.items); })
      .catch((error: unknown) => { if (!cancelled) setListError(error instanceof Error ? error.message : "request_failed"); });
    return () => { cancelled = true; };
  }, [deviceUid, dir]);

  const show = (parsed: Frame[], name: string, events: SimEvent[] | null) => {
    setFrames(parsed);
    setFile(name);
    setIndex(0);
    setPresses(new Set());
    setRecorded(events);
    if (parsed[0]) onShape?.(parsed[0].rows, parsed[0].cols);
  };

  const load = async (entry: CsvExplorerEntry) => {
    setLoadError(null);
    setPlaying(false);
    try {
      const parsed = reshape(parseSamplesCsv(await fetchText(entry.path)), [shapeOf(device), target]);
      const sidecar = entries.find((item) => item.path === sidecarPathFor(entry.path));
      show(parsed, entry.path, sidecar ? parseEventsCsv(await fetchText(sidecar.path)) : null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "request_failed");
    }
  };

  const loadFile = async (picked: File) => {
    setLoadError(null);
    setPlaying(false);
    try {
      show(reshape(parseSamplesCsv(await picked.text()), [target]), picked.name, null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "parse_failed");
    }
  };

  // The whole run, for the timeline and the comparison; a fresh cursor for
  // stepping. Both follow every edit of the source.
  const allEvents = useMemo(() => (pkg && frames.length ? simulateAll(pkg, frames, presses) : []), [pkg, frames, presses]);
  const cursor = useMemo(() => (pkg && frames.length ? new RecordingCursor(pkg, frames, presses) : null), [pkg, frames, presses]);
  const [shown, setShown] = useState<{ values: NodeValue[]; frameEvents: SimEvent[]; led: readonly [number, number, number]; oled: (OledRow | null)[]; strip: number[][] | null } | null>(null);

  useEffect(() => {
    if (!cursor) {
      setShown(null);
      return;
    }
    cursor.setBudget(budget.load, budget.grace);
    const frameEvents = cursor.seek(index);
    setShown({ values: cursor.simulator.nodeValues(), frameEvents, led: cursor.simulator.led, oled: cursor.simulator.oledRows(), strip: cursor.simulator.extLeds(stripLength(target.board)) });
    onMarkLines(pkg && analysis.report ? linesForEvents(pkg, analysis.report.nodeLines, frameEvents) : new Set());
  }, [cursor, index, budget, pkg, analysis.report, onMarkLines, target.board]);

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
          {fixedUid === undefined ? (
            <>
              <label className="sdk-field">
                <span>{t("sdkEmuRecordingsOf")}</span>
                <select value={browseUid} onChange={(event) => { setBrowseUid(event.target.value); setDir(""); }}>
                  {devices.map((item) => <option key={item.uid} value={item.uid}>{item.displayName}</option>)}
                </select>
              </label>
              <button type="button" className="button compact" onClick={() => upload.current?.click()}>
                <Upload size={13} strokeWidth={2} />{t("sdkEmuUploadCsv")}
              </button>
              <input
                ref={upload}
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={(event) => {
                  const picked = event.target.files?.[0];
                  event.target.value = "";
                  if (picked) void loadFile(picked);
                }}
              />
            </>
          ) : null}
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
          {!visibleEntries.length && !listError && deviceUid ? <p className="sdk-hint">{t("sdkEmuNoRecordings")}</p> : null}
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

          <OledSection
            sim={cursor?.simulator ?? null}
            board={target.board}
            rows={shown?.oled ?? NO_ROWS}
            // Seen by the next frame, as on the device; stepping there shows it.
            onPress={() => {
              setPlaying(false);
              setPresses(new Set([...presses, index + 1]));
              setIndex(Math.min(frames.length - 1, index + 1));
            }}
            pressDisabled={index >= frames.length - 1}
            extra={presses.size ? (
              <>
                <span className="sdk-hint">{t("sdkEmuPresses").replace("{count}", String(presses.size))}</span>
                <button type="button" className="button compact" onClick={() => setPresses(new Set())}>{t("sdkEmuClearPresses")}</button>
              </>
            ) : null}
          />

          <ExtLedStrip sim={cursor?.simulator ?? null} board={target.board} pixels={shown?.strip ?? null} />

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

function LiveEmulator({ analysis, target, devices, onMarkLines, deviceUid }: RunProps & { deviceUid: string }) {
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
  const [running, setRunning] = useState(false);
  const [budget, setBudget] = useState({ load: 0, grace: 0 });
  const [view, setView] = useState<{ frame: Frame | null; values: NodeValue[]; events: SimEvent[]; led: readonly [number, number, number]; oled: (OledRow | null)[]; strip: number[][] | null; coverage: number; missed: number; received: number } | null>(null);
  const simRef = useRef<Simulator | null>(null);
  const gapsRef = useRef(new SeqGapTracker());
  const fallbackSeq = useRef(0);
  const pending = useRef<{ frame: Frame; events: SimEvent[] } | null>(null);

  const device = devices.find((item) => item.uid === deviceUid);
  const shape = shapeOf(device) ?? { rows: target.rows, cols: target.cols };
  const shapeRef = useRef(shape);
  shapeRef.current = shape;
  const stripRef = useRef(stripLength(target.board));
  stripRef.current = stripLength(target.board);

  const reset = useCallback(() => {
    simRef.current = pkg ? emulatorSimulator(pkg) : null;
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
      setView({ frame: latest.frame, values: sim.nodeValues(), events: sim.events.slice(-MAX_EVENTS_SHOWN), led: sim.led, oled: sim.oledRows(), strip: sim.extLeds(stripRef.current), coverage: gaps.coverage, missed: gaps.missed, received: gaps.received });
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
        {device && device.connectionState !== "online" ? <p className="notice warning">{t("sdkEmuOffline").replace("{state}", device.connectionState)}</p> : null}
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
          {/* Delivered to the next frame the stream brings, as a real press is. */}
          <OledSection sim={simRef.current} board={target.board} rows={view.oled} onPress={() => simRef.current?.pressButton()} />
          <ExtLedStrip sim={simRef.current} board={target.board} pixels={view.strip} />
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

// --- generated ----------------------------------------------------------------

const PATTERN_LABELS: Record<SynthPattern, string> = {
  none: "sdkEmuPatternNone",
  tap: "sdkEmuPatternTap",
  hold: "sdkEmuPatternHold",
  swipe: "sdkEmuPatternSwipe",
  ramp: "sdkEmuPatternRamp",
};

/** A virtual device's own frames: a preset pattern, the mouse, and noise. */
function GeneratedEmulator({ analysis, target, onMarkLines, virtual, onVirtualChange }: RunProps & {
  virtual: VirtualDevice;
  onVirtualChange: (device: VirtualDevice) => void;
}) {
  const { t } = useI18n();
  const pkg = useStablePackage(analysis);
  const pkgRef = useRef(pkg);
  pkgRef.current = pkg;
  const reportRef = useRef(analysis.report);
  reportRef.current = analysis.report;
  const onMarkLinesRef = useRef(onMarkLines);
  onMarkLinesRef.current = onMarkLines;
  const labels = useLabels(analysis);
  // Nothing to wait for or disturb, so it runs as soon as it is shown.
  const [running, setRunning] = useState(true);
  const [budget, setBudget] = useState({ load: 0, grace: 0 });
  const [view, setView] = useState<{ frame: Frame | null; values: NodeValue[]; events: SimEvent[]; led: readonly [number, number, number]; oled: (OledRow | null)[]; strip: number[][] | null; frames: number } | null>(null);
  const simRef = useRef<Simulator | null>(null);
  // The panel is keyed on the shape, so one feed serves this mount.
  const feedRef = useRef(new SyntheticFeed(target.rows, target.cols, { pattern: virtual.pattern, noise: virtual.noise }));
  const framesRef = useRef(0);
  const boardRef = useRef(target.board);
  boardRef.current = target.board;

  const reset = useCallback(() => {
    simRef.current = pkg ? emulatorSimulator(pkg) : null;
    simRef.current?.setBudget(budget.load, budget.grace);
    framesRef.current = 0;
    setView(null);
  }, [pkg, budget.load, budget.grace]);

  useEffect(() => { reset(); }, [pkg]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { simRef.current?.setBudget(budget.load, budget.grace); }, [budget]);
  useEffect(() => {
    feedRef.current.pattern = virtual.pattern;
    feedRef.current.noise = virtual.noise;
  }, [virtual.pattern, virtual.noise]);

  useEffect(() => {
    if (!running) return undefined;
    const period = 1000 / SYNTH_FPS;
    let clock = performance.now();
    // Frames are made at the scan rate in device time; the screen is redrawn
    // on the live view's timer, with every frame in between evaluated.
    const timer = window.setInterval(() => {
      const sim = simRef.current;
      if (!sim) return;
      const now = performance.now();
      let frame: Frame | null = null;
      const events: SimEvent[] = [];
      for (let made = 0; clock <= now && made < SYNTH_FPS; made += 1) {
        frame = feedRef.current.frame(clock);
        events.push(...sim.step(frame));
        framesRef.current += 1;
        clock += period;
      }
      // A backgrounded tab skips ahead rather than replaying the gap.
      if (clock < now) clock = now;
      if (!frame) return;
      setView({ frame, values: sim.nodeValues(), events: sim.events.slice(-MAX_EVENTS_SHOWN), led: sim.led, oled: sim.oledRows(), strip: sim.extLeds(stripLength(boardRef.current)), frames: framesRef.current });
      const report = reportRef.current;
      const currentPkg = pkgRef.current;
      if (currentPkg && report && events.length) onMarkLinesRef.current(linesForEvents(currentPkg, report.nodeLines, events));
    }, LIVE_PAINT_MS);
    return () => {
      window.clearInterval(timer);
      onMarkLinesRef.current(new Set());
    };
  }, [running]);

  const range = useMemo(() => ({ min: 0, max: PRESSURE_FULL_SCALE }), []);
  const press = useCallback((cell: { row: number; col: number } | null) => feedRef.current.press(cell, performance.now()), []);

  return (
    <>
      <section className="sdk-section sdk-picker">
        <div className="sdk-picker-row">
          <label className="sdk-field">
            <span>{t("sdkEmuPattern")}</span>
            <select value={virtual.pattern} onChange={(event) => onVirtualChange({ ...virtual, pattern: event.target.value as SynthPattern })}>
              {SYNTH_PATTERNS.map((pattern) => <option key={pattern} value={pattern}>{t(PATTERN_LABELS[pattern])}</option>)}
            </select>
          </label>
          <label className="sdk-field">
            <span>{t("sdkEmuNoise")} <strong className="sdk-mono">{Math.round(virtual.noise * 100)}%</strong></span>
            <input type="range" min={0} max={1} step={0.05} value={virtual.noise} onChange={(event) => onVirtualChange({ ...virtual, noise: Number(event.target.value) })} />
          </label>
        </div>
        <div className="sdk-picker-row">
          <button type="button" className={`button compact${running ? "" : " primary"}`} disabled={!pkg} onClick={() => setRunning(!running)}>
            {running ? <Square size={13} /> : <Play size={13} />}
            {running ? t("sdkEmuStop") : t("sdkEmuStart")}
          </button>
          <button type="button" className="button compact" onClick={reset} disabled={!pkg}>
            <RotateCcw size={13} />{t("sdkEmuReset")}
          </button>
          {view ? <LedDot rgb={view.led} /> : null}
        </div>
        <p className="sdk-hint">{t("sdkEmuPressMatrix")}</p>
      </section>

      <EmulatorHeatmap frame={view?.frame ?? null} rows={target.rows} cols={target.cols} range={range} regions={analysis.report?.regions ?? NO_REGIONS} ariaLabel={t("sdkEmuHeatmap")} onPress={running ? press : undefined} />
      {view ? <p className="sdk-hint sdk-mono">{t("sdkEmuReceived").replace("{n}", String(view.frames))} · {SYNTH_FPS} fps</p> : null}

      {view ? (
        <>
          <OledSection sim={simRef.current} board={target.board} rows={view.oled} onPress={() => simRef.current?.pressButton()} />
          <ExtLedStrip sim={simRef.current} board={target.board} pixels={view.strip} />
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

function ReadoutPreview({ analysis, deviceUid }: { analysis: Analysis; deviceUid: string }) {
  const { t } = useI18n();
  const { queue } = useDeviceCommand(deviceUid);
  // The preview only runs a package the validator accepted: it polls a real
  // device, and an allowlist is only a guarantee once it has been checked.
  const pkg = analysis.ok ? (analysis.package as unknown as ReadoutPackage) : null;

  return (
    <>
      <p className="sdk-hint">{t("sdkEmuReadoutHint")}</p>
      {!pkg ? <p className="notice warning">{t("sdkEmuFixFirst")}</p> : null}
      {pkg ? <ReadoutView key={`${deviceUid}-${analysis.validation?.size}`} pkg={pkg} runner={queue} /> : null}
    </>
  );
}

// --- devices ------------------------------------------------------------------

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented-control sdk-source" role="tablist" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button key={option.id} type="button" role="tab" aria-selected={value === option.id} className={value === option.id ? "active" : undefined} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The board a virtual device is, and how much of its matrix it scans. */
function VirtualSetup({ virtual, onChange }: { virtual: VirtualDevice; onChange: (device: VirtualDevice) => void }) {
  const { t } = useI18n();
  const board = boardById(virtual.boardId);
  // A recording brings its own shape; the author sets it otherwise.
  const locked = virtual.source === "recording";
  const setShape = (rows: number, cols: number) => onChange({ ...virtual, ...clampShape(board, rows, cols) });
  const tooLarge = virtual.rows > board.rows || virtual.cols > board.cols;

  return (
    <>
      <div className="sdk-picker-row">
        <label className="sdk-field">
          <span>{t("sdkEmuBoard")}</span>
          <select
            value={board.id}
            onChange={(event) => {
              const next = boardById(event.target.value);
              // A new board starts at its whole matrix; a recording's shape stays.
              onChange({ ...virtual, boardId: next.id, ...(locked ? {} : { rows: next.rows, cols: next.cols }) });
            }}
          >
            {BOARDS.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.rows} × {item.cols}</option>)}
          </select>
        </label>
        <label className="sdk-field sdk-field-shape">
          <span>{t("sdkEmuMatrix")}</span>
          <span className="sdk-shape-inputs">
            <input type="number" min={1} max={board.rows} value={virtual.rows} disabled={locked} aria-label={t("sdkEmuRows")} onChange={(event) => setShape(Number(event.target.value), virtual.cols)} />
            <span aria-hidden="true">×</span>
            <input type="number" min={1} max={board.cols} value={virtual.cols} disabled={locked} aria-label={t("sdkEmuCols")} onChange={(event) => setShape(virtual.rows, Number(event.target.value))} />
          </span>
        </label>
      </div>
      <div className="sdk-board-caps" aria-label={t("sdkEmuPeripherals")}>
        <span className={`sdk-chip${board.oled ? "" : " off"}`}>OLED {board.oled ? "✓" : "—"}</span>
        <span className={`sdk-chip${board.button ? "" : " off"}`}>{t("sdkEmuCapButton")} {board.button ? "✓" : "—"}</span>
        <span className={`sdk-chip${board.externalLeds ? "" : " off"}`}>{t("sdkEmuCapExtLed")} {board.externalLeds ? `× ${board.externalLeds}` : "—"}</span>
      </div>
      {locked ? <p className="sdk-hint">{t("sdkEmuShapeFromRecording")}</p> : null}
      {tooLarge ? (
        <p className="notice warning">
          {t("sdkEmuShapeTooLarge").replace("{shape}", `${virtual.rows} × ${virtual.cols}`).replace("{board}", board.name).replace("{max}", `${board.rows} × ${board.cols}`)}
        </p>
      ) : null}
    </>
  );
}

/** What the app uses that the chosen board does not have. */
function BoardFit({ analysis, board }: { analysis: Analysis; board: BoardSpec | undefined }) {
  const { t } = useI18n();
  if (!board) return null;
  const caps = new Set<string>(analysis.package?.manifest?.capabilities ?? []);
  const missing = [
    caps.has("display") && !board.oled ? "OLED" : null,
    caps.has("button") && !board.button ? t("sdkEmuCapButton") : null,
    caps.has("drive_ext_led") && !board.externalLeds ? t("sdkEmuCapExtLed") : null,
    caps.has("read_mag") && !board.magnetometer ? t("sdkEmuCapMag") : null,
    caps.has("power") && !board.fuelGauge ? t("sdkEmuCapGauge") : null,
  ].filter(Boolean);
  // Accepted by the device and never shown: past this board's own strip.
  const unseen = board.externalLeds
    ? [...new Set<number>((analysis.package?.nodes ?? [])
      .filter((node: { op: string; index?: number }) => node.op === "ext_pixel" && Number(node.index) >= board.externalLeds)
      .map((node: { index: number }) => Number(node.index)))].sort((a, b) => a - b)
    : [];
  if (!missing.length && !unseen.length) return null;
  return (
    <>
      {missing.length ? <p className="notice warning">{t("sdkEmuBoardLacks").replace("{board}", board.name).replace("{parts}", missing.join(", "))}</p> : null}
      {unseen.length ? (
        <p className="notice warning">
          {t("sdkEmuPixelsUnseen").replace("{pixels}", unseen.join(", ")).replace("{board}", board.name).replace("{count}", String(board.externalLeds))}
        </p>
      ) : null}
    </>
  );
}

// --- panel --------------------------------------------------------------------

export function EmulatorPanel(props: Props) {
  const { t } = useI18n();
  const { analysis, target, targets, devices, virtual, onVirtualChange, onSelectTarget } = props;
  const deviceUid = target.key === VIRTUAL_TARGET_KEY ? null : target.key.replace(/^device:/, "");
  const device = devices.find((item) => item.uid === deviceUid);
  const [deviceSource, setDeviceSource] = useState<DeviceSource>(device?.connectionState === "online" ? "live" : "recording");
  const run: RunProps = { analysis, target, devices, onMarkLines: props.onMarkLines };

  const picker = (
    <section className="sdk-section sdk-picker">
      <label className="sdk-field">
        <span>{t("sdkEmuDevice")}</span>
        <select value={target.key} onChange={(event) => onSelectTarget(event.target.value)}>
          {targets.map((item) => {
            const state = devices.find((d) => `device:${d.uid}` === item.key)?.connectionState;
            return <option key={item.key} value={item.key}>{item.label}{state && state !== "online" ? ` (${state})` : ""}</option>;
          })}
          <option value={VIRTUAL_TARGET_KEY}>{t("sdkEmuVirtual")}</option>
        </select>
      </label>
      {deviceUid === null && analysis.kind !== "readout" ? <VirtualSetup virtual={virtual} onChange={onVirtualChange} /> : null}
    </section>
  );

  if (analysis.kind === "readout") {
    return (
      <div className="sdk-panel-body">
        {picker}
        {deviceUid ? <ReadoutPreview key={deviceUid} analysis={analysis} deviceUid={deviceUid} /> : <p className="notice warning">{t("sdkEmuReadoutNeedsDevice")}</p>}
      </div>
    );
  }
  if (!analysis.package) {
    return <div className="sdk-panel-body">{picker}<p className="notice warning">{t("sdkEmuFixFirst")}</p></div>;
  }
  return (
    <div className="sdk-panel-body">
      {picker}
      <BoardFit analysis={analysis} board={target.board} />
      {deviceUid ? (
        <Segmented
          value={deviceSource}
          onChange={setDeviceSource}
          options={[{ id: "live", label: t("sdkEmuLive") }, { id: "recording", label: t("sdkEmuRecording") }]}
        />
      ) : (
        <Segmented
          value={virtual.source}
          onChange={(source) => {
            const board = boardById(virtual.boardId);
            // Back to generated frames, a recording's shape is held to the board.
            onVirtualChange({ ...virtual, source, ...(source === "generated" ? clampShape(board, virtual.rows, virtual.cols) : {}) });
          }}
          options={[{ id: "generated", label: t("sdkEmuGenerated") }, { id: "recording", label: t("sdkEmuRecording") }]}
        />
      )}
      {!analysis.ok ? <p className="notice warning">{t("sdkEmuRunsAnyway")}</p> : null}
      {deviceUid ? (
        deviceSource === "live"
          ? <LiveEmulator key={deviceUid} {...run} deviceUid={deviceUid} />
          : <RecordingEmulator key={deviceUid} {...run} deviceUid={deviceUid} />
      ) : virtual.source === "generated" ? (
        <GeneratedEmulator key={`${target.rows}x${target.cols}`} {...run} virtual={virtual} onVirtualChange={onVirtualChange} />
      ) : (
        <RecordingEmulator key="virtual" {...run} onShape={(rows, cols) => onVirtualChange({ ...virtual, rows, cols })} />
      )}
    </div>
  );
}
