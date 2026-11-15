import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowUpToLine, Pause, Play, RotateCcw, Store, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  type AppEventEntry,
  type AppLoadStats,
  type AppViewState,
  type DeviceApp,
  formatBytes,
  formatCpu,
  runtimeName,
} from "../../lib/deviceApps";
import { CAPABILITIES, DANGEROUS_CAPABILITIES } from "../../sdk/lib/index.mjs";
import { AppGlyph, AppSwitch, LoadBadge, LoadSparkline } from "./AppParts";
import { cardState } from "./RunningAppCard";

/** Capability names in a mask, in the library's order. */
function capabilityNames(mask: number): string[] {
  return Object.entries(CAPABILITIES as Record<string, number>)
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([name]) => name);
}

/** Time since the previous event, from the device's own clock. */
function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `+${Math.round(ms)} ms`;
  if (ms < 60000) return `+${(ms / 1000).toFixed(1)} s`;
  return `+${Math.round(ms / 60000)} min`;
}

/**
 * Everything about one app, as a sheet over the list: what it is and may do,
 * how busy it has been, what it has said lately, and what can be done to it.
 */
export function AppDetailSheet({
  app,
  colour,
  load,
  history,
  view,
  events,
  eventsLoading,
  canReorder,
  isFirst,
  disabled,
  onClose,
  onToggle,
  onPause,
  onResume,
  onRevive,
  onMoveFirst,
  onUninstall,
}: {
  app: DeviceApp;
  colour: number;
  load: AppLoadStats | null;
  history: readonly number[];
  view: AppViewState | null;
  events: AppEventEntry[];
  eventsLoading: boolean;
  canReorder: boolean;
  isFirst: boolean;
  disabled: boolean;
  onClose: () => void;
  onToggle: () => void;
  onPause: () => void;
  onResume: () => void;
  onRevive: () => void;
  onMoveFirst: () => void;
  onUninstall: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const state = app.active ? cardState(app) : null;
  const runtime = app.runtime;
  const name = runtimeName(app);
  const capabilities = capabilityNames(app.capabilities);
  const dangerous = new Set<string>(DANGEROUS_CAPABILITIES as readonly string[]);
  const grantedNames = new Set(capabilityNames(app.granted));
  const contended = (view?.oled.rows ?? []).flatMap((row, index) =>
    row && (row.app === name || row.contended.includes(name)) && row.contended.length
      ? [{ row: index + 1, winner: row.app }]
      : [],
  );

  return (
    <div className="modal-backdrop apps-sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="apps-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apps-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="apps-sheet-head">
          <AppGlyph kind={app.kind} colour={app.active ? colour : undefined} size={22} />
          <div className="apps-sheet-title">
            <h3 id="apps-sheet-title">{app.name}</h3>
            <span>
              v{app.version} · <span className="app-mono">{app.id}</span>
            </span>
          </div>
          <AppSwitch
            checked={app.active}
            disabled={disabled || (!app.active && app.packageState === "needs_update")}
            label={t(app.active ? "appsTurnOff" : "appsTurnOn").replace("{app}", app.name)}
            onChange={() => onToggle()}
          />
          <button type="button" className="button ghost compact icon-button" aria-label={t("readoutClose")} onClick={onClose}>
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        {app.summary ? <p className="apps-sheet-summary">{app.summary}</p> : null}

        {state ? (
          <section className="apps-sheet-group">
            <div className="apps-sheet-status">
              <span className={`apps-status ${state}`}>
                <i aria-hidden="true" />
                {t(`appsState_${state}`)}
              </span>
              {state === "running" && load ? <LoadBadge load={load.load} level={load.level} /> : null}
            </div>
            {state === "running" && load ? (
              <>
                <LoadSparkline points={history} level={load.level} />
                <dl className="apps-sheet-stats">
                  <div><dt>{t("appsCpu1")}</dt><dd>{formatCpu(load.cpu1)}</dd></div>
                  <div><dt>{t("appsCpu10")}</dt><dd>{formatCpu(load.cpu10)}</dd></div>
                  <div><dt>{t("appsCpu60")}</dt><dd>{formatCpu(load.cpu60)}</dd></div>
                  <div><dt>{t("appsShare")}</dt><dd>{load.baseUs} µs</dd></div>
                  {load.borrowedUs > 0 ? (
                    <div><dt>{t("appsBorrowed")}</dt><dd>+{load.borrowedUs} µs</dd></div>
                  ) : null}
                  {load.lentUs > 0 ? <div><dt>{t("appsLent")}</dt><dd>−{load.lentUs} µs</dd></div> : null}
                  {runtime ? (
                    <div><dt>{t("appsPressure")}</dt><dd>{runtime.suspensions} / {runtime.framesSkipped}</dd></div>
                  ) : null}
                  {runtime && runtime.overruns > 0 ? (
                    <div><dt>{t("appOverruns")}</dt><dd>{runtime.overruns}</dd></div>
                  ) : null}
                </dl>
                {load.level === "overloaded" ? <p className="apps-sheet-note warning">{t("appsOverloadedHint")}</p> : null}
              </>
            ) : (
              <p className={`apps-sheet-note ${state}`}>{t(`appsHint_${state}`)}</p>
            )}
            {contended.length ? (
              <p className="apps-sheet-note">
                {contended
                  .map((entry) =>
                    t("appsRowShared").replace("{row}", String(entry.row)).replace("{winner}", entry.winner))
                  .join(" ")}
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="apps-sheet-group">
          <h4>{t("appsAbout")}</h4>
          <dl className="apps-sheet-stats">
            <div><dt>{t("appsMemory")}</dt><dd>{app.memoryBytes ? formatBytes(app.memoryBytes) : "—"}</dd></div>
            <div><dt>{t("appsPackageSize")}</dt><dd>{formatBytes(app.size)}</dd></div>
            <div>
              <dt>{t("appsEstimate")}</dt>
              <dd>{app.estimatedUs ? `~${app.estimatedUs} µs` : t("appsTimeSliced")}</dd>
            </div>
            {app.burst ? <div><dt>{t("appsBurst")}</dt><dd>{t("appsBurstHint")}</dd></div> : null}
          </dl>
          {capabilities.length ? (
            <ul className="apps-caps">
              {capabilities.map((cap) => (
                <li key={cap} className={dangerous.has(cap) ? "dangerous" : undefined}>
                  {cap}
                  {dangerous.has(cap) ? (
                    <small>{grantedNames.has(cap) ? t("appsGranted") : t("appsNotGranted")}</small>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="apps-sheet-actions">
          {state === "killed" ? (
            <button type="button" className="button primary compact" disabled={disabled} onClick={onRevive}>
              <RotateCcw size={14} strokeWidth={2} />
              {t("appRevive")}
            </button>
          ) : null}
          {state === "running" || state === "suspended" ? (
            <button type="button" className="button compact" disabled={disabled} onClick={onPause}>
              <Pause size={14} strokeWidth={2} />
              {t("appsPause")}
            </button>
          ) : null}
          {state === "stopped" ? (
            <button type="button" className="button compact" disabled={disabled} onClick={onResume}>
              <Play size={14} strokeWidth={2} />
              {t("appsResume")}
            </button>
          ) : null}
          {app.active && canReorder && !isFirst ? (
            <button type="button" className="button compact" disabled={disabled} onClick={onMoveFirst}>
              <ArrowUpToLine size={14} strokeWidth={2} />
              {t("appsMoveFirst")}
            </button>
          ) : null}
          <Link className="button compact" to={`/apps/${encodeURIComponent(app.id)}`}>
            <Store size={14} strokeWidth={2} />
            {t("appsInStore")}
          </Link>
          <button type="button" className="button ghost compact app-destructive" disabled={disabled} onClick={onUninstall}>
            <Trash2 size={14} strokeWidth={2} />
            {t("appUninstall")}
          </button>
        </section>

        {app.active ? (
          <section className="apps-sheet-group">
            <h4>{t("appEvents")}</h4>
            <ol className="app-event-list">
              {events.map((event, index) => (
                <li key={event.seq}>
                  <span className="app-event-seq">#{event.seq}</span>
                  <span className="app-event-gap" title={t("appEventGap")}>
                    {index + 1 < events.length ? formatGap(event.ms - events[index + 1].ms) : ""}
                  </span>
                  <span className="app-event-frame" title={t("appEventFrame")}>f{event.frameSeq}</span>
                  <strong className="app-event-name">{event.event}</strong>
                  {event.detail ? <span className={`app-event-detail ${event.detail}`}>{event.detail}</span> : null}
                  {event.value !== undefined ? <em className="app-event-value">{event.value}</em> : null}
                </li>
              ))}
              {!events.length ? (
                <li className="app-empty">{eventsLoading ? t("loading") : t("appEventsEmpty")}</li>
              ) : null}
            </ol>
          </section>
        ) : null}
      </div>
    </div>
  );
}
