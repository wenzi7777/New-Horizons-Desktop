import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, MoreHorizontal, Pause, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { ConfirmModal } from "./ConfirmModal";
import { useI18n } from "../i18n";
import {
  type ReadoutSection,
  chartPoints,
  chartRange,
  chartSample,
  numericValue,
  pushChartHistory,
} from "../lib/readout";
import {
  type PanelAction,
  type PanelSection,
  type RunEntry,
  actionEnabled,
  actionHidden,
  createCommandLock,
  extractSource,
  fieldValue,
  filterRunEntries,
  fillMessage,
  formatValue,
  inputDefault,
  panelErrorKey,
  panelModel,
  panelRejectionReason,
  parseInput,
  refreshInterval,
  resolveArgs,
  runEntries,
  sortRows,
  supportedActions,
} from "../lib/panel";
import { quietCommand } from "../lib/deviceCommand";
import type { CommandRunner } from "../lib/deviceFileTransfer";

type Row = Record<string, unknown>;
type History = (number | null)[][];
type Data = Record<string, Row | Row[]>;

/** The readout helpers take a readout section; a panel's chart section is one. */
const asReadout = (section: PanelSection) => section as unknown as ReadoutSection;

const CHART_WIDTH = 600;
const CHART_HEIGHT = 140;
const MAX_RUN_SUGGESTIONS = 8;

export type PanelViewProps = {
  /** A panel or a readout package; a readout is a panel without actions. */
  pkg: unknown;
  /** Injected so this shares whatever single-flight mutex the host page owns. */
  runner: CommandRunner;
  /**
   * Runs the timed polls, when the host has a background path: one that stays
   * out of the page's busy state and operation log, and answers
   * `{result: null}` instead of queueing while an operator command holds the
   * device. Without it, polls go through `runner`. Polling through an
   * operator runner marked the page busy every second -- which disabled the
   * Run box (dropping its focus) and the row menus mid-click.
   */
  poll?: CommandRunner;
  busy?: boolean;
  /**
   * The device's own command names (its `commands` catalog). An action whose
   * command is missing is hidden -- older firmware. null: unknown, show all.
   */
  supportedCommands?: ReadonlySet<string> | null;
};

/** The permissions a panel declares, as the operator should read them. */
export function PanelPermissionList({ permissions }: { permissions: readonly string[] }) {
  const { t } = useI18n();
  if (!permissions.length) return null;
  return (
    <div className="panel-permissions">
      <span className="panel-permissions-title">
        <ShieldCheck size={14} strokeWidth={2} aria-hidden="true" />
        {t("panelPermissionsTitle")}
      </span>
      <ul>
        {permissions.map((permission) => (
          <li key={permission}>{t(`panelPermission_${permission}`)}</li>
        ))}
      </ul>
    </div>
  );
}

function StatsSection({ section, data }: { section: PanelSection; data: Data }) {
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
              {formatValue(fieldValue(row, item.field), item.format)}
            </strong>
          </div>
        );
      })}
    </div>
  );
}

type RowMenu = { key: string; row: Row; actions: PanelAction[]; x: number; y: number };

