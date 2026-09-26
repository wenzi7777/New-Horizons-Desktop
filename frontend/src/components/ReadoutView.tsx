import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import { useI18n } from "../i18n";
import {
  type ReadoutPackage,
  type ReadoutSection,
  chartPoints,
  chartRange,
  chartSample,
  extractSource,
  formatValue,
  numericValue,
  pushChartHistory,
  readoutRejectionReason,
  refreshInterval,
  sortRows,
} from "../lib/readout";
import type { CommandRunner } from "../lib/deviceFileTransfer";

type Row = Record<string, unknown>;
type History = (number | null)[][];

const CHART_WIDTH = 600;
const CHART_HEIGHT = 140;

export type ReadoutViewProps = {
  pkg: ReadoutPackage;
  /** Injected so this shares whatever single-flight mutex the host page owns. */
  runner: CommandRunner;
  busy?: boolean;
};

function StatsSection({ section, data }: { section: ReadoutSection; data: Record<string, Row | Row[]> }) {
  return (
    <div className="readout-stats">
      {(section.items ?? []).map((item) => {
        const source = data[item.source];
        const row = Array.isArray(source) ? source[0] : source;
        return (
          <div className="readout-stat" key={`${item.source}.${item.field}`} title={item.hint}>
            <span className="readout-stat-label">
              {item.label}
              {item.hint ? <abbr className="readout-hint" title={item.hint}>?</abbr> : null}
            </span>
            <strong className="readout-stat-value">
              {formatValue(row?.[item.field], item.format)}
            </strong>
          </div>
        );
      })}
    </div>
  );
}

function TableSection({ section, data }: { section: ReadoutSection; data: Record<string, Row | Row[]> }) {
  const { t } = useI18n();
  const source = section.source ? data[section.source] : [];
  const rows = sortRows(Array.isArray(source) ? source : [], section.sort);
  const columns = section.columns ?? [];

  return (
    <table className="readout-table">
      <thead>
        <tr>{columns.map((column) => <th key={column.field}>{column.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={String(row.name ?? index)}>
            {columns.map((column) => {
              const value = row[column.field];
              const numeric = numericValue(value);
              const max = column.bar_max ?? 1000;
              return (
                <td key={column.field}>
                  {column.bar && numeric !== null ? (
                    <span className="readout-cell-bar">
                      <span className="readout-bar-track">
                        <span
                          className="readout-bar-fill"
                          style={{ width: `${Math.min((numeric / max) * 100, 100)}%` }}
                        />
                      </span>
                      <span className="readout-bar-value">{formatValue(value, column.format)}</span>
                    </span>
                  ) : (
                    formatValue(value, column.format)
                  )}
                </td>
              );
            })}
          </tr>
        ))}
        {!rows.length ? (
          <tr><td colSpan={columns.length || 1} className="readout-empty">{t("readoutNoRows")}</td></tr>
        ) : null}
      </tbody>
    </table>
  );
}

/**
 * Up to four numeric fields over the last `points` polls. The history lives
 * here, in the browser -- the device reports only the present -- so it
 * starts empty each time the readout is opened.
 */
