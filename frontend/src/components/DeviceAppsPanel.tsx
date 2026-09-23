import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gauge, RefreshCw, Workflow, X } from "lucide-react";
import { ConfirmModal } from "./ConfirmModal";
import { ReadoutView } from "./ReadoutView";
import { useI18n } from "../i18n";
import {
  type AppEventEntry,
  type AppPackageEntry,
  type InstalledApp,
  appErrorKey,
  budgetPercent,
  freeSlots,
  needsRevive,
  parseAppEvents,
  parseAppList,
  parsePackageList,
} from "../lib/deviceApps";
import { type CommandRunner, readDeviceFile } from "../lib/deviceFileTransfer";
import { type ReadoutPackage, isReadoutPackage } from "../lib/readout";

export type DeviceAppsPanelProps = {
  /**
   * Injected, never obtained from useDeviceCommand inside this component:
   * DeviceSettingsPage runs its own single-flight mutex, and a second pipeline
   * to the same device would race it.
   */
  runner: CommandRunner;
  maintenanceMode: boolean;
  /** Hidden entirely when the firmware predates the registry. */
  supportsRegistry: boolean;
  busy?: boolean;
  compact?: boolean;
};

function AppBudgetMeter({ app }: { app: InstalledApp }) {
  const { t } = useI18n();
  const percent = budgetPercent(app);
  const over = percent > 100;
  return (
    <div className="app-budget-meter" title={`${app.lastUs}µs / ${app.budgetUs}µs`}>
      <div className="app-budget-caption">
        <span>{t("appBudget")}</span>
        <span className={`app-budget-label${over ? " over" : ""}`}>{percent}%</span>
      </div>
      <div className="app-budget-track">
        <div
          className={`app-budget-fill${over ? " over" : ""}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
        {app.maxUs > 0 && app.budgetUs > 0 ? (
          <div
            className="app-budget-peak"
            style={{ left: `${Math.min((app.maxUs / app.budgetUs) * 100, 100)}%` }}
            title={`${t("appMaxCost")}: ${app.maxUs}µs`}
          />
        ) : null}
      </div>
      <div className="app-budget-numbers">
        {app.lastUs} / {app.budgetUs} µs
        {app.maxUs > 0 ? <span> · {t("appMaxCost")} {app.maxUs} µs</span> : null}
      </div>
    </div>
  );
}

/** Time since the previous event, from the device's own clock. */
function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `+${Math.round(ms)} ms`;
  if (ms < 60000) return `+${(ms / 1000).toFixed(1)} s`;
  return `+${Math.round(ms / 60000)} min`;
}

/** A rounded tile standing in for a package icon; the kind decides the glyph. */
function PackageGlyph({ kind }: { kind: string }) {
  const readout = kind === "readout";
  return (
    <span className={`app-glyph${readout ? " readout" : ""}`} aria-hidden="true">
      {readout ? <Gauge size={18} strokeWidth={1.75} /> : <Workflow size={18} strokeWidth={1.75} />}
    </span>
  );
}

export function DeviceAppsPanel({
  runner,
  maintenanceMode,
  supportsRegistry,
  busy = false,
  compact = false,
}: DeviceAppsPanelProps) {
  const { t } = useI18n();
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [packages, setPackages] = useState<AppPackageEntry[]>([]);
  const [events, setEvents] = useState<AppEventEntry[]>([]);
  // Events older than the device's ring holds. A one-shot read cannot "lose"
  // anything, so this is reported as history that rolled off, not as loss.
  const [rolledOff, setRolledOff] = useState(0);
  const [notice, setNotice] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openReadout, setOpenReadout] = useState<ReadoutPackage | null>(null);
  const [openReadoutId, setOpenReadoutId] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<AppPackageEntry | null>(null);

  // Callers may pass a fresh runner each render (DeviceSettingsPage wraps its
  // run() inline). Depending on its identity re-ran refresh() after every
  // command -- each command re-renders the parent -- so the tab cycled
  // app_list / app_list_packages / app_events forever. Read it through a ref.
  const runnerRef = useRef(runner);
  runnerRef.current = runner;

  const describeError = useCallback(
    (raw: string) => {
      const key = appErrorKey(raw);
      return key ? t(key) : `${t("appErrorUnknown")}: ${raw}`;
    },
    [t],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const listed = await runnerRef.current({ command: "app_list" });
      setApps(parseAppList(listed.result));
      if (supportsRegistry) {
        const registry = await runnerRef.current({ command: "app_list_packages" });
        setPackages(parsePackageList(registry.result));
        const page = await runnerRef.current({ command: "app_events", since_seq: 0 });
        const parsed = parseAppEvents(page.result);
        // The device returns oldest first; the newest is what the operator is
        // looking for.
        setEvents([...parsed.events].sort((a, b) => b.seq - a.seq));
        setRolledOff(Math.max(0, parsed.seq - parsed.events.length));
      }
    } catch (error) {
      setNotice({ text: describeError(error instanceof Error ? error.message : String(error)),
                  kind: "error" });
    } finally {
      setLoading(false);
    }
  }, [supportsRegistry, describeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (label: string, payload: Record<string, unknown>, success: string) => {
      setPending(label);
      setNotice(null);
      try {
        const response = await runnerRef.current(payload);
        const result = response.result as Record<string, unknown> | null;
        if (result && (result.status === "error" || result.ok === false)) {
          throw new Error(String(result.error ?? "command_failed"));
        }
        setNotice({ text: success, kind: "success" });
        await refresh();
      } catch (error) {
        setNotice({ text: describeError(error instanceof Error ? error.message : String(error)),
                    kind: "error" });
      } finally {
        setPending(null);
      }
    },
    [refresh, describeError],
  );

  const openReadoutPackage = useCallback(
    async (entry: AppPackageEntry) => {
      setPending(entry.id);
      setNotice(null);
      try {
        // Read it from the DEVICE, not the catalog: the device is the source of
        // truth for what it has, and this still works for a sideloaded package
        // or an unreachable library.
        const bytes = await readDeviceFile(runnerRef.current, { path: `apps/${entry.id}.nha` });
        const doc = JSON.parse(new TextDecoder().decode(bytes));
        if (!isReadoutPackage(doc)) throw new Error("not_a_readout");
        setOpenReadout(doc);
        setOpenReadoutId(entry.id);
      } catch (error) {
        setNotice({ text: describeError(error instanceof Error ? error.message : String(error)),
                    kind: "error" });
      } finally {
        setPending(null);
      }
    },
    [describeError],
  );

  const uninstall = useCallback(
    (entry: AppPackageEntry) => {
      setConfirmUninstall(null);
      if (openReadoutId === entry.id) {
        setOpenReadout(null);
        setOpenReadoutId(null);
      }
      void run(entry.id, { command: "app_uninstall", id: entry.id }, t("appUninstalled"));
    },
    [openReadoutId, run, t],
  );

  const flowPackages = useMemo(() => packages.filter((p) => p.kind !== "readout"), [packages]);
  const readoutPackages = useMemo(() => packages.filter((p) => p.kind === "readout"), [packages]);
  const available = useMemo(() => freeSlots(apps, packages), [apps, packages]);
  const packageBySlot = useMemo(() => {
    const map = new Map<number, AppPackageEntry>();
    packages.forEach((entry) => {
      if (entry.slot >= 0) map.set(entry.slot, entry);
    });
    return map;
  }, [packages]);

  const disabled = busy || pending !== null;
  const maintenanceTitle = maintenanceMode ? undefined : t("appRequiresMaintenance");

  function packageRow(entry: AppPackageEntry) {
    const readout = entry.kind === "readout";
    return (
      <li key={entry.id} className={`app-row${pending === entry.id ? " pending" : ""}`}>
        <PackageGlyph kind={entry.kind} />
        <div className="app-row-body">
          <div className="app-row-title">
            <strong>{entry.name}</strong>
            <span className="app-row-version">v{entry.version}</span>
            {entry.state === "load_failed" ? (
              <span className="app-pill danger">{t("appLoadFailed")}</span>
            ) : null}
          </div>
          {entry.summary ? <div className="app-row-summary">{entry.summary}</div> : null}
          <div className="app-row-meta">
            <span className="app-mono">{entry.id}</span>
            <span>{entry.size} B</span>
            {readout ? (
              <span>{t("appKindReadout")}</span>
            ) : (
              <>
                <span>~{entry.estimatedUs} µs</span>
                <span>{entry.slot >= 0 ? `${t("appSlot")} ${entry.slot}` : t("appNotActivated")}</span>
              </>
            )}
          </div>
        </div>
        <div className="app-row-actions">
          {readout ? (
            <button
              type="button"
              className="button primary compact"
              disabled={disabled}
              onClick={() => void openReadoutPackage(entry)}
            >
              {openReadoutId === entry.id ? t("readoutReopen") : t("readoutOpen")}
            </button>
          ) : entry.slot < 0 && available.length ? (
            <button
              type="button"
              className="button compact"
              disabled={disabled || !maintenanceMode}
              title={maintenanceTitle}
              onClick={() => void run(entry.id,
                                      { command: "app_activate", id: entry.id, slot: available[0] },
                                      t("appActivated"))}
            >
              {t("appActivate")}
            </button>
          ) : null}
          <button
            type="button"
            className="button ghost compact app-destructive"
            disabled={disabled || !maintenanceMode}
            title={maintenanceTitle}
            onClick={() => setConfirmUninstall(entry)}
          >
            {t("appUninstall")}
          </button>
        </div>
      </li>
    );
  }

  return (
    <section className={`device-apps${compact ? " compact" : ""}`}>
      <div className="device-apps-toolbar">
        <div>
          <h3>{t("installedApps")}</h3>
          {apps.length ? (
            <span className="device-apps-count">
              {t("appSlotsUsed")} {apps.length - available.length}/{apps.length}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="button ghost compact icon-button"
          onClick={() => void refresh()}
          disabled={disabled || loading}
          aria-label={t("refresh")}
          title={t("refresh")}
        >
          <RefreshCw size={15} strokeWidth={2} className={loading ? "spinning" : undefined} />
        </button>
      </div>

      {notice ? <p className={`notice ${notice.kind}`}>{notice.text}</p> : null}

      <div className="app-slot-grid">
        {apps.map((app, index) => {
          const bound = packageBySlot.get(index);
          // An empty slot has nothing to run. It may still be *enabled* -- the
          // firmware keeps that so binding a package starts it -- but showing
          // that as "Running" with a Disable button read as a ghost app. The
          // device says whether a graph is loaded; the registry binding alone
          // would miss a legacy apps/flow.json loaded without a package.
          const empty = app.idle;
          return (
            <article key={app.name} className={`app-slot-card state-${app.state}${empty ? " free" : ""}`}>
              <header className="app-slot-head">
                <span className="app-slot-name">{app.name}</span>
                {empty ? null : (
                  <span className={`app-state-pill ${app.state}`}>
                    <i aria-hidden="true" />
                    {t(`appState_${app.state}`)}
                  </span>
                )}
              </header>

              <div className="app-slot-package">
                {bound ? (
                  <>
                    <strong title={bound.summary}>{bound.name}</strong>
                    <span className="app-row-version">v{bound.version}</span>
                  </>
                ) : !empty && app.graph ? (
                  <strong>{app.graph}</strong>
                ) : (
                  <span className="app-slot-free">{t("appSlotFree")}</span>
                )}
              </div>

              {!empty ? <AppBudgetMeter app={app} /> : null}

              {app.degraded || app.overruns > 0 ? (
                <div className="app-slot-flags">
                  {app.degraded ? (
                    <span className="app-pill warning" title={t("appDegradedHint")}>{t("appDegraded")}</span>
                  ) : null}
                  {app.overruns > 0 ? (
                    <span className="app-pill">{t("appOverruns")} {app.overruns}</span>
                  ) : null}
                </div>
              ) : null}

              {needsRevive(app) ? (
                <p className="app-slot-hint danger">{t("appKilledHint")}</p>
              ) : app.state === "suspended" ? (
                <p className="app-slot-hint">{t("appSuspendedHint")}</p>
              ) : null}

              <footer className="app-slot-actions">
                {needsRevive(app) ? (
                  <button
                    type="button"
                    className="button primary compact"
                    disabled={disabled}
                    title={t("appKilledHint")}
                    onClick={() => void run(app.name, { command: "app_revive", name: app.name },
                                            t("appRevived"))}
                  >
                    {t("appRevive")}
                  </button>
                ) : empty ? null : app.state === "running" ? (
                  <button
                    type="button"
                    className="button compact"
                    disabled={disabled}
                    onClick={() => void run(app.name, { command: "app_disable", name: app.name },
                                            t("appDisabled"))}
                  >
                    {t("appDisable")}
                  </button>
                ) : app.state === "suspended" ? null : (
                  <button
                    type="button"
                    className="button compact"
                    disabled={disabled}
                    onClick={() => void run(app.name, { command: "app_enable", name: app.name },
                                            t("appEnabled"))}
                  >
                    {t("appEnable")}
                  </button>
                )}
                {supportsRegistry && bound ? (
                  <button
                    type="button"
                    className="button ghost compact"
                    disabled={disabled || !maintenanceMode}
                    title={maintenanceTitle}
                    onClick={() => void run(bound.id,
                                            { command: "app_deactivate", id: bound.id },
                                            t("appDeactivated"))}
                  >
                    {t("appDeactivate")}
                  </button>
                ) : null}
              </footer>
            </article>
          );
        })}
        {!apps.length ? (
          <p className="app-empty">{loading ? t("loading") : t("appNoApps")}</p>
        ) : null}
      </div>

      {supportsRegistry ? (
        <>
          <div className="app-group">
            <div className="app-group-header">
              <h4>{t("installedPackages")}</h4>
              {!maintenanceMode ? <span>{t("appRequiresMaintenance")}</span> : null}
            </div>
            <ul className="app-group-list">
              {flowPackages.map(packageRow)}
              {!flowPackages.length ? <li className="app-empty">{t("appNoPackages")}</li> : null}
            </ul>
          </div>

          <div className="app-group">
            <div className="app-group-header">
              <h4>{t("installedReadouts")}</h4>
              <span>{t("readoutExplainer")}</span>
            </div>
            <ul className="app-group-list">
              {readoutPackages.map(packageRow)}
              {!readoutPackages.length ? <li className="app-empty">{t("appNoReadouts")}</li> : null}
            </ul>
          </div>

          {openReadout ? (
            <div className="readout-host">
              <header className="readout-host-header">
                <PackageGlyph kind="readout" />
                <h4>{String((openReadout.manifest as Record<string, unknown>).name ?? openReadoutId)}</h4>
                <button
                  type="button"
                  className="button ghost compact icon-button"
                  aria-label={t("readoutClose")}
                  title={t("readoutClose")}
                  onClick={() => {
                    setOpenReadout(null);
                    setOpenReadoutId(null);
                  }}
                >
                  <X size={16} strokeWidth={2} />
                </button>
              </header>
              <ReadoutView pkg={openReadout} runner={runner} busy={disabled} />
            </div>
          ) : null}

          <div className="app-group">
            <div className="app-group-header">
              <h4>{t("appEvents")}</h4>
              {events.length ? <span>{events.length}</span> : null}
            </div>
            {rolledOff > 0 ? (
              <p className="app-events-note">
                {t("appEventsRolledOff").replace("{shown}", String(events.length))
                                        .replace("{older}", String(rolledOff))}
              </p>
            ) : null}
            <ol className="app-event-list">
              {events.map((event, index) => (
                <li key={event.seq}>
                  <span className="app-event-seq">#{event.seq}</span>
                  <span className="app-event-gap" title={t("appEventGap")}>
                    {index + 1 < events.length ? formatGap(event.ms - events[index + 1].ms) : ""}
                  </span>
                  <span className="app-event-frame" title={t("appEventFrame")}>f{event.frameSeq}</span>
                  <span className="app-event-app">{event.app}</span>
                  <strong className="app-event-name">{event.event}</strong>
                  {event.detail ? (
                    <span className={`app-event-detail ${event.detail}`}>{event.detail}</span>
                  ) : null}
                  {event.value !== undefined ? <em className="app-event-value">{event.value}</em> : null}
                </li>
              ))}
              {!events.length ? <li className="app-empty">{t("appEventsEmpty")}</li> : null}
            </ol>
          </div>
        </>
      ) : (
        <p className="notice warning">{t("appRegistryUnsupported")}</p>
      )}

      {confirmUninstall ? (
        <ConfirmModal
          title={`${t("appUninstall")} ${confirmUninstall.name}`}
          message={t("appUninstallConfirm")}
          confirmLabel={t("appUninstall")}
          cancelLabel={t("cancel")}
          onConfirm={() => uninstall(confirmUninstall)}
          onCancel={() => setConfirmUninstall(null)}
        />
      ) : null}
    </section>
  );
}