function TableSection({
  section,
  data,
  sectionKey,
  actions,
  disabled,
  onAction,
}: {
  section: PanelSection;
  data: Data;
  sectionKey: string;
  actions: Map<string, PanelAction>;
  disabled: boolean;
  onAction: (action: PanelAction, row: Row) => void;
}) {
  const { t } = useI18n();
  const source = section.source ? data[section.source] : [];
  const rows = sortRows(Array.isArray(source) ? source : [], section.sort);
  const columns = section.columns ?? [];
  const rowActions = (section.row_actions ?? [])
    .map((id) => actions.get(id))
    .filter((action): action is PanelAction => Boolean(action));
  const [menu, setMenu] = useState<RowMenu | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".panel-row-menu")) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <>
      <table className="readout-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column.field}>{column.label}</th>)}
            {rowActions.length ? <th className="panel-row-actions-head" aria-label={t("panelActions")} /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = String(row.name ?? index);
            const visible = rowActions.filter((action) => !actionHidden(action, row));
            return (
              <tr key={key}>
                {columns.map((column) => {
                  const value = fieldValue(row, column.field);
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
                {rowActions.length ? (
                  <td className="panel-row-actions">
                    {visible.length ? (
                      <button
                        type="button"
                        className="button ghost compact icon-button"
                        aria-label={`${t("panelActions")}: ${key}`}
                        aria-haspopup="menu"
                        aria-expanded={menu?.key === `${sectionKey}:${key}`}
                        title={t("panelActions")}
                        // Always opens: its items carry the busy state, so a
                        // click is never lost to a poll in flight.
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setMenu((current) =>
                            current?.key === `${sectionKey}:${key}`
                              ? null
                              : { key: `${sectionKey}:${key}`, row, actions: visible, x: rect.right, y: rect.bottom + 4 });
                        }}
                      >
                        <MoreHorizontal size={15} strokeWidth={2} />
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
          {!rows.length ? (
            <tr>
              <td colSpan={(columns.length || 1) + (rowActions.length ? 1 : 0)} className="readout-empty">
                {t("readoutNoRows")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {menu ? (
        <ul
          className="panel-row-menu"
          role="menu"
          // Fixed, not inside the table: the table clips its overflow.
          style={{ top: menu.y, left: Math.max(8, menu.x - 200) }}
        >
          {menu.actions.map((action) => {
            const enabled = actionEnabled(action.when, menu.row);
            return (
              <li key={action.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={action.confirm?.destructive ? "danger" : undefined}
                  disabled={!enabled || disabled}
                  onClick={() => {
                    setMenu(null);
                    onAction(action, menu.row);
                  }}
                >
                  {action.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

/**
 * Up to four numeric fields over the last `points` polls. The history lives
 * here, in the browser -- the device reports only the present -- so it
 * starts empty each time the panel is opened.
 */
function ChartSection({ section, history }: { section: PanelSection; history: History }) {
  const { t } = useI18n();
  const series = section.series ?? [];
  const points = chartPoints(asReadout(section));
  const { min, max } = chartRange(asReadout(section), history);
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

/**
 * "Run": type a name, pick from what can be started now, Enter. Offers only
 * the panel's own declared actions on rows they are enabled for -- it is not
 * a command line; arbitrary commands stay in the Terminal.
 */
function RunSection({
  section,
  data,
  actions,
  disabled,
  onAction,
}: {
  section: PanelSection;
  data: Data;
  actions: Map<string, PanelAction>;
  disabled: boolean;
  onAction: (action: PanelAction, row: Row) => void;
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [focused, setFocused] = useState(false);
  const all = useMemo(() => runEntries(section, actions, data), [section, actions, data]);
  const matches = useMemo(() => filterRunEntries(all, typed).slice(0, MAX_RUN_SUGGESTIONS), [all, typed]);
  const exact = all.find((entry) => entry.label.toLowerCase() === typed.trim().toLowerCase());
  const chosen: RunEntry | undefined = exact ?? matches[Math.min(highlight, matches.length - 1)];
  useEffect(() => setHighlight(0), [typed]);

  const submit = (entry: RunEntry | undefined) => {
    if (!entry || disabled) return;
    setTyped("");
    onAction(entry.action, entry.row);
  };

  return (
    <div className="panel-run">
      <div className="panel-run-field">
        <input
          type="text"
          role="combobox"
          aria-expanded={focused && matches.length > 0}
          aria-autocomplete="list"
          aria-label={section.title}
          placeholder={section.placeholder ?? t("panelRunPlaceholder")}
          value={typed}
          // Never disabled: disabling a focused input drops its focus, and
          // the device being busy is no reason to stop someone typing. Only
          // sending waits (the button and Enter below).
          spellCheck={false}
          autoComplete="off"
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight((value) => Math.min(value + 1, Math.max(matches.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight((value) => Math.max(value - 1, 0));
            } else if (event.key === "Tab" && chosen && typed && chosen.label !== typed) {
              event.preventDefault();
              setTyped(chosen.label);
            } else if (event.key === "Enter") {
              event.preventDefault();
              // Stop here: the confirm dialog this opens listens for Enter too.
              event.stopPropagation();
              submit(typed.trim() ? chosen : undefined);
            }
          }}
        />
        <button
          type="button"
          className="button primary compact"
          disabled={disabled || !typed.trim() || !chosen}
          onClick={() => submit(chosen)}
        >
          <CornerDownLeft size={14} strokeWidth={2} />
          {t("panelRun")}
        </button>
      </div>
      {focused && typed.trim() && !matches.length ? (
        <p className="panel-run-empty">{all.length ? t("panelRunNoMatch") : t("panelRunNothingStopped")}</p>
      ) : null}
      {focused && matches.length ? (
        <ul className="panel-run-list" role="listbox">
          {matches.map((entry, index) => (
            <li key={`${entry.action.id}:${entry.label}`} role="option" aria-selected={entry === chosen}>
              <button
                type="button"
                className={entry === chosen ? "active" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => submit(entry)}
              >
                <strong>{entry.label}</strong>
                <span>{entry.action.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!typed && all.length ? (
        <p className="panel-run-hint">{t("panelRunAvailable").replace("{count}", String(all.length))}</p>
      ) : null}
    </div>
  );
}

type Pending = { action: PanelAction; row: Row; input?: Row };
type InputState = { action: PanelAction; row: Row; value: string; error: string | null };

function InputModal({
  state,
  onChange,
  onSubmit,
  onCancel,
}: {
  state: InputState;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const input = state.action.input!;
  const numeric = input.kind !== "text";
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="panel-input-title" onClick={onCancel}>
      <form
        className="modal-panel confirm-modal-panel panel-input-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      >
        <h3 id="panel-input-title">{state.action.label}</h3>
        <label className="panel-input-field">
          <span>{input.label ?? input.field}{input.unit ? ` (${input.unit})` : ""}</span>
          <input
            autoFocus
            type={numeric ? "number" : "text"}
            inputMode={numeric ? "numeric" : undefined}
            min={input.min}
            max={input.max}
            value={state.value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        {numeric && (typeof input.min === "number" || typeof input.max === "number") ? (
          <p className="service-muted">
            {t("panelInputRange")
              .replace("{min}", typeof input.min === "number" ? input.min.toLocaleString() : "—")
              .replace("{max}", typeof input.max === "number" ? input.max.toLocaleString() : "—")}
          </p>
        ) : null}
        {state.error ? <p className="notice error">{t(state.error)}</p> : null}
        <div className="confirm-modal-actions">
          <button className="button" type="button" onClick={onCancel}>{t("cancel")}</button>
          <button className="button primary" type="submit">{t("panelInputNext")}</button>
        </div>
      </form>
    </div>
  );
}

/** Every chart section, by a key that stays stable across tabs. */
function chartSections(sections: PanelSection[], prefix = ""): { key: string; section: PanelSection }[] {
  const found: { key: string; section: PanelSection }[] = [];
  sections.forEach((section, index) => {
    const key = `${prefix}${index}`;
    if (section.kind === "chart" && section.source) found.push({ key, section });
    if (section.kind === "tabs") {
      (section.tabs ?? []).forEach((tab, tabIndex) => {
        found.push(...chartSections(tab.sections ?? [], `${key}.${tabIndex}.`));
      });
    }
  });
  return found;
}

export function PanelView({ pkg, runner, poll: pollRunner, busy = false, supportedCommands = null }: PanelViewProps) {
  const { t } = useI18n();
  const model = useMemo(() => panelModel(pkg), [pkg]);
  const rejection = useMemo(() => panelRejectionReason(pkg), [pkg]);
  const spec = model?.spec;
  const actions = useMemo(() => {
    const declared = rejection || !spec ? [] : supportedActions(spec.actions ?? [], supportedCommands);
    return new Map(declared.map((action) => [action.id, action]));
  }, [spec, rejection, supportedCommands]);
  const charts = useMemo(() => (spec ? chartSections(spec.sections) : []), [spec]);

  const [data, setData] = useState<Data>({});
  // Per chart section, by key: the polls it has seen.
  const [history, setHistory] = useState<Record<string, History>>({});
  useEffect(() => setHistory({}), [pkg]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  const [live, setLive] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<Record<string, number>>({});
  const [acting, setActing] = useState(false);
  const [inputState, setInputState] = useState<InputState | null>(null);
  const [confirming, setConfirming] = useState<Pending | null>(null);

  // One lock for every command this view sends -- polls and actions alike. A
  // Hub relays one command per device at a time: a poll pass is skipped while
  // an action holds the lock, and an action waits out the pass in flight.
  const lock = useRef(createCommandLock());
  // Read through a ref: a caller that passes a fresh runner each render would
  // otherwise restart the polling effect -- and fire a pass -- on every render.
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const pollRunnerRef = useRef(pollRunner ?? runner);
  pollRunnerRef.current = pollRunner ?? runner;

  const poll = useCallback(async () => {
    if (rejection || !spec) return;
    await lock.current.tryRun(async () => {
      try {
        const next: Data = {};
        // Distinct commands only -- several sources often read one command.
        const byCommand = new Map<string, Record<string, unknown> | null>();
        for (const source of spec.sources) {
          if (!byCommand.has(source.command)) {
            // Polled on a timer: quiet, so a panel does not keep the LED flashing.
            const response = await pollRunnerRef.current(quietCommand({ command: source.command }));
            // No answer: the host skipped this pass (an operator command held
            // the device) or it timed out. Keep what is on screen rather than
            // blanking every table; the "Updated" time shows its age.
            if (!response.result) return;
            byCommand.set(source.command, response.result as Record<string, unknown>);
          }
          next[source.id] = extractSource(byCommand.get(source.command) ?? null, source);
        }
        setData(next);
        setHistory((previous) => {
          const updated: Record<string, History> = { ...previous };
          for (const { key, section } of charts) {
            updated[key] = pushChartHistory(
              previous[key] ?? [],
              chartSample(asReadout(section), next[section.source!]),
              chartPoints(asReadout(section)),
            );
          }
          return updated;
        });
        setUpdatedAt(Date.now());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }, [spec, charts, rejection]);

  useEffect(() => {
    if (!live || rejection || !spec) return;
    void poll();
    const handle = window.setInterval(() => void poll(), refreshInterval(spec));
    return () => window.clearInterval(handle);
  }, [live, poll, spec, rejection]);

  const describe = useCallback(
    (raw: string) => {
      const key = panelErrorKey(raw);
      return key ? t(key) : `${t("panelErrorUnknown")}: ${raw}`;
    },
    [t],
  );

  /** Send one confirmed action through the shared lock, then re-poll at once. */
  const execute = useCallback(
    async ({ action, row, input }: Pending) => {
      const args = resolveArgs(action.args, row, input);
      if (!args) {
        setNotice({ text: t("panelArgsMissing"), kind: "error" });
        return;
      }
      setActing(true);
      setNotice(null);
      try {
        // Not quiet: the operator asked for this, so the device acknowledges it.
        const response = await lock.current.run(() => runnerRef.current({ ...args, command: action.command }));
        const result = response.result as Record<string, unknown> | null;
        if (!result) throw new Error("command_delivery_timeout");
        if (result.status === "error" || result.ok === false) {
          throw new Error(String(result.error ?? result.message ?? "command_failed"));
        }
        setNotice({ text: t("panelActionDone").replace("{action}", action.label), kind: "success" });
      } catch (err) {
        setNotice({ text: describe(err instanceof Error ? err.message : String(err)), kind: "error" });
      } finally {
        setActing(false);
      }
      await poll();
    },
    [describe, poll, t],
  );

  /** An action asked for: input first if it takes one, then always a confirmation. */
  const request = useCallback((action: PanelAction, row: Row) => {
    if (action.input) {
      setInputState({ action, row, value: inputDefault(action.input, row), error: null });
    } else {
      setConfirming({ action, row });
    }
  }, []);

  if (rejection || !spec || !model) {
    return <p className="notice error">{t("readoutRejected")}: {rejection}</p>;
  }

  const disabled = busy || acting;

  const renderSections = (sections: PanelSection[], prefix: string) =>
    sections.map((section, index) => {
      const key = `${prefix}${index}`;
      return (
        <div className={`readout-section${section.kind === "tabs" ? " panel-tabs-section" : ""}`} key={`${section.kind}-${key}`}>
          {section.title && section.kind !== "tabs" ? <h4>{section.title}</h4> : null}
          {section.kind === "stats" ? (
            <StatsSection section={section} data={data} />
          ) : section.kind === "chart" ? (
            <ChartSection section={section} history={history[key] ?? []} />
          ) : section.kind === "run" ? (
            <RunSection section={section} data={data} actions={actions} disabled={disabled} onAction={request} />
          ) : section.kind === "tabs" ? (
            renderTabs(section, key)
          ) : (
            <TableSection
              section={section}
              data={data}
              sectionKey={key}
              actions={actions}
              disabled={disabled}
              onAction={request}
            />
          )}
        </div>
      );
    });

  function renderTabs(section: PanelSection, key: string) {
    const tabs = section.tabs ?? [];
    const current = Math.min(activeTab[key] ?? 0, Math.max(tabs.length - 1, 0));
    return (
      <>
        <div className="segmented-control panel-tabs" role="tablist" aria-label={section.title}>
          {tabs.map((tab, tabIndex) => (
            <button
              type="button"
              role="tab"
              key={`${tab.title}-${tabIndex}`}
              aria-selected={tabIndex === current}
              className={tabIndex === current ? "active" : undefined}
              onClick={() => setActiveTab((previous) => ({ ...previous, [key]: tabIndex }))}
            >
              {tab.title}
            </button>
          ))}
        </div>
        <div className="panel-tab-body" role="tabpanel">
          {tabs[current] ? renderSections(tabs[current].sections ?? [], `${key}.${current}.`) : null}
        </div>
      </>
    );
  }

  const confirmTarget = confirming
    ? String(confirming.row.name ?? confirming.row.id ?? "")
    : "";

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
            disabled={disabled}
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
      {notice ? <p className={`notice ${notice.kind}`} role="status">{notice.text}</p> : null}
      {model.kind === "panel" && (spec.actions ?? []).length > actions.size ? (
        <p className="notice warning">{t("panelActionsUnsupported")}</p>
      ) : null}

      {renderSections(spec.sections, "")}

      {inputState ? (
        <InputModal
          state={inputState}
          onChange={(value) => setInputState((current) => (current ? { ...current, value, error: null } : current))}
          onCancel={() => setInputState(null)}
          onSubmit={() => {
            const parsed = parseInput(inputState.action.input!, inputState.value);
            if ("error" in parsed) {
              setInputState({ ...inputState, error: parsed.error });
              return;
            }
            setInputState(null);
            setConfirming({
              action: inputState.action,
              row: inputState.row,
              input: { [inputState.action.input!.field]: parsed.value },
            });
          }}
        />
      ) : null}

      {confirming ? (
        <ConfirmModal
          title={fillMessage(confirming.action.confirm?.title, confirming.row) || confirming.action.label}
          message={
            fillMessage(confirming.action.confirm?.message, { ...confirming.row, ...confirming.input }) ||
            t("panelConfirmDefault")
              .replace("{action}", confirming.action.label)
              .replace("{target}", confirmTarget)
          }
          confirmLabel={confirming.action.label}
          cancelLabel={t("cancel")}
          destructive={Boolean(confirming.action.confirm?.destructive)}
          onConfirm={() => {
            const pending = confirming;
            setConfirming(null);
            void execute(pending);
          }}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </section>
  );
}
