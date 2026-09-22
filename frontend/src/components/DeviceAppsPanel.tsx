import { useCallback, useEffect, useMemo, useState } from "react";
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
      <span className="app-budget-label">{percent}%</span>
    </div>
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
  const [dropped, setDropped] = useState(0);
  const [notice, setNotice] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [openReadout, setOpenReadout] = useState<ReadoutPackage | null>(null);
  const [openReadoutId, setOpenReadoutId] = useState<string | null>(null);

  const describeError = useCallback(
    (raw: string) => {
      const key = appErrorKey(raw);
      return key ? t(key) : `${t("appErrorUnknown")}: ${raw}`;
    },
    [t],
  );

  const refresh = useCallback(async () => {
    try {
      const listed = await runner({ command: "app_list" });
      setApps(parseAppList(listed.result));
      if (supportsRegistry) {
        const registry = await runner({ command: "app_list_packages" });
        setPackages(parsePackageList(registry.result));
        const page = await runner({ command: "app_events", since_seq: 0 });
        const parsed = parseAppEvents(page.result);
        setEvents(parsed.events);
        setDropped(parsed.dropped);
      }
    } catch (error) {
      setNotice({ text: describeError(error instanceof Error ? error.message : String(error)),
                  kind: "error" });
    }
  }, [runner, supportsRegistry, describeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (label: string, payload: Record<string, unknown>, success: string) => {
      setPending(label);
      setNotice(null);
      try {
        const response = await runner(payload);
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
    [runner, refresh, describeError],
  );

  const openReadoutPackage = useCallback(
    async (entry: AppPackageEntry) => {
      setPending(entry.id);
      setNotice(null);
      try {
        // Read it from the DEVICE, not the catalog: the device is the source of
        // truth for what it has, and this still works for a sideloaded package
        // or an unreachable library.
        const bytes = await readDeviceFile(runner, { path: `apps/${entry.id}.nha` });
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
    [runner, describeError],
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

  return (
    <section className={`device-apps${compact ? " compact" : ""}`}>
      <header className="device-apps-header">
        <h3>{t("installedApps")}</h3>
        <button type="button" className="button" onClick={() => void refresh()} disabled={disabled}>
          {t("refresh")}
        </button>
      </header>

      {notice ? <p className={`notice ${notice.kind}`}>{notice.text}</p> : null}

      <table className="app-slot-table">
        <thead>
          <tr>
            <th>{t("appSlot")}</th>
            <th>{t("appPackage")}</th>
            <th>{t("appState")}</th>
            <th>{t("appBudget")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {apps.map((app, index) => {
            const bound = packageBySlot.get(index);
            return (
              <tr key={app.name} className={`app-state-${app.state}`}>
                <td className="app-slot-name">{app.name}</td>
                <td>
                  {bound ? (
                    <span title={bound.summary}>{bound.name} <small>v{bound.version}</small></span>
                  ) : (
                    <span className="app-slot-free">{t("appSlotFree")}</span>
                  )}
                </td>
                <td>
                  <span className={`app-state-badge ${app.state}`}>{t(`appState_${app.state}`)}</span>
                  {app.degraded ? (
                    <span className="app-state-badge degraded" title={t("appDegradedHint")}>
                      {t("appDegraded")}
                    </span>
                  ) : null}
                  {app.overruns > 0 ? (
                    <small className="app-overruns">{t("appOverruns")}: {app.overruns}</small>
                  ) : null}
                </td>
                <td><AppBudgetMeter app={app} /></td>
                <td className="app-slot-actions">
                  {needsRevive(app) ? (
                    <button
                      type="button"
                      className="button primary"
                      disabled={disabled}
                      title={t("appKilledHint")}
                      onClick={() => void run(app.name, { command: "app_revive", name: app.name },
                                              t("appRevived"))}
                    >
                      {t("appRevive")}
                    </button>
                  ) : app.state === "running" ? (
                    <button
                      type="button"
                      className="button"
                      disabled={disabled}
                      onClick={() => void run(app.name, { command: "app_disable", name: app.name },
                                              t("appDisabled"))}
                    >
                      {t("appDisable")}
                    </button>
                  ) : app.state === "suspended" ? (
                    <small className="app-suspended-hint">{t("appSuspendedHint")}</small>
                  ) : (
                    <button
                      type="button"
                      className="button"
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
                      className="button"
                      disabled={disabled || !maintenanceMode}
                      title={maintenanceMode ? undefined : t("appRequiresMaintenance")}
                      onClick={() => void run(bound.id,
                                              { command: "app_deactivate", id: bound.id },
                                              t("appDeactivated"))}
                    >
                      {t("appDeactivate")}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
          {!apps.length ? (
            <tr><td colSpan={5} className="app-slot-free">{t("appNoApps")}</td></tr>
          ) : null}
        </tbody>
      </table>

      {supportsRegistry ? (
        <>
          <header className="device-apps-header">
            <h3>{t("installedPackages")}</h3>
            <small>{t("appSlotsUsed", )}: {apps.length - available.length}/{apps.length}</small>
          </header>
          <ul className="app-package-list">
            {flowPackages.map((entry) => (
              <li key={entry.id} className="app-package-row">
                <div>
                  <strong>{entry.name}</strong> <small>v{entry.version}</small>
                  <div className="app-package-summary">{entry.summary}</div>
                  <div className="app-package-meta">
                    <span>{entry.id}</span>
                    <span>{entry.size} B</span>
                    <span>~{entry.estimatedUs} µs</span>
                    <span>{entry.slot >= 0 ? `${t("appSlot")} ${entry.slot}` : t("appNotActivated")}</span>
                    {entry.state === "load_failed" ? (
                      <span className="app-package-failed">{t("appLoadFailed")}</span>
                    ) : null}
                  </div>
                </div>
                <div className="app-package-actions">
                  {entry.slot < 0 && available.length ? (
                    <button
                      type="button"
                      className="button"
                      disabled={disabled || !maintenanceMode}
                      title={maintenanceMode ? undefined : t("appRequiresMaintenance")}
                      onClick={() => void run(entry.id,
                                              { command: "app_activate", id: entry.id, slot: available[0] },
                                              t("appActivated"))}
                    >
                      {t("appActivate")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button"
                    disabled={disabled || !maintenanceMode}
                    title={maintenanceMode ? undefined : t("appRequiresMaintenance")}
                    onClick={() => {
                      if (!window.confirm(t("appUninstallConfirm"))) return;
                      void run(entry.id, { command: "app_uninstall", id: entry.id },
                               t("appUninstalled"));
                    }}
                  >
                    {t("appUninstall")}
                  </button>
                </div>
              </li>
            ))}
            {!flowPackages.length ? <li className="app-slot-free">{t("appNoPackages")}</li> : null}
          </ul>

          <header className="device-apps-header">
            <h3>{t("installedReadouts")}</h3>
            <small>{t("readoutExplainer")}</small>
          </header>
          <ul className="app-package-list">
            {readoutPackages.map((entry) => (
              <li key={entry.id} className="app-package-row">
                <div>
                  <strong>{entry.name}</strong> <small>v{entry.version}</small>
                  <div className="app-package-summary">{entry.summary}</div>
                  <div className="app-package-meta">
                    <span>{entry.id}</span>
                    <span>{entry.size} B</span>
                    <span className="app-readout-badge">{t("appKindReadout")}</span>
                  </div>
                </div>
                <div className="app-package-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={disabled}
                    onClick={() => void openReadoutPackage(entry)}
                  >
                    {openReadoutId === entry.id ? t("readoutReopen") : t("readoutOpen")}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={disabled || !maintenanceMode}
                    title={maintenanceMode ? undefined : t("appRequiresMaintenance")}
                    onClick={() => {
                      if (!window.confirm(t("appUninstallConfirm"))) return;
                      if (openReadoutId === entry.id) {
                        setOpenReadout(null);
                        setOpenReadoutId(null);
                      }
                      void run(entry.id, { command: "app_uninstall", id: entry.id },
                               t("appUninstalled"));
                    }}
                  >
                    {t("appUninstall")}
                  </button>
                </div>
              </li>
            ))}
            {!readoutPackages.length ? (
              <li className="app-slot-free">{t("appNoReadouts")}</li>
            ) : null}
          </ul>

          {openReadout ? (
            <div className="readout-host">
              <header className="device-apps-header">
                <h3>{String((openReadout.manifest as Record<string, unknown>).name ?? openReadoutId)}</h3>
                <button type="button" className="button" onClick={() => {
                  setOpenReadout(null);
                  setOpenReadoutId(null);
                }}>
                  {t("readoutClose")}
                </button>
              </header>
              <ReadoutView pkg={openReadout} runner={runner} busy={disabled} />
            </div>
          ) : null}

          <header className="device-apps-header">
            <h3>{t("appEvents")}</h3>
            {dropped > 0 ? (
              <span className="notice warning app-events-dropped">
                {t("appEventsDropped")}: {dropped}
              </span>
            ) : null}
          </header>
          <ol className="app-event-list">
            {events.map((event) => (
              <li key={event.seq}>
                <span className="app-event-seq">#{event.seq}</span>
                <span className="app-event-frame" title={t("appEventFrame")}>f{event.frameSeq}</span>
                <span className="app-event-app">{event.app}</span>
                <strong>{event.event}</strong>
                <span className="app-event-detail">{event.detail}</span>
                {event.value !== undefined ? <em>{event.value}</em> : null}
              </li>
            ))}
            {!events.length ? <li className="app-slot-free">{t("appEventsEmpty")}</li> : null}
          </ol>
        </>
      ) : (
        <p className="notice warning">{t("appRegistryUnsupported")}</p>
      )}
    </section>
  );
}
