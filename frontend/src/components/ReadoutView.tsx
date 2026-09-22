import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  type ReadoutPackage,
  type ReadoutSection,
  extractSource,
  formatValue,
  numericValue,
  readoutRejectionReason,
  refreshInterval,
  sortRows,
} from "../lib/readout";
import type { CommandRunner } from "../lib/deviceFileTransfer";

type Row = Record<string, unknown>;

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

export function ReadoutView({ pkg, runner, busy = false }: ReadoutViewProps) {
  const { t } = useI18n();
  const spec = pkg.readout;
  const rejection = useMemo(() => readoutRejectionReason(pkg), [pkg]);
  const [data, setData] = useState<Record<string, Row | Row[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const inFlight = useRef(false);

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
          const response = await runner({ command: source.command });
          byCommand.set(source.command, response.result as Record<string, unknown> | null);
        }
        next[source.id] = extractSource(byCommand.get(source.command) ?? null, source);
      }
      setData(next);
      setUpdatedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
    }
  }, [runner, spec.sources, rejection]);

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
          {updatedAt ? (
            <span>{t("readoutUpdated")}: {new Date(updatedAt).toLocaleTimeString()}</span>
          ) : <span>{t("loading")}</span>}
          <span>{t("readoutInterval")}: {refreshInterval(spec)} ms</span>
        </div>
        <div className="readout-header-actions">
          <button type="button" className="button" disabled={busy} onClick={() => void poll()}>
            {t("refresh")}
          </button>
          <button type="button" className="button" onClick={() => setLive((value) => !value)}>
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
            : <TableSection section={section} data={data} />}
        </div>
      ))}
    </section>
  );
}
