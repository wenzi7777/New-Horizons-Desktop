import { useI18n } from "../../i18n";
import {
  type AppLoadStats,
  type AppViewState,
  type DeviceApp,
  formatBytes,
  formatCpu,
  runtimeName,
} from "../../lib/deviceApps";
import { LedDot, OledPanel } from "../sdk/IndicatorViews";
import { AppGlyph, AppSwitch, LoadBadge, LoadSparkline } from "./AppParts";

/** What the card's status dot says. An idle "running" app has nothing to run. */
export function cardState(app: DeviceApp): "running" | "stopped" | "suspended" | "killed" | "faulted" {
  const runtime = app.runtime;
  if (!runtime) return "faulted";
  if (runtime.state === "running") return runtime.idle ? "faulted" : "running";
  if (runtime.state === "stopped" || runtime.state === "installed") return "stopped";
  if (runtime.state === "suspended") return "suspended";
  if (runtime.state === "killed") return "killed";
  return "faulted";
}

/**
 * One running app, the way a phone's app switcher shows it: what it is
 * drawing right now, how busy it is, and a switch that ends it.
 */
export function RunningAppCard({
  app,
  colour,
  view,
  load,
  history,
  disabled,
  pending,
  onToggle,
  onOpen,
}: {
  app: DeviceApp;
  colour: number;
  view: AppViewState | null;
  /** Live from app_view when there is one, else from the last app_list. */
  load: AppLoadStats | null;
  history: readonly number[];
  disabled: boolean;
  pending: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const state = cardState(app);
  const name = runtimeName(app);
  const rows = (view?.oled.rows ?? []).map((row) => (row && row.app === name ? row : null));
  const drawsOled = rows.some(Boolean);
  const ledRequest = view?.statusLed.request && view.statusLed.request.app === name ? view.statusLed.request : null;
  const level = state === "running" ? load?.level ?? "low" : "low";

  return (
    <article
      className={`apps-card state-${state}${pending ? " pending" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <header className="apps-card-head">
        <AppGlyph kind={app.kind} colour={colour} />
        <div className="apps-card-title">
          <strong>{app.name}</strong>
          <span className={`apps-status ${state}`}>
            <i aria-hidden="true" />
            {t(`appsState_${state}`)}
            {app.runtime && app.runtime.load && app.runtime.load.borrowedUs > 0 && state === "running" ? (
              <em className="apps-borrowing">{t("appsBorrowing")}</em>
            ) : null}
          </span>
        </div>
        <AppSwitch
          checked
          disabled={disabled}
          pending={pending}
          label={t("appsTurnOff").replace("{app}", app.name)}
          onChange={() => onToggle()}
        />
      </header>

      <div className={`apps-card-preview${drawsOled || ledRequest ? "" : " empty"}`}>
        {drawsOled ? <OledPanel rows={rows} /> : null}
        {ledRequest ? (
          <div className="apps-card-led">
            <LedDot rgb={ledRequest.rgb} />
            {ledRequest.suppressed ? <small>{t("appsLedHeld")}</small> : null}
          </div>
        ) : null}
        {!drawsOled && !ledRequest ? <span>{t("appsNoOutput")}</span> : null}
      </div>

      {state === "running" && load ? (
        <div className="apps-card-load">
          <LoadBadge load={load.load} level={load.level} />
          <LoadSparkline points={history} level={level} />
        </div>
      ) : (
        <p className={`apps-card-hint ${state}`}>{t(`appsHint_${state}`)}</p>
      )}

      <footer className="apps-card-meta">
        <span>{formatBytes(app.memoryBytes)}</span>
        {state === "running" && load ? <span>CPU {formatCpu(load.cpu10)}</span> : null}
        {app.burst ? <span className="apps-chip">{t("appsBurst")}</span> : null}
        {app.runtime?.degraded ? (
          <span className="app-pill danger" title={t("appDegradedHint")}>{t("appDegraded")}</span>
        ) : null}
      </footer>
    </article>
  );
}
