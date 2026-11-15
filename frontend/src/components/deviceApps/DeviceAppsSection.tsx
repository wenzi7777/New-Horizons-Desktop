import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Store, X } from "lucide-react";
import { ConfirmModal } from "../ConfirmModal";
import { PanelPermissionList, PanelView } from "../PanelView";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { type AppCatalogEntry, useLocalised } from "../../lib/appLibrary";
import { withMaintenance } from "../../lib/deviceCommand";
import {
  type AppEventEntry,
  type AppLoadStats,
  type AppPackageEntry,
  type AppResources,
  type AppViewState,
  type DeviceApp,
  type InstalledApp,
  appErrorKey,
  isUnknownCommand,
  mergeDeviceApps,
  parseAppEvents,
  parseAppList,
  parseAppResources,
  parseAppView,
  parsePackageList,
  runtimeName,
} from "../../lib/deviceApps";
import { type CommandRunner, readDeviceFile } from "../../lib/deviceFileTransfer";
import { isViewablePackage, panelModel } from "../../lib/panel";
import { AppDetailSheet } from "./AppDetailSheet";
import { AppGlyph, isViewKind } from "./AppParts";
import { AppResourceBar } from "./AppResourceBar";
import { InstalledAppRow } from "./InstalledAppRow";
import { RunningAppCard } from "./RunningAppCard";
import { CAPABILITIES } from "../../sdk/lib/index.mjs";

/** The fastest the live view asks; a slow link (ESP-NOW via a Hub) slows it further. */
const MIN_POLL_MS = 1000;
const POLL_TIMEOUT_MS = 4000;
/** One point per poll: about a minute of history at the fastest rate. */
const HISTORY_POINTS = 60;
const COLOURS = 6;
/** AppGovernor::kDefaultCeilingPermille, until the device says otherwise. */
const DEFAULT_CEILING_PERMILLE = 250;

export type DeviceAppsSectionProps = {
  /**
   * Injected, never obtained from useDeviceCommand inside this component:
   * DeviceSettingsPage runs its own single-flight mutex, and a second
   * pipeline to the same device would race it.
   */
  runner: CommandRunner;
  /**
   * Background runner for the live view's app_view polls: it must skip, not
   * queue, while an operator's command holds the device, and stay out of the
   * busy state and the operation log.
   */
  poll?: CommandRunner;
  inMaintenance: boolean;
  /** The firmware has a package registry (v1.1.0+). */
  supportsRegistry: boolean;
  /** The device is recording: switching an app pauses the scan for ~1 s. */
  recording?: boolean;
  deviceUid?: string;
  busy?: boolean;
};

type Confirm =
  | { kind: "toggle"; app: DeviceApp }
  | { kind: "uninstall"; app: DeviceApp };

/**
 * The device's apps, the way a phone shows what is running: a resource
 * summary, a card per running app with what it draws and how busy it is, and
 * every other installed app as a row with a switch. Maintenance mode, which
 * the device needs for starting and stopping apps, is entered and left
 * automatically around the change.
 */