function ChartSection({ section, history }: { section: ReadoutSection; history: History }) {
  const { t } = useI18n();
  const series = section.series ?? [];
  const points = chartPoints(section);
  const { min, max } = chartRange(section, history);
  const x = (index: number) => (points <= 1 ? 0 : (index / (points - 1)) * CHART_WIDTH);
  const y = (value: number) => CHART_HEIGHT - ((value - min) / (max - min)) * CHART_HEIGHT;
  // Right-aligned: the newest poll is always at the right edge.
  const offset = points - history.length;
  const latest = history.length ? history[history.length - 1] : [];

  const paths = series.map((_, line) => {
    let d = "";
    let pen = false;
    history.forEach((sample, index) => {
      const value = sample[line];
      if (value === null || value === undefined) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(index + offset).toFixed(1)},${y(value).toFixed(1)}`;
      pen = true;
    });
    return d;
  });

  return (
    <div className="readout-chart">
      <div className="readout-chart-legend">
        {series.map((line, index) => (
          <span key={line.field} className={`readout-chart-key series-${index}`}>
            <i aria-hidden="true" />
            {line.label ?? line.field}
            <strong>{latest[index] === null || latest[index] === undefined ? "—" : formatValue(latest[index], "raw")}</strong>
          </span>
        ))}
      </div>
      {history.length ? (
        <svg
          className="readout-chart-plot"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={section.title}
        >
          {min < 0 && max > 0 ? <line className="readout-chart-zero" x1={0} x2={CHART_WIDTH} y1={y(0)} y2={y(0)} /> : null}
          {paths.map((d, index) => (d ? <path key={index} className={`series-${index}`} d={d} vectorEffect="non-scaling-stroke" /> : null))}
        </svg>
      ) : (
        <p className="readout-empty">{t("readoutNoRows")}</p>
      )}
      {history.length ? (
        <div className="readout-chart-axis">
          <span>{formatValue(Number(min.toPrecision(4)), "raw")} – {formatValue(Number(max.toPrecision(4)), "raw")}</span>
          <span>{history.length} / {points}</span>
        </div>
      ) : null}
    </div>
  );
}

export function ReadoutView({ pkg, runner, busy = false }: ReadoutViewProps) {
  const { t } = useI18n();
  const spec = pkg.readout;
  const rejection = useMemo(() => readoutRejectionReason(pkg), [pkg]);
  const [data, setData] = useState<Record<string, Row | Row[]>>({});
  // Per chart section, by index: the polls it has seen.
  const [history, setHistory] = useState<Record<number, History>>({});
  useEffect(() => setHistory({}), [pkg]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  // Read through a ref: a caller that passes a fresh runner each render would
  // otherwise restart the polling effect -- and fire a pass -- on every render.
  const runnerRef = useRef(runner);
  runnerRef.current = runner;

  const poll = useCallback(async () => {
    // One pass at a time: the device answers one command per connection, and
    // overlapping passes would queue up behind each other indefinitely.
    if (inFlight.current || rejection) return;
    inFlight.current = true;
    try {
      const next: Record<string, Row | Row[]> = {};
      // Distinct commands only -- several sources often read one command.
      const byCommand = new Map<string, Record<string, unknown> | null>();
      for (const source of spec.sources) {
        if (!byCommand.has(source.command)) {
          const response = await runnerRef.current({ command: source.command });
          byCommand.set(source.command, response.result as Record<string, unknown> | null);
        }
        next[source.id] = extractSource(byCommand.get(source.command) ?? null, source);
      }
      setData(next);
      setHistory((previous) => {
        const updated: Record<number, History> = { ...previous };
        spec.sections.forEach((section, index) => {
          if (section.kind !== "chart" || !section.source) return;
          updated[index] = pushChartHistory(previous[index] ?? [], chartSample(section, next[section.source]), chartPoints(section));
        });
        return updated;
      });
      setUpdatedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
    }
  }, [spec.sources, spec.sections, rejection]);

  useEffect(() => {
    if (!live || rejection) return;
    void poll();
    const handle = window.setInterval(() => void poll(), refreshInterval(spec));
    return () => window.clearInterval(handle);
  }, [live, poll, spec, rejection]);

  if (rejection) {
    return <p className="notice error">{t("readoutRejected")}: {rejection}</p>;
  }

  return (
    <section className="readout-view">
      <header className="readout-header">
        <div className="readout-header-meta">
          <span className={`readout-live${live ? " on" : ""}`}>
            <i aria-hidden="true" />
            {live ? t("readoutLive") : t("readoutPaused")}
          </span>
          {updatedAt ? (
            <span>{t("readoutUpdated")} {new Date(updatedAt).toLocaleTimeString()}</span>
          ) : <span>{t("loading")}</span>}
          <span>{t("readoutInterval")} {refreshInterval(spec)} ms</span>
        </div>
        <div className="readout-header-actions">
          <button
            type="button"
            className="button ghost compact icon-button"
            disabled={busy}
            aria-label={t("refresh")}
            title={t("refresh")}
            onClick={() => void poll()}
          >
            <RefreshCw size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="button compact"
            aria-pressed={!live}
            onClick={() => setLive((value) => !value)}
          >
            {live ? <Pause size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} />}
            {live ? t("readoutPause") : t("readoutResume")}
          </button>
        </div>
      </header>

      {error ? <p className="notice error">{error}</p> : null}

      {spec.sections.map((section, index) => (
        <div className="readout-section" key={`${section.kind}-${index}`}>
          <h4>{section.title}</h4>
          {section.kind === "stats"
            ? <StatsSection section={section} data={data} />
            : section.kind === "chart"
              ? <ChartSection section={section} history={history[index] ?? []} />
              : <TableSection section={section} data={data} />}
        </div>
      ))}
    </section>
  );
}