export function DeviceAppsSection({
  runner,
  poll,
  inMaintenance,
  supportsRegistry,
  recording = false,
  deviceUid,
  busy = false,
}: DeviceAppsSectionProps) {
  const { t } = useI18n();
  const localise = useLocalised();
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [packages, setPackages] = useState<AppPackageEntry[]>([]);
  const [resources, setResources] = useState<AppResources | null>(null);
  const [ceilingPermille, setCeilingPermille] = useState(DEFAULT_CEILING_PERMILLE);
  const [view, setView] = useState<AppViewState | null>(null);
  const [history, setHistory] = useState<Map<string, number[]>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [events, setEvents] = useState<AppEventEntry[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [openPanel, setOpenPanel] = useState<{ id: string; doc: unknown } | null>(null);
  const [catalog, setCatalog] = useState<Map<string, AppCatalogEntry>>(() => new Map());
  const [deviceCommands, setDeviceCommands] = useState<Set<string> | null>(null);

  // Callers may pass a fresh runner each render; read them through refs so the
  // loops are not torn down (and app_list re-run) by every parent render.
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const pollRef = useRef(poll);
  pollRef.current = poll;

  // The catalog's localised name and summary, by package id. A package's own
  // manifest carries one English string; the catalog has every locale.
  useEffect(() => {
    let cancelled = false;
    api
      .appLibraryIndex()
      .then((index) => {
        if (!cancelled) setCatalog(new Map((index.items || []).map((item) => [item.id, item])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The device's command names (firmware v1.15.0+), for panels: an action
  // whose command the device does not have is hidden rather than offered.
  useEffect(() => {
    if (!deviceUid) return;
    let cancelled = false;
    api
      .deviceCommands(deviceUid)
      .then((response) => {
        if (cancelled || !response.catalog) return;
        setDeviceCommands(new Set(response.catalog.commands.map((spec) => String(spec.name))));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [deviceUid]);

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
      const governor = (listed.result?.data as Record<string, unknown> | undefined)?.governor as
        | Record<string, unknown>
        | undefined;
      if (governor && Number(governor.ceiling_permille) > 0) setCeilingPermille(Number(governor.ceiling_permille));
      if (supportsRegistry) {
        const registry = await runnerRef.current({ command: "app_list_packages" });
        setPackages(parsePackageList(registry.result));
        setResources(parseAppResources(registry.result));
      }
    } catch (error) {
      setNotice({ text: describeError(error instanceof Error ? error.message : String(error)), kind: "error" });
    } finally {
      setLoading(false);
    }
  }, [supportsRegistry, describeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const merged = useMemo(() => {
    const list = mergeDeviceApps(apps, packages);
    return list.map((app) => {
      const known = catalog.get(app.id);
      return known
        ? { ...app, name: localise(known.name) || app.name, summary: localise(known.summary) || app.summary }
        : app;
    });
  }, [apps, packages, catalog, localise]);
  const running = useMemo(() => merged.filter((app) => app.active && !isViewKind(app.kind)), [merged]);
  // Running apps that may drive the external strip: the device reports one
  // merged strip, so a card says "shared" when more than one could have lit it.
  const stripDrivers = useMemo(() => {
    const bit = (CAPABILITIES as Record<string, number>).drive_ext_led ?? 0;
    return running.filter((app) => app.runtime?.state === "running" && (app.capabilities & bit) !== 0).length;
  }, [running]);
  const installed = useMemo(() => merged.filter((app) => !app.active && !isViewKind(app.kind)), [merged]);
  const views = useMemo(() => merged.filter((app) => isViewKind(app.kind)), [merged]);
  const colourOf = useCallback(
    (id: string) => {
      const index = running.findIndex((app) => app.id === id);
      return (index < 0 ? 0 : index) % COLOURS;
    },
    [running],
  );

  // --- the live view: app_view every second or so, while something runs ---
  const pausedRef = useRef(false);
  pausedRef.current = busy || pending !== null || loading;
  const anyActive = running.length > 0;
  const [liveUnsupported, setLiveUnsupported] = useState(false);
  useEffect(() => {
    if (!anyActive || liveUnsupported || !pollRef.current) return undefined;
    let cancelled = false;
    let timer = 0;
    let intervalMs = MIN_POLL_MS;
    const tick = async () => {
      if (cancelled) return;
      const pollNow = pollRef.current;
      if (pollNow && !pausedRef.current && document.visibilityState === "visible") {
        const started = performance.now();
        try {
          const response = await pollNow({ command: "app_view" }, POLL_TIMEOUT_MS);
          const result = response.result;
          if (!cancelled && result) {
            if (isUnknownCommand(result)) {
              setLiveUnsupported(true);
            } else if (result.status !== "error" && result.ok !== false) {
              const parsed = parseAppView(result);
              setView(parsed);
              if (parsed.load) {
                setHistory((previous) => {
                  const next = new Map(previous);
                  for (const entry of parsed.load?.apps ?? []) {
                    const points = [...(next.get(entry.name) ?? []), entry.load];
                    next.set(entry.name, points.slice(-HISTORY_POINTS));
                  }
                  return next;
                });
              }
            }
            // Twice the round trip, so the view never takes more than half the
            // link: a UDP device answers in tens of ms, a Hub hop in hundreds.
            intervalMs = Math.max(MIN_POLL_MS, Math.round((performance.now() - started) * 2));
          }
        } catch {
          // Retried on the next tick.
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [anyActive, liveUnsupported]);

  // A state the live view reports that the last app_list did not (an app was
  // killed, or the governor suspended everything): fetch the list again.
  const liveStates = (view?.load?.apps ?? []).map((entry) => `${entry.name}:${entry.state}`).join(",");
  const listedStates = running
    .map((app) => `${runtimeName(app)}:${app.runtime?.idle && app.runtime.state === "running" ? "faulted" : app.runtime?.state ?? ""}`)
    .join(",");
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!liveStates || pausedRef.current) return;
    const live = new Map(liveStates.split(",").map((pair) => pair.split(":") as [string, string]));
    const differs = listedStates
      .split(",")
      .filter(Boolean)
      .some((pair) => {
        const [name, state] = pair.split(":");
        return live.has(name) && live.get(name) !== state;
      });
    if (differs) void refreshRef.current();
  }, [liveStates, listedStates]);

  const loadOf = useCallback(
    (app: DeviceApp): AppLoadStats | null => {
      const live = view?.load?.apps.find((entry) => entry.name === runtimeName(app));
      return live ?? app.runtime?.load ?? null;
    },
    [view],
  );
  const cpuByApp = useMemo(() => {
    const map = new Map<string, number>();
    for (const app of running) map.set(app.id, loadOf(app)?.cpu10 ?? 0);
    return map;
  }, [running, loadOf]);

  // --- actions ---
  const perform = useCallback(
    async (id: string, success: string, work: () => Promise<void>) => {
      setPending(id);
      setNotice(null);
      try {
        await work();
        setNotice({ text: success, kind: "success" });
      } catch (error) {
        setNotice({ text: describeError(error instanceof Error ? error.message : String(error)), kind: "error" });
      } finally {
        setPending(null);
        await refresh();
      }
    },
    [describeError, refresh],
  );

  const send = useCallback(async (payload: Record<string, unknown>) => {
    const response = await runnerRef.current(payload);
    const result = response.result as Record<string, unknown> | null;
    if (!result) throw new Error("command_delivery_timeout");
    if (result.status === "error" || result.ok === false) throw new Error(String(result.error ?? "command_failed"));
  }, []);

  const maintained = useCallback(
    (id: string, success: string, payload: Record<string, unknown>) =>
      perform(id, success, () =>
        withMaintenance(runnerRef.current, inMaintenance, "apps", () => send(payload))),
    [perform, send, inMaintenance],
  );

  const toggle = useCallback(
    (app: DeviceApp) => {
      setConfirm(null);
      void maintained(
        app.id,
        app.active ? t("appsTurnedOff") : t("appsTurnedOn"),
        { command: app.active ? "app_deactivate" : "app_activate", id: app.id },
      );
    },
    [maintained, t],
  );

  const requestToggle = useCallback(
    (app: DeviceApp) => {
      // Switching an app pauses the scan for about a second; while the
      // device records, that is a gap in the data, so it is asked first.
      if (recording && !inMaintenance) setConfirm({ kind: "toggle", app });
      else toggle(app);
    },
    [recording, inMaintenance, toggle],
  );

  const uninstall = useCallback(
    (app: DeviceApp) => {
      setConfirm(null);
      setSheetId(null);
      if (openPanel?.id === app.id) setOpenPanel(null);
      void maintained(app.id, t("appUninstalled"), { command: "app_uninstall", id: app.id });
    },
    [maintained, openPanel, t],
  );

  const openView = useCallback(
    async (app: DeviceApp) => {
      setPending(app.id);
      setNotice(null);
      try {
        // Read from the DEVICE, not the catalog: the device is the source of
        // truth for what it has, sideloaded packages included.
        const bytes = await readDeviceFile(runnerRef.current, { path: `apps/${app.id}.nha` });
        const doc = JSON.parse(new TextDecoder().decode(bytes));
        if (!isViewablePackage(doc)) throw new Error("not_a_panel");
        setOpenPanel({ id: app.id, doc });
      } catch (error) {
        setNotice({ text: describeError(error instanceof Error ? error.message : String(error)), kind: "error" });
      } finally {
        setPending(null);
      }
    },
    [describeError],
  );

  const sheetApp = sheetId ? merged.find((app) => app.id === sheetId) ?? null : null;
  const sheetName = sheetApp ? runtimeName(sheetApp) : "";
  const sheetActive = Boolean(sheetApp?.active);
  useEffect(() => {
    if (!sheetName || !sheetActive || !supportsRegistry) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    setEventsLoading(true);
    runnerRef.current({ command: "app_events", since_seq: 0 })
      .then((page) => {
        if (cancelled) return;
        const parsed = parseAppEvents(page.result);
        setEvents(parsed.events.filter((event) => event.app === sheetName).sort((a, b) => b.seq - a.seq));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sheetName, sheetActive, supportsRegistry]);

  const disabled = busy || pending !== null;
  const panelModelOpen = useMemo(() => panelModel(openPanel?.doc ?? null), [openPanel]);

  if (!supportsRegistry) {
    return <p className="notice warning">{t("appRegistryUnsupported")}</p>;
  }

  return (
    <section className="apps-section">
      <div className="apps-toolbar">
        <p className="apps-toolbar-note">{t("appsScanPauseNote")}</p>
        <div className="actions compact">
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
          <Link className="button compact" to="/apps">
            <Store size={15} strokeWidth={2} />
            {t("appsGetMore")}
          </Link>
        </div>
      </div>

      {notice ? <p className={`notice ${notice.kind}`}>{notice.text}</p> : null}

      <AppResourceBar
        running={running}
        resources={resources}
        cpuByApp={cpuByApp}
        ceilingPermille={ceilingPermille}
        colourOf={colourOf}
      />

      <div className="apps-group">
        <h4 className="apps-group-title">
          {t("appsRunning")}
          {running.length ? <span>{running.length}</span> : null}
        </h4>
        {running.length ? (
          <div className="apps-cards">
            {running.map((app) => (
              <RunningAppCard
                key={app.id}
                app={app}
                colour={colourOf(app.id)}
                view={view}
                load={loadOf(app)}
                history={history.get(runtimeName(app)) ?? []}
                stripShared={stripDrivers > 1}
                disabled={disabled}
                pending={pending === app.id}
                onToggle={() => requestToggle(app)}
                onOpen={() => setSheetId(app.id)}
              />
            ))}
          </div>
        ) : (
          <p className="apps-empty">{loading ? t("loading") : t("appsNoneRunning")}</p>
        )}
        {liveUnsupported ? <p className="apps-footnote">{t("appLiveUnsupported")}</p> : null}
      </div>

      <div className="apps-group">
        <h4 className="apps-group-title">
          {t("appsInstalled")}
          {installed.length ? <span>{installed.length}</span> : null}
        </h4>
        <ul className="apps-list">
          {installed.map((app) => (
            <InstalledAppRow
              key={app.id}
              app={app}
              resources={resources}
              disabled={disabled}
              pending={pending === app.id}
              onToggle={() => requestToggle(app)}
              onOpen={() => setSheetId(app.id)}
            />
          ))}
          {!installed.length ? (
            <li className="apps-empty">{running.length ? t("appsAllRunning") : t("appNoPackages")}</li>
          ) : null}
        </ul>
      </div>

      {views.length ? (
        <div className="apps-group">
          <h4 className="apps-group-title">
            {t("installedReadouts")}
            <small>{t("readoutExplainer")}</small>
          </h4>
          <ul className="apps-list">
            {views.map((app) => (
              <InstalledAppRow
                key={app.id}
                app={app}
                resources={resources}
                disabled={disabled}
                pending={pending === app.id}
                onToggle={() => undefined}
                onOpen={() => void openView(app)}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {openPanel ? (
        <div className="readout-host">
          <header className="readout-host-header">
            <AppGlyph kind={panelModelOpen?.kind ?? "readout"} />
            <h4>{merged.find((app) => app.id === openPanel.id)?.name ?? openPanel.id}</h4>
            <button
              type="button"
              className="button ghost compact icon-button"
              aria-label={t("readoutClose")}
              title={t("readoutClose")}
              onClick={() => setOpenPanel(null)}
            >
              <X size={16} strokeWidth={2} />
            </button>
          </header>
          {/* What this panel may do to the device, every time it is opened. */}
          <PanelPermissionList permissions={panelModelOpen?.permissions ?? []} />
          <PanelView pkg={openPanel.doc} runner={runner} poll={poll} busy={disabled} supportedCommands={deviceCommands} />
        </div>
      ) : null}

      {sheetApp && !isViewKind(sheetApp.kind) ? (
        <AppDetailSheet
          app={sheetApp}
          colour={colourOf(sheetApp.id)}
          load={loadOf(sheetApp)}
          history={history.get(runtimeName(sheetApp)) ?? []}
          view={view}
          events={events}
          eventsLoading={eventsLoading}
          canReorder={resources !== null && running.length > 1}
          isFirst={running[0]?.id === sheetApp.id}
          disabled={disabled}
          onClose={() => setSheetId(null)}
          onToggle={() => requestToggle(sheetApp)}
          onPause={() =>
            void perform(sheetApp.id, t("appsPaused"), () =>
              send({ command: "app_stop", name: runtimeName(sheetApp) }))}
          onResume={() =>
            void perform(sheetApp.id, t("appsResumed"), () =>
              send({ command: "app_start", name: runtimeName(sheetApp) }))}
          onRevive={() =>
            void perform(sheetApp.id, t("appRevived"), () =>
              send({ command: "app_revive", name: runtimeName(sheetApp) }))}
          onMoveFirst={() =>
            void perform(sheetApp.id, t("appsMovedFirst"), () =>
              send({ command: "app_reorder", id: sheetApp.id, to: 0 }))}
          onUninstall={() => setConfirm({ kind: "uninstall", app: sheetApp })}
        />
      ) : null}

      {confirm?.kind === "uninstall" ? (
        <ConfirmModal
          title={`${t("appUninstall")} ${confirm.app.name}`}
          message={t("appUninstallConfirm")}
          confirmLabel={t("appUninstall")}
          cancelLabel={t("cancel")}
          onConfirm={() => uninstall(confirm.app)}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm?.kind === "toggle" ? (
        <ConfirmModal
          title={t(confirm.app.active ? "appsTurnOff" : "appsTurnOn").replace("{app}", confirm.app.name)}
          message={t("appsRecordingConfirm")}
          confirmLabel={t(confirm.app.active ? "appsTurnOffShort" : "appsTurnOnShort")}
          cancelLabel={t("cancel")}
          onConfirm={() => toggle(confirm.app)}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </section>
  );
}
